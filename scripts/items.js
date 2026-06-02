// items.js — everything that lives on the canvas.
// Renders items as DOM nodes in world-space, and handles selecting,
// dragging (move), resizing (corner handle), and deleting them.

import { items, save, addItem, removeItem, newId } from "./store.js";

const MIN_SIZE = 24; // smallest a shape may shrink to (world units)

export class ItemLayer {
  constructor(worldEl, viewport) {
    this.world = worldEl;
    this.vp = viewport; // for screen<->world scale during drag/resize
    this.nodes = new Map(); // id -> element
    this.selected = null;

    // Clicking empty canvas clears selection.
    viewport.vp.addEventListener("pointerdown", (e) => {
      if (e.target === viewport.vp) this.select(null);
    });

    for (const it of items) this._render(it);
  }

  // ---- creating ----
  add(type, { src, w, h } = {}) {
    const c = this.vp.centerWorld();
    w = w || 160;
    h = h || 160;
    const item = addItem({
      id: newId(),
      type,
      x: Math.round(c.x - w / 2),
      y: Math.round(c.y - h / 2),
      w,
      h,
      ...(src ? { src } : {}),
    });
    const el = this._render(item);
    this.select(item.id);
    return el;
  }

  // ---- rendering ----
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

    const del = document.createElement("button");
    del.className = "delete";
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", "Delete");
    el.appendChild(del);

    const handle = document.createElement("div");
    handle.className = "handle";
    el.appendChild(handle);

    this._wire(el, item, handle, del);
    this.world.appendChild(el);
    this.nodes.set(item.id, el);
    return el;
  }

  _layout(el, item) {
    el.style.left = item.x + "px";
    el.style.top = item.y + "px";
    el.style.width = item.w + "px";
    el.style.height = item.h + "px";
  }

  // ---- selection ----
  select(id) {
    if (this.selected === id) return;
    if (this.selected) {
      this.nodes.get(this.selected)?.classList.remove("is-selected");
    }
    this.selected = id;
    if (id) {
      const el = this.nodes.get(id);
      el?.classList.add("is-selected");
      this.world.appendChild(el); // bring to front
    }
  }

  remove(id) {
    this.nodes.get(id)?.remove();
    this.nodes.delete(id);
    removeItem(id);
    if (this.selected === id) this.selected = null;
  }

  // ---- interaction wiring ----
  _wire(el, item, handle, del) {
    // Move (drag the body)
    el.addEventListener("pointerdown", (e) => {
      if (e.target === handle || e.target === del) return;
      e.stopPropagation(); // don't pan the canvas
      this.select(item.id);
      el.setPointerCapture(e.pointerId);

      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y };
      const onMove = (ev) => {
        const dx = (ev.clientX - start.x) / this.vp.scale;
        const dy = (ev.clientY - start.y) / this.vp.scale;
        item.x = Math.round(start.ix + dx);
        item.y = Math.round(start.iy + dy);
        this._layout(el, item);
      };
      const onUp = (ev) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        save();
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });

    // Resize (drag the corner handle) — enlarge or shrink the shape
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

    // Delete
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(item.id);
    });
  }
}
