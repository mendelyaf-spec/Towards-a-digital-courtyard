// background/background.js — selective, draggable backgrounds.
//
// Two phases:
//   1. PLACING — the region floats above your content, diaphanous, so you can
//      see what it will cover while you move, resize, and rotate it.
//   2. SET — you commit it; it drops behind your content and becomes the
//      background. Select it again and hit "Adjust" to go back to placing.
//
// A region can also bind to an open item-group (parentId) so it hides, moves,
// and is deleted along with that group.

import { canvasBgKey } from "../scripts/store.js";

const MIN_SIZE = 30;
const PLACING_OPACITY = 0.5;   // diaphanous while you position it
const DEFAULT_OPACITY = 1;     // solid once it's the background (slider can lower)
const FILL = { rect: "#d7c4a3", circle: "#bcd0b6" };

export class BackgroundLayer {
  constructor(worldEl, viewport) {
    this.vp = viewport;
    this.worldEl = worldEl;
    this.mode = false;        // when true, shape picks become backgrounds
    this.selected = null;
    this.nodes = new Map();
    this.onSelect = null;     // hook so the item layer can deselect
    this.isOpen = null;       // predicate(id): is that item-group open? (injected)
    this._drag = null;        // snapshot while a group is being dragged
    this.canvasId = null;     // which canvas these backgrounds belong to
    this.items = [];
    this._panMode = false;    // when true, dragging an image region pans its photo instead of moving the box

    // Behind all content.
    this.bgWorld = document.createElement("div");
    this.bgWorld.className = "bg-world";
    worldEl.insertBefore(this.bgWorld, worldEl.firstChild);

    // Above all content — where a region lives while you're placing it.
    this.placeWorld = document.createElement("div");
    this.placeWorld.className = "bg-world bg-world--place";
    worldEl.appendChild(this.placeWorld);

    this._buildBar();

    viewport.vp.addEventListener("pointerdown", (e) => {
      if (e.target === viewport.vp) this.select(null);
    });
  }

  // Swap to another canvas's backgrounds.
  loadCanvas(id) {
    for (const el of this.nodes.values()) el.remove();
    this.nodes.clear();
    this.selected = null;
    this.bar.hidden = true;
    this.canvasId = id;
    try {
      this.items = JSON.parse(localStorage.getItem(canvasBgKey(id))) || [];
    } catch {
      this.items = [];
    }
    for (const it of this.items) this._render(it);
    this._toFront();
    this.refreshGroupedVisibility();
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
      rotation: 0,
      opacity: DEFAULT_OPACITY,
      placing: true, // starts diaphanous, above content, awaiting "Set"
      ...(parentId ? { parentId } : {}),
      // imgScale/imgRotate/imgOffsetX/imgOffsetY crop the source photo within
      // the region — independent of rotation/w/h, which shape the region itself.
      ...(shape === "image"
        ? { src, imgScale: 1, imgRotate: 0, imgOffsetX: 0, imgOffsetY: 0 }
        : { color: FILL[shape] || "#d7c4a3" }),
    };
    this.items.push(item);
    this._toFront(); // placing layer must sit above content
    this._render(item);
    this._save();
    this.select(item.id);
    return item;
  }

  // ---------- commit / re-edit ----------
  commit(id) {
    const item = this._get(id);
    if (!item) return;
    item.placing = false;
    this.bgWorld.appendChild(this.nodes.get(id)); // drop behind content
    this._style(this.nodes.get(id), item);
    this._save();
    this.select(null); // it's the background now
  }
  edit(id) {
    const item = this._get(id);
    if (!item) return;
    item.placing = true;
    this._toFront();
    this.placeWorld.appendChild(this.nodes.get(id)); // bring forward to adjust
    this._style(this.nodes.get(id), item);
    this._showBar();
    this._save();
  }
  _toFront() {
    this.worldEl.appendChild(this.placeWorld); // keep the placing layer on top
  }

  // Resize + reposition a region to cover the whole visible canvas right now,
  // with a little slack so small panning doesn't immediately reveal an edge.
  fillScreen(id) {
    const item = this._get(id);
    if (!item) return;
    const pad = 0.15;
    const tl = this.vp.screenToWorld(0, 0);
    const br = this.vp.screenToWorld(window.innerWidth, window.innerHeight);
    const w = br.x - tl.x, h = br.y - tl.y;
    item.x = Math.round(tl.x - w * pad);
    item.y = Math.round(tl.y - h * pad);
    item.w = Math.round(w * (1 + pad * 2));
    item.h = Math.round(h * (1 + pad * 2));
    this._style(this.nodes.get(id), item);
    this._save();
    this.positionBar();
  }

  // ---------- group binding ----------
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
    if (item.shape === "image") {
      // An actual <img>, not a CSS background-image, so it can be panned,
      // zoomed and rotated independently of the region box that clips it.
      const img = document.createElement("img");
      img.className = "bg-item__img";
      img.src = item.src;
      img.alt = "";
      img.draggable = false;
      el.appendChild(img);
    }
    this._style(el, item);

    const rotate = document.createElement("div");
    rotate.className = "bg-rotate";
    el.appendChild(rotate);

    const del = document.createElement("button");
    del.className = "bg-del";
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", "Remove background");
    el.appendChild(del);

    const handle = document.createElement("div");
    handle.className = "bg-handle";
    el.appendChild(handle);

    this._wire(el, item, { handle, rotate, del });
    (item.placing ? this.placeWorld : this.bgWorld).appendChild(el);
    this.nodes.set(item.id, el);
    return el;
  }

  _style(el, item) {
    el.style.left = item.x + "px";
    el.style.top = item.y + "px";
    el.style.width = item.w + "px";
    el.style.height = item.h + "px";
    el.style.transform = `rotate(${item.rotation || 0}deg)`;
    // While placing, cap (don't fix) the preview at PLACING_OPACITY: a lower
    // slider value still shows through live; higher values stay capped so
    // you can keep seeing what's underneath until you commit it.
    el.style.opacity = item.placing ? Math.min(item.opacity, PLACING_OPACITY) : item.opacity;
    el.classList.toggle("is-placing", !!item.placing);
    if (item.shape !== "image") el.style.background = item.color;
    else this._styleImg(el, item);
  }

  // Pan/zoom/rotate of the photo *content* inside its region — separate from
  // the region box's own rotation, which _style() applies to `el` above.
  _styleImg(el, item) {
    const img = el.querySelector(".bg-item__img");
    if (!img) return;
    const scale = item.imgScale ?? 1;
    const rot = item.imgRotate ?? 0;
    const ox = item.imgOffsetX ?? 0;
    const oy = item.imgOffsetY ?? 0;
    img.style.transform = `translate(-50%, -50%) translate(${ox}px, ${oy}px) rotate(${rot}deg) scale(${scale})`;
  }

  // ---------- selection + bar ----------
  select(id) {
    if (this.selected === id) return;
    if (this.selected) this.nodes.get(this.selected)?.classList.remove("is-selected");
    this.selected = id;
    this._panMode = false; // switching selection always drops out of pan mode
    if (id) {
      const el = this.nodes.get(id);
      el?.classList.add("is-selected");
      const item = this._get(id);
      if (item.placing) this._toFront();
      (item.placing ? this.placeWorld : this.bgWorld).appendChild(el); // front of its layer
      this._showBar();
      this.onSelect?.(id);
    } else {
      this.bar.hidden = true;
    }
  }

  _showBar() {
    const item = this._get(this.selected);
    if (!item) return;
    this.bar.hidden = false;
    const isImg = item.shape === "image";
    this._colorInput.parentElement.style.display = isImg ? "none" : "";
    this._colorInput.value = item.color || "#d7c4a3";
    this._opInput.value = Math.round(item.opacity * 100);
    this._zoomInput.parentElement.style.display = isImg ? "" : "none";
    this._rotImgInput.parentElement.style.display = isImg ? "" : "none";
    this._panBtn.style.display = isImg ? "" : "none";
    this._zoomInput.value = Math.round((item.imgScale ?? 1) * 100);
    this._rotImgInput.value = item.imgRotate ?? 0;
    this._panBtn.classList.toggle("is-on", this._panMode);
    this._panBtn.textContent = this._panMode ? "done" : "move photo";
    this._setBtn.textContent = item.placing ? "set background" : "adjust";
    this.positionBar();
  }

  positionBar() {
    if (this.bar.hidden || !this.selected) return;
    const item = this._get(this.selected);
    if (!item) return;
    const s = this.vp.scale;
    let left = this.vp.x + (item.x + item.w / 2) * s;
    let top = this.vp.y + item.y * s - this.bar.offsetHeight - 28;
    // Clamp on-screen: a "fill screen" region's bounds extend past the
    // viewport, so anchoring blindly to the item would push the bar (and its
    // "set background" button) out of reach.
    const barW = this.bar.offsetWidth || 260;
    const barH = this.bar.offsetHeight || 44;
    left = Math.min(Math.max(left, barW / 2 + 8), window.innerWidth - barW / 2 - 8);
    top = Math.min(Math.max(top, 8), window.innerHeight - barH - 8);
    this.bar.style.left = left + "px";
    this.bar.style.top = top + "px";
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
        <input type="range" min="10" max="100" value="100" class="bg-bar__range" />
      </label>
      <label class="bg-bar__op bg-bar__op--zoom" title="Zoom the photo within its shape">
        <span>zoom</span>
        <input type="range" min="50" max="300" value="100" class="bg-bar__range bg-bar__zoomrange" />
      </label>
      <label class="bg-bar__op bg-bar__op--rotimg" title="Rotate the photo within its shape">
        <span>rotate</span>
        <input type="range" min="-180" max="180" value="0" class="bg-bar__range bg-bar__rotimgrange" />
      </label>
      <button type="button" class="bg-bar__fill bg-bar__pan" title="Drag the photo to reposition it within its shape">move photo</button>
      <button type="button" class="bg-bar__fill" title="Resize to cover the whole visible canvas">fill screen</button>
      <button type="button" class="bg-bar__set">set background</button>`;
    document.body.appendChild(bar);
    this.bar = bar;
    this._colorInput = bar.querySelector(".bg-bar__color");
    this._opInput = bar.querySelector(".bg-bar__range");
    this._zoomInput = bar.querySelector(".bg-bar__zoomrange");
    this._rotImgInput = bar.querySelector(".bg-bar__rotimgrange");
    this._panBtn = bar.querySelector(".bg-bar__pan");
    this._setBtn = bar.querySelector(".bg-bar__set");
    this._fillBtn = bar.querySelector(".bg-bar__fill");
    this._fillBtn.addEventListener("click", () => {
      if (this.selected) this.fillScreen(this.selected);
    });
    this._zoomInput.addEventListener("input", (e) => {
      const item = this._get(this.selected);
      if (!item) return;
      item.imgScale = e.target.value / 100;
      this._style(this.nodes.get(item.id), item);
      this._save();
    });
    this._rotImgInput.addEventListener("input", (e) => {
      const item = this._get(this.selected);
      if (!item) return;
      item.imgRotate = Number(e.target.value);
      this._style(this.nodes.get(item.id), item);
      this._save();
    });
    this._panBtn.addEventListener("click", () => {
      this._panMode = !this._panMode;
      this._panBtn.classList.toggle("is-on", this._panMode);
      this._panBtn.textContent = this._panMode ? "done" : "move photo";
    });

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
      this._style(this.nodes.get(item.id), item); // live feedback whether placing or already set
      this._save();
    });
    this._setBtn.addEventListener("click", () => {
      const item = this._get(this.selected);
      if (!item) return;
      item.placing ? this.commit(item.id) : this.edit(item.id);
    });
  }

  // ---------- interaction: move / resize / rotate ----------
  _wire(el, item, { handle, rotate, del }) {
    // Move — drag the body. Rotation doesn't affect translation.
    el.addEventListener("pointerdown", (e) => {
      if (e.target === handle || e.target === rotate || e.target === del) return;
      e.stopPropagation();
      this.select(item.id);
      el.setPointerCapture(e.pointerId);
      if (this._panMode && item.shape === "image") {
        // Reposition the photo within the box instead of moving the box —
        // un-rotate the drag delta into the box's local axes, same trick the
        // resize handle below uses, so panning still feels right after the
        // region itself has been rotated.
        const start = { x: e.clientX, y: e.clientY, ox: item.imgOffsetX || 0, oy: item.imgOffsetY || 0 };
        const t = ((item.rotation || 0) * Math.PI) / 180;
        const cos = Math.cos(t), sin = Math.sin(t);
        const onMove = (ev) => {
          const dx = (ev.clientX - start.x) / this.vp.scale;
          const dy = (ev.clientY - start.y) / this.vp.scale;
          item.imgOffsetX = start.ox + dx * cos + dy * sin;
          item.imgOffsetY = start.oy + (-dx * sin + dy * cos);
          this._style(el, item);
        };
        this._dragLoop(el, onMove);
        return;
      }
      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y };
      const onMove = (ev) => {
        item.x = Math.round(start.ix + (ev.clientX - start.x) / this.vp.scale);
        item.y = Math.round(start.iy + (ev.clientY - start.y) / this.vp.scale);
        this._style(el, item);
        this.positionBar();
      };
      this._dragLoop(el, onMove);
    });

    // Resize — corner handle, in the rotated frame, anchored on the center.
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.select(item.id);
      handle.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, w: item.w, h: item.h, cx: item.x + item.w / 2, cy: item.y + item.h / 2 };
      const t = ((item.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(t), sin = Math.sin(t);
      const keepSquare = item.shape === "circle";
      const onMove = (ev) => {
        const dx = (ev.clientX - start.x) / this.vp.scale;
        const dy = (ev.clientY - start.y) / this.vp.scale;
        const lx = dx * cos + dy * sin;   // un-rotate into local axes
        const ly = -dx * sin + dy * cos;
        let nw = Math.max(MIN_SIZE, Math.round(start.w + lx));
        let nh = Math.max(MIN_SIZE, Math.round(start.h + ly));
        if (keepSquare) nw = nh = Math.max(nw, nh);
        item.w = nw;
        item.h = nh;
        item.x = Math.round(start.cx - nw / 2); // keep center fixed
        item.y = Math.round(start.cy - nh / 2);
        this._style(el, item);
        this.positionBar();
      };
      this._dragLoop(handle, onMove);
    });

    // Rotate — drag the top handle around the center.
    rotate.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.select(item.id);
      rotate.setPointerCapture(e.pointerId);
      const s = this.vp.scale;
      const cx = this.vp.x + (item.x + item.w / 2) * s;
      const cy = this.vp.y + (item.y + item.h / 2) * s;
      const startAng = Math.atan2(e.clientY - cy, e.clientX - cx);
      const startRot = item.rotation || 0;
      const onMove = (ev) => {
        const ang = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        item.rotation = Math.round(startRot + ((ang - startAng) * 180) / Math.PI);
        this._style(el, item);
      };
      this._dragLoop(rotate, onMove);
    });

    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(item.id);
    });
  }

  // Shared pointermove/up loop that saves on release.
  _dragLoop(target, onMove) {
    const up = (ev) => {
      target.releasePointerCapture?.(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", up);
      this._save();
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", up);
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
    if (!this.canvasId) return;
    try {
      localStorage.setItem(canvasBgKey(this.canvasId), JSON.stringify(this.items));
    } catch {
      /* in-session only if storage is unavailable */
    }
  }
}
