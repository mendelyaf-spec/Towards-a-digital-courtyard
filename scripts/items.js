// items.js — everything that lives on the canvas.
//
// Every item is the same kind of citizen: a shape, a cut-out photo, or a
// text note. Any item can be drawn on, can have text, and can hold attached
// notes that reveal/hide when you tap it — and those notes are themselves
// full items, so the nesting goes as deep as you like.

import { items, save, addItem, removeItem, newId } from "./store.js";

const MIN_SIZE = 24;
const TAP_SLOP = 5; // px of movement still counts as a tap, not a drag

export class ItemLayer {
  constructor(worldEl, viewport) {
    this.world = worldEl;
    this.vp = viewport;
    this.nodes = new Map(); // id -> element
    this.selected = null;
    this.drawMode = false;
    this.color = "#b04b4b";
    this.onSelect = null; // hook: notified with the newly selected id (or null)

    this.bar = document.getElementById("itemBar");
    this._wireBar();

    viewport.vp.addEventListener("pointerdown", (e) => {
      if (e.target === viewport.vp) this.select(null);
    });

    for (const it of items) this._render(it);
    this._applyVisibility();
  }

  // ---------- tree helpers (recursive grouping) ----------
  _children(id) {
    return items.filter((it) => it.parentId === id);
  }
  _descendants(id) {
    const out = [];
    const walk = (pid) => {
      for (const c of this._children(pid)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }
  _get(id) {
    return items.find((it) => it.id === id);
  }
  _visible(item) {
    // Visible only if every ancestor up the chain is expanded.
    let p = item.parentId;
    while (p) {
      const parent = this._get(p);
      if (!parent || !parent.expanded) return false;
      p = parent.parentId;
    }
    return true;
  }

  // ---------- creating ----------
  add(type, { src, w, h, text, parentId, near } = {}) {
    let x, y;
    if (near) {
      x = near.x;
      y = near.y;
    } else {
      const c = this.vp.centerWorld();
      w = w || 160;
      h = h || 160;
      x = Math.round(c.x - (w || 160) / 2);
      y = Math.round(c.y - (h || 160) / 2);
    }
    if (type === "text") {
      w = w || 200;
      h = h || 60;
    }
    const item = addItem({
      id: newId(),
      type,
      x: Math.round(x),
      y: Math.round(y),
      w: w || 160,
      h: h || 160,
      ...(src ? { src } : {}),
      ...(type === "text" ? { text: text ?? "", color: this.color } : {}),
      ...(parentId ? { parentId } : {}),
    });
    const el = this._render(item);
    this._applyVisibility();
    this.select(item.id);
    if (type === "text") this._editText(item, el);
    return item;
  }

  // ---------- rendering ----------
  _render(item) {
    const el = document.createElement("div");
    el.className = `item item--${item.type}`;
    el.dataset.id = item.id;
    this._layout(el, item);

    if (item.type === "image") {
      const img = document.createElement("img");
      img.src = item.src;
      img.alt = "";
      el.appendChild(img);
    }
    if (item.type === "text") {
      const t = document.createElement("div");
      t.className = "text-body";
      t.textContent = item.text || "";
      t.style.color = item.color || this.color;
      el.appendChild(t);
    }

    // Ink overlay (freehand drawing). Stretches with the item.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ink");
    svg.setAttribute("viewBox", "0 0 1000 1000");
    svg.setAttribute("preserveAspectRatio", "none");
    el.appendChild(svg);
    this._renderStrokes(item, svg);

    // Badge showing attached-note count + expand state.
    const badge = document.createElement("div");
    badge.className = "badge";
    el.appendChild(badge);

    const del = document.createElement("button");
    del.className = "delete";
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", "Delete");
    el.appendChild(del);

    const handle = document.createElement("div");
    handle.className = "handle";
    el.appendChild(handle);

    this._wire(el, item, { svg, handle, del, badge });
    this.world.appendChild(el);
    this.nodes.set(item.id, el);
    this._updateBadge(item);
    return el;
  }

  _layout(el, item) {
    el.style.left = item.x + "px";
    el.style.top = item.y + "px";
    el.style.width = item.w + "px";
    el.style.height = item.h + "px";
  }

  _renderStrokes(item, svg) {
    svg.innerHTML = "";
    for (const s of item.strokes || []) svg.appendChild(strokePath(s));
  }

  _updateBadge(item) {
    const el = this.nodes.get(item.id);
    if (!el) return;
    const badge = el.querySelector(".badge");
    const n = this._children(item.id).length;
    if (n === 0) {
      badge.style.display = "none";
      el.classList.remove("has-notes");
    } else {
      badge.style.display = "";
      badge.textContent = (item.expanded ? "▾ " : "▸ ") + n;
      el.classList.add("has-notes");
    }
  }

  // ---------- visibility (collapse/expand) ----------
  _applyVisibility() {
    for (const it of items) {
      const el = this.nodes.get(it.id);
      if (!el) continue;
      el.classList.toggle("is-hidden", !this._visible(it));
    }
    if (this.selected && !this._visible(this._get(this.selected))) {
      this.select(null);
    }
  }

  toggleExpand(item) {
    item.expanded = !item.expanded;
    this._updateBadge(item);
    this._applyVisibility();
    save();
  }

  // ---------- selection + contextual bar ----------
  select(id) {
    if (id === this.selected) return; // re-affirming keeps draw mode intact
    if (this.selected) this.nodes.get(this.selected)?.classList.remove("is-selected");
    this.drawMode = false; // only reset when switching to a different item
    this.selected = id;
    if (id) {
      const el = this.nodes.get(id);
      el?.classList.add("is-selected");
      this.world.appendChild(el); // bring to front
      this._showBar();
    } else {
      this._hideBar();
    }
    this._reflectDrawState();
    this.onSelect?.(id);
  }

  _showBar() {
    this.bar.hidden = false;
    const item = this._get(this.selected);
    this.bar.querySelector("#inkColor").value = item?.color || this.color;
    this.positionBar();
  }
  _hideBar() {
    this.bar.hidden = true;
  }
  positionBar() {
    if (this.bar.hidden || !this.selected) return;
    const item = this._get(this.selected);
    if (!item) return;
    const s = this.vp.scale;
    const sx = this.vp.x + (item.x + item.w / 2) * s;
    const sy = this.vp.y + item.y * s;
    this.bar.style.left = sx + "px";
    this.bar.style.top = sy - this.bar.offsetHeight - 12 + "px";
  }

  _wireBar() {
    this.bar.querySelector("#inkColor").addEventListener("input", (e) =>
      this.setColor(e.target.value)
    );
    this.bar.querySelector('[data-act="draw"]').addEventListener("click", () => {
      this.drawMode = !this.drawMode;
      this._reflectDrawState();
    });
    this.bar.querySelector('[data-act="note"]').addEventListener("click", () =>
      this.attachNote()
    );
  }

  _reflectDrawState() {
    this.bar.querySelector('[data-act="draw"]').classList.toggle("is-on", this.drawMode);
    if (this.selected) {
      this.nodes.get(this.selected)?.classList.toggle("is-drawing", this.drawMode);
    }
  }

  setColor(c) {
    this.color = c;
    const item = this._get(this.selected);
    if (item?.type === "text") {
      item.color = c;
      this.nodes.get(item.id).querySelector(".text-body").style.color = c;
      save();
    }
  }

  attachNote() {
    const parent = this._get(this.selected);
    if (!parent) return;
    parent.expanded = true;
    const note = this.add("text", {
      parentId: parent.id,
      text: "",
      near: { x: parent.x + parent.w + 28, y: parent.y },
    });
    this._updateBadge(parent);
    this._applyVisibility();
    return note;
  }

  // ---------- per-item interaction ----------
  _wire(el, item, { svg, handle, del, badge }) {
    badge.style.pointerEvents = "none";

    // Body: draw, move, or tap-to-toggle depending on mode/state.
    el.addEventListener("pointerdown", (e) => {
      if (e.target === handle || e.target === del) return;
      if (e.target.isContentEditable) return; // editing text
      e.stopPropagation();
      const wasSelected = this.selected === item.id;
      this.select(item.id);

      if (this.drawMode) return this._startStroke(e, el, item, svg);

      el.setPointerCapture(e.pointerId);
      const kids = this._descendants(item.id).map((k) => ({
        k,
        node: this.nodes.get(k.id),
        ix: k.x,
        iy: k.y,
      }));
      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y };
      let moved = false;

      const onMove = (ev) => {
        const dx = (ev.clientX - start.x) / this.vp.scale;
        const dy = (ev.clientY - start.y) / this.vp.scale;
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > TAP_SLOP) moved = true;
        item.x = Math.round(start.ix + dx);
        item.y = Math.round(start.iy + dy);
        this._layout(el, item);
        for (const c of kids) {
          c.k.x = Math.round(c.ix + dx);
          c.k.y = Math.round(c.iy + dy);
          this._layout(c.node, c.k);
        }
        this.positionBar();
      };
      const onUp = (ev) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        if (!moved && wasSelected && this._children(item.id).length) {
          this.toggleExpand(item);
        } else if (moved) {
          save();
        }
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });

    // Double-click a text note to edit it.
    if (item.type === "text") {
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this._editText(item, el);
      });
    }

    // Resize via the corner handle.
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.select(item.id);
      handle.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, w: item.w, h: item.h };
      const keepSquare = item.type === "circle";
      const onMove = (ev) => {
        const dx = (ev.clientX - start.x) / this.vp.scale;
        const dy = (ev.clientY - start.y) / this.vp.scale;
        if (keepSquare) {
          const d = Math.max(start.w + dx, start.h + dy);
          item.w = item.h = Math.max(MIN_SIZE, Math.round(d));
        } else {
          item.w = Math.max(MIN_SIZE, Math.round(start.w + dx));
          item.h = Math.max(MIN_SIZE, Math.round(start.h + dy));
        }
        this._layout(el, item);
        this.positionBar();
      };
      const onUp = (ev) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        save();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });

    // Delete this item and everything attached beneath it.
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(item.id);
    });
  }

  _editText(item, el) {
    const body = el.querySelector(".text-body");
    body.contentEditable = "true";
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const finish = () => {
      body.contentEditable = "false";
      item.text = body.textContent.trim();
      body.removeEventListener("blur", finish);
      save();
    };
    body.addEventListener("blur", finish);
  }

  _startStroke(e, el, item, svg) {
    el.setPointerCapture(e.pointerId);
    const stroke = { color: this.color, points: [] };
    item.strokes = item.strokes || [];
    item.strokes.push(stroke);
    const path = strokePath(stroke);
    svg.appendChild(path);

    const addPoint = (ev) => {
      const w = this.vp.screenToWorld(ev.clientX, ev.clientY);
      const nx = clamp01((w.x - item.x) / item.w);
      const ny = clamp01((w.y - item.y) / item.h);
      stroke.points.push([+nx.toFixed(4), +ny.toFixed(4)]);
      path.setAttribute("d", strokeD(stroke));
    };
    addPoint(e);
    const onMove = (ev) => addPoint(ev);
    const onUp = (ev) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      if (stroke.points.length < 2) item.strokes.pop(), path.remove();
      save();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  remove(id) {
    for (const d of this._descendants(id)) {
      this.nodes.get(d.id)?.remove();
      this.nodes.delete(d.id);
      removeItem(d.id);
    }
    const parentId = this._get(id)?.parentId;
    this.nodes.get(id)?.remove();
    this.nodes.delete(id);
    removeItem(id);
    if (this.selected === id) this.select(null);
    if (parentId) this._updateBadge(this._get(parentId));
  }
}

// ---- stroke helpers ----
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function strokeD(s) {
  return s.points
    .map(([x, y], i) => `${i ? "L" : "M"}${(x * 1000).toFixed(1)} ${(y * 1000).toFixed(1)}`)
    .join(" ");
}
function strokePath(s) {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", strokeD(s));
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", s.color);
  p.setAttribute("stroke-width", "14");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  return p;
}
