// background/background.js — selective, draggable backgrounds.
//
// A "background region" is a shape (rect / circle) or an uploaded cut-out that
// sits BEHIND all your content as a translucent wash over part of the canvas.
// Turn on background mode, pick a shape from the library, then drag it over
// the area you want and resize it. Regions persist on their own.

const KEY = "digital-courtyard:bg:v1";
const MIN_SIZE = 30;
const DEFAULT_OPACITY = 0.55; // diaphanous, so covered content stays visible
const FILL = { rect: "#d7c4a3", circle: "#bcd0b6" };

export class BackgroundLayer {
  constructor(worldEl, viewport) {
    this.vp = viewport;
    this.mode = false;        // when true, shape picks become backgrounds
    this.selected = null;
    this.nodes = new Map();
    this.onSelect = null;     // hook so the item layer can deselect
    this.isOpen = null;       // predicate(id): is that item-group open? (injected)
    this._drag = null;        // snapshot while a group is being dragged

    // Dedicated container, pinned as the first child of the world so every
    // background sits beneath the items regardless of later DOM shuffling.
    this.container = document.createElement("div");
    this.container.className = "bg-world";
    worldEl.insertBefore(this.container, worldEl.firstChild);

    this.items = load();
    this._buildBar();

    viewport.vp.addEventListener("pointerdown", (e) => {
      if (e.target === viewport.vp) this.select(null);
    });

    for (const it of this.items) this._render(it);
  }

  toggleMode() {
    this.mode = !this.mode;
    if (!this.mode) this.select(null);
    return this.mode;
  }

  // ---------- creating ----------
  add(shape, { src, parentId } = {}) {
    const c = this.vp.centerWorld();
    const w = 320, h = 240;
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      shape, // 'rect' | 'circle' | 'image'
      x: Math.round(c.x - w / 2),
      y: Math.round(c.y - h / 2),
      w: shape === "circle" ? 280 : w,
      h: shape === "circle" ? 280 : h,
      opacity: DEFAULT_OPACITY,
      ...(parentId ? { parentId } : {}), // bound to an open item-group
      ...(shape === "image" ? { src } : { color: FILL[shape] || "#d7c4a3" }),
    };
    this.items.push(item);
    this._render(item);
    this._save();
    this.select(item.id);
    return item;
  }

  // ---------- group binding (show/move/remove with an item-group) ----------
  // A grouped background is visible only while its parent group is open.
  refreshGroupedVisibility() {
    if (!this.isOpen) return;
    for (const it of this.items) {
      if (!it.parentId) continue;
      this.nodes.get(it.id)?.classList.toggle("is-hidden", !this.isOpen(it.parentId));
    }
    if (this.selected) {
      const sel = this._get(this.selected);
      if (sel?.parentId && !this.isOpen(sel.parentId)) this.select(null);
    }
  }

  beginGroupDrag(ids) {
    this._drag = this.items
      .filter((it) => it.parentId && ids.has(it.parentId))
      .map((it) => ({ it, ix: it.x, iy: it.y }));
  }
  groupDragTo(dx, dy) {
    if (!this._drag) return;
    for (const d of this._drag) {
      d.it.x = Math.round(d.ix + dx);
      d.it.y = Math.round(d.iy + dy);
      this._style(this.nodes.get(d.it.id), d.it);
    }
  }
  endGroupDrag() {
    if (!this._drag) return;
    this._drag = null;
    this._save();
  }

  removeGroupedUnder(ids) {
    const set = new Set(ids);
    for (const it of [...this.items]) {
      if (it.parentId && set.has(it.parentId)) this.remove(it.id);
    }
  }

  // ---------- rendering ----------
  _render(item) {
    const el = document.createElement("div");
    el.className = `bg-item bg-item--${item.shape}`;
    el.dataset.id = item.id;
    this._style(el, item);

    if (item.shape === "image") {
      el.style.backgroundImage = `url(${item.src})`;
    }

    const del = document.createElement("button");
    del.className = "bg-del";
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", "Remove background");
    el.appendChild(del);

    const handle = document.createElement("div");
    handle.className = "bg-handle";
    el.appendChild(handle);

    this._wire(el, item, handle, del);
    this.container.appendChild(el);
    this.nodes.set(item.id, el);
    return el;
  }

  _style(el, item) {
    el.style.left = item.x + "px";
    el.style.top = item.y + "px";
    el.style.width = item.w + "px";
    el.style.height = item.h + "px";
    el.style.opacity = item.opacity;
    if (item.shape !== "image") el.style.background = item.color;
  }

  // ---------- selection + bar ----------
  select(id) {
    if (this.selected === id) return;
    if (this.selected) this.nodes.get(this.selected)?.classList.remove("is-selected");
    this.selected = id;
    if (id) {
      const el = this.nodes.get(id);
      el?.classList.add("is-selected");
      this.container.appendChild(el); // front-most among backgrounds
      this._showBar();
      this.onSelect?.(id); // let the item layer drop its selection
    } else {
      this.bar.hidden = true;
    }
  }

  _showBar() {
    const item = this._get(this.selected);
    if (!item) return;
    this.bar.hidden = false;
    this._colorInput.parentElement.style.display = item.shape === "image" ? "none" : "";
    this._colorInput.value = item.color || "#d7c4a3";
    this._opInput.value = Math.round(item.opacity * 100);
    this.positionBar();
  }

  positionBar() {
    if (this.bar.hidden || !this.selected) return;
    const item = this._get(this.selected);
    if (!item) return;
    const s = this.vp.scale;
    this.bar.style.left = this.vp.x + (item.x + item.w / 2) * s + "px";
    this.bar.style.top = this.vp.y + item.y * s - this.bar.offsetHeight - 12 + "px";
  }

  _buildBar() {
    const bar = document.createElement("div");
    bar.className = "bg-bar";
    bar.hidden = true;
    bar.innerHTML = `
      <label class="bg-bar__swatch" title="Fill color">
        <input type="color" class="bg-bar__color" value="#d7c4a3" />
      </label>
      <label class="bg-bar__op" title="Opacity">
        <span>opacity</span>
        <input type="range" min="10" max="100" value="55" class="bg-bar__range" />
      </label>`;
    document.body.appendChild(bar);
    this.bar = bar;
    this._colorInput = bar.querySelector(".bg-bar__color");
    this._opInput = bar.querySelector(".bg-bar__range");

    this._colorInput.addEventListener("input", (e) => {
      const item = this._get(this.selected);
      if (!item) return;
      item.color = e.target.value;
      this._style(this.nodes.get(item.id), item);
      this._save();
    });
    this._opInput.addEventListener("input", (e) => {
      const item = this._get(this.selected);
      if (!item) return;
      item.opacity = e.target.value / 100;
      this.nodes.get(item.id).style.opacity = item.opacity;
      this._save();
    });
  }

  // ---------- interaction ----------
  _wire(el, item, handle, del) {
    // Drag to position over the area you want.
    el.addEventListener("pointerdown", (e) => {
      if (e.target === handle || e.target === del) return;
      e.stopPropagation(); // don't pan the canvas
      this.select(item.id);
      el.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y };
      const onMove = (ev) => {
        item.x = Math.round(start.ix + (ev.clientX - start.x) / this.vp.scale);
        item.y = Math.round(start.iy + (ev.clientY - start.y) / this.vp.scale);
        this._style(el, item);
        this.positionBar();
      };
      const onUp = (ev) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        this._save();
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });

    // Corner handle to resize as you see fit.
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.select(item.id);
      handle.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, w: item.w, h: item.h };
      const keepSquare = item.shape === "circle";
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
        this._style(el, item);
        this.positionBar();
      };
      const onUp = (ev) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        this._save();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });

    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(item.id);
    });
  }

  remove(id) {
    this.nodes.get(id)?.remove();
    this.nodes.delete(id);
    const i = this.items.findIndex((it) => it.id === id);
    if (i !== -1) this.items.splice(i, 1);
    if (this.selected === id) this.select(null);
    this._save();
  }

  _get(id) {
    return this.items.find((it) => it.id === id);
  }

  _save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items));
    } catch {
      /* in-session only if storage is unavailable */
    }
  }
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}
