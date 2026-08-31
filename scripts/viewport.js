// viewport.js — the infinite canvas.
// Owns the pan/zoom transform and converts between screen and world space.
// Desktop: drag to pan, wheel to zoom toward the cursor.
// Mobile: one finger pans, two fingers pinch-zoom.

const MIN_SCALE = 0.15;
const MAX_SCALE = 6;
const TAP_SLOP = 5; // px of movement still counts as a tap, not a drag

export class Viewport {
  constructor(viewportEl, worldEl, { onChange } = {}) {
    this.vp = viewportEl;
    this.world = worldEl;
    this.onChange = onChange || (() => {});

    this.x = 0; // world translation (screen px)
    this.y = 0;
    this.scale = 1;

    // Active pointers for pan + pinch (id -> {x,y})
    this.pointers = new Map();
    this.panning = false;
    this.last = { x: 0, y: 0 };
    this.pinch = null; // {dist, cx, cy}

    this._bind();
    this.apply();
  }

  // ---- coordinate helpers ----
  screenToWorld(sx, sy) {
    return { x: (sx - this.x) / this.scale, y: (sy - this.y) / this.scale };
  }
  centerWorld() {
    return this.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  }

  apply() {
    this.world.style.transform =
      `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.world.style.setProperty("--inv-scale", 1 / this.scale);
    this.onChange(this.scale);
  }

  zoomAt(sx, sy, factor) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    if (next === this.scale) return;
    // Keep the world point under (sx,sy) anchored while scaling.
    const wx = (sx - this.x) / this.scale;
    const wy = (sy - this.y) / this.scale;
    this.scale = next;
    this.x = sx - wx * this.scale;
    this.y = sy - wy * this.scale;
    this.apply();
  }

  reset() {
    this.x = 0;
    this.y = 0;
    this.scale = 1;
    this.apply();
  }

  /** Travel to a world-space rect, centering it and (if it's small) zooming
   *  in a little to meet it — used when descending into a layer, so arriving
   *  feels like going somewhere rather than an instant cut. */
  travelTo(rect, { minScale = 0.6, maxScale = 1.4, pad = 80 } = {}) {
    const w = Math.max(1, rect.w + pad * 2);
    const h = Math.max(1, rect.h + pad * 2);
    const fit = Math.min(window.innerWidth / w, window.innerHeight / h);
    this.scale = Math.min(maxScale, Math.max(minScale, fit));
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    this.x = window.innerWidth / 2 - cx * this.scale;
    this.y = window.innerHeight / 2 - cy * this.scale;
    this.apply();
  }

  /** The current view, as travelTo's counterpart — snapshot before
   *  descending, restore on the way back up so ascending returns you to
   *  exactly where you were, not just to a generic reset. */
  snapshot() {
    return { x: this.x, y: this.y, scale: this.scale };
  }
  restore(s) {
    if (!s) return;
    this.x = s.x; this.y = s.y; this.scale = s.scale;
    this.apply();
  }

  _bind() {
    // Pan / pinch are only initiated from empty canvas; items stop propagation.
    this.vp.addEventListener("pointerdown", (e) => this._down(e));
    this.vp.addEventListener("pointermove", (e) => this._move(e));
    this.vp.addEventListener("pointerup", (e) => this._up(e));
    this.vp.addEventListener("pointercancel", (e) => this._up(e));
    this.vp.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
  }

  _down(e) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, downX: e.clientX, downY: e.clientY });

    if (this.pointers.size === 1) {
      this.panning = true;
      this.last = { x: e.clientX, y: e.clientY };
      this.vp.classList.add("is-panning");
      // Capture is claimed later, in _move, once this is clearly a drag —
      // not here. A second finger landing is already unambiguous, so that
      // branch still claims it immediately.
    } else if (this.pointers.size === 2) {
      this.panning = false;
      this.pinch = this._pinchState();
      this.vp.setPointerCapture(e.pointerId);
    }
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.set(e.pointerId, { ...p, x: e.clientX, y: e.clientY });

    // Claim the pointer only once it's moved past a tap's worth of
    // wobble — items (and anything else under the cursor) stop
    // propagation for their own drags, so nothing else is listening for
    // this pointer while it's still ambiguous. Capturing on every down,
    // as this used to, also retargets the click/dblclick that follows a
    // plain tap to the viewport instead of whatever was actually tapped
    // (Chromium routes those to the capture target even though capture
    // itself is long since released by the time they fire) — silently
    // eating taps and layer-entering double-clicks on every item while
    // locked, since a locked item's own pointerdown never stops
    // propagation and this handler always runs too.
    if (!this.vp.hasPointerCapture(e.pointerId) && Math.hypot(e.clientX - p.downX, e.clientY - p.downY) > TAP_SLOP) {
      this.vp.setPointerCapture(e.pointerId);
    }

    if (this.pointers.size >= 2 && this.pinch) {
      const now = this._pinchState();
      const factor = now.dist / this.pinch.dist;
      this.zoomAt(now.cx, now.cy, factor);
      // Pan by the midpoint drift so the pinch feels anchored to the fingers.
      this.x += now.cx - this.pinch.cx;
      this.y += now.cy - this.pinch.cy;
      this.apply();
      this.pinch = now;
      return;
    }

    if (this.panning) {
      this.x += e.clientX - this.last.x;
      this.y += e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      this.apply();
    }
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.panning = false;
      this.vp.classList.remove("is-panning");
    } else if (this.pointers.size === 1) {
      // Resume single-finger pan with the remaining pointer.
      const p = [...this.pointers.values()][0];
      this.last = { x: p.x, y: p.y };
      this.panning = true;
    }
  }

  _wheel(e) {
    // A note that has more text than fits scrolls itself under the cursor,
    // not the whole mosaic — otherwise reading down a long note zooms the
    // canvas out from under you before you get anywhere. No need to have
    // clicked into it first; just hovering is enough, same as any other
    // scrollable box. Bail out without preventDefault so the browser's own
    // scroll runs on the note.
    const body = e.target.closest?.(".text-body");
    if (body && body.scrollHeight > body.clientHeight) return;

    e.preventDefault();
    // Trackpad pinch arrives as ctrl+wheel; normal wheel also zooms here.
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.zoomAt(e.clientX, e.clientY, factor);
  }

  _pinchState() {
    const [a, b] = [...this.pointers.values()];
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return {
      dist: Math.hypot(dx, dy) || 1,
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }
}
