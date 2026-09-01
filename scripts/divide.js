// divide.js — split a region (an item's own current outline) into two,
// along a freehand stroke drawn across it. Build-your-own tzuras hadaf:
// the Talmud page's own margins-around-a-body layout uses straight,
// square-angled dividers, but any hand-drawn line works here — draw as
// many as you like, on either resulting piece, and every piece ends up
// its own text-ready region. See items.js's divide-mode wiring for how a
// stroke actually gets here and what happens to the result.
//
// No real polygon-clipping math, and no new item fields either: the
// region being split is rasterized as a plain 0/1 mask (exactly like
// alphaClipPath's own alpha mask, just not sourced from a real photo),
// the stroke is "cut" into it by clearing the pixels it passes over, and
// the two pieces that fall out of that are found with a plain flood
// fill. Each piece is then rendered right back out as a small opaque-on-
// transparent PNG — a SYNTHETIC photo — and handed to items.js to use
// exactly the way it already uses a real one (setNoteShapeImage): traced
// into a clip-path and a text-wrap by the very same code, aspect-locked
// the very same way, and divisible AGAIN later by reading its own alpha
// channel right back out, same as any other shaped note. One shape
// representation for the whole app instead of a second one bolted on
// just for hand-drawn regions.

import { TRACE_MAX } from "./silhouette.js";

const CUT_RADIUS = 1; // px, at TRACE_MAX resolution — thin enough to stay precise, thick
// enough that a 4-connected flood fill can't leak through a diagonal gap in the cut.

/**
 * Splits the region described by insideAt (an (xFrac,yFrac) => boolean
 * test, 0..1 over the item's own box) along strokePoints — an array of
 * {x,y}, same 0..1 box-relative convention items.js's own ink strokes
 * already use — into two pieces.
 *
 * Returns { a, b }, each { dataUrl, bounds, area }:
 *  - dataUrl: a synthetic PNG ready to use as item.shapeSrc
 *  - bounds: { xFrac, yFrac, wFrac, hFrac } — this piece's own bounding
 *    box, as a fraction of the ORIGINAL box insideAt was tested against.
 *    A left/right cut's two pieces don't share a center point, so a
 *    caller positioning them on the canvas needs each one's own actual
 *    location within the original area, not just its shape.
 *  - area: its pixel count, for picking which piece is "bigger" if a
 *    caller cares
 * ...or null if the stroke didn't actually separate the region into two:
 * too short, doesn't reach both sides, or loops back on itself without
 * crossing all the way through. Callers should tell the user to draw all
 * the way across rather than silently doing nothing.
 */
export function splitRegion(insideAt, strokePoints) {
  if (!strokePoints || strokePoints.length < 2) return null;
  const w = TRACE_MAX, h = TRACE_MAX;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (insideAt((x + 0.5) / w, (y + 0.5) / h)) mask[y * w + x] = 1;
    }
  }

  const pts = extendPath(strokePoints, w, h);
  for (let i = 1; i < pts.length; i++) stampSegment(mask, w, h, pts[i - 1], pts[i]);

  const { labels, sizes } = labelComponents(mask, w, h);
  const order = [...sizes.keys()].sort((x, y) => sizes.get(y) - sizes.get(x));
  if (order.length < 2) return null; // the cut never actually separated anything

  const a = renderMaskPng(labels, w, h, order[0]);
  const b = renderMaskPng(labels, w, h, order[1]);
  if (!a || !b) return null;
  return {
    a: { dataUrl: a.dataUrl, bounds: a.bounds, area: sizes.get(order[0]) },
    b: { dataUrl: b.dataUrl, bounds: b.bounds, area: sizes.get(order[1]) },
  };
}

// Opaque white where this label's region is, fully transparent everywhere
// else — a plain page-panel look once it's actually shown, and exactly
// the alpha shape alphaClipPath/shapeWrapFloats need to trace it.
//
// Cropped to the region's own bounding box, NOT left at the full w×h grid:
// naturalAspect reads a PNG's own pixel dimensions to decide the note's
// box shape (see items.js's _matchShapeAspect), and the whole grid is
// always square regardless of which sliver of it this particular piece
// actually occupies. Left uncropped, every divided piece would get
// forced into a square box no matter its real proportions — and since
// the traced shape would then only fill PART of that box, the rest
// stays clipped away and unclickable, sometimes including the box's own
// center point.
function renderMaskPng(labels, w, h, label) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] !== label) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return null; // shouldn't happen (label came from a non-empty component), but never draw a 0-size canvas
  const cw = maxX - minX + 1, ch = maxY - minY + 1;

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(cw, ch);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (labels[y * w + x] !== label) continue;
      const p = ((y - minY) * cw + (x - minX)) * 4;
      img.data[p] = 255; img.data[p + 1] = 255; img.data[p + 2] = 255; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    bounds: { xFrac: minX / w, yFrac: minY / h, wFrac: cw / w, hFrac: ch / h },
  };
}

// Extends the drawn stroke well past both its own ends — a real
// hand-drawn line rarely lands EXACTLY on the region's true edge, and a
// cut that stops just short of it never actually separates anything.
function extendPath(strokePoints, w, h) {
  const pts = strokePoints.map((p) => ({ x: p.x * w, y: p.y * h }));
  const EXT = Math.hypot(w, h); // comfortably past any edge, whichever direction the stroke runs
  const extend = (from, to) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: to.x + (dx / len) * EXT, y: to.y + (dy / len) * EXT };
  };
  const first = pts.length > 1 ? extend(pts[1], pts[0]) : pts[0];
  const last = pts.length > 1 ? extend(pts[pts.length - 2], pts[pts.length - 1]) : pts[0];
  return [first, ...pts, last];
}

function stampSegment(mask, w, h, p0, p1) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  for (let i = 0; i <= steps; i++) {
    stampPoint(mask, w, h, p0.x + (dx * i) / steps, p0.y + (dy * i) / steps);
  }
}

function stampPoint(mask, w, h, x, y) {
  const cx = Math.round(x), cy = Math.round(y);
  for (let dy = -CUT_RADIUS; dy <= CUT_RADIUS; dy++) {
    for (let dx = -CUT_RADIUS; dx <= CUT_RADIUS; dx++) {
      const px = cx + dx, py = cy + dy;
      if (px >= 0 && px < w && py >= 0 && py < h) mask[py * w + px] = 0;
    }
  }
}

// Plain 4-connected flood fill (matches the connectivity silhouette.js's
// own contour tracer implicitly uses — only orthogonal neighbors), via an
// explicit stack rather than recursion (a TRACE_MAX×TRACE_MAX grid is only
// ever a few thousand pixels, but no reason to risk a deep call stack).
function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const sizes = new Map();
  let nextLabel = 0;
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || labels[start] !== -1) continue;
      const label = nextLabel++;
      let size = 0;
      stack.push(start);
      labels[start] = label;
      while (stack.length) {
        const cur = stack.pop();
        size++;
        const cx = cur % w, cy = (cur / w) | 0;
        if (cx > 0 && mask[cur - 1] && labels[cur - 1] === -1) { labels[cur - 1] = label; stack.push(cur - 1); }
        if (cx < w - 1 && mask[cur + 1] && labels[cur + 1] === -1) { labels[cur + 1] = label; stack.push(cur + 1); }
        if (cy > 0 && mask[cur - w] && labels[cur - w] === -1) { labels[cur - w] = label; stack.push(cur - w); }
        if (cy < h - 1 && mask[cur + w] && labels[cur + w] === -1) { labels[cur + w] = label; stack.push(cur + w); }
      }
      sizes.set(label, size);
    }
  }
  return { labels, sizes };
}
