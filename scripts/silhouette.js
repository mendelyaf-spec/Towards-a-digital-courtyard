// silhouette.js — turn a cutout photo's own alpha channel into a CSS
// clip-path so the ITEM's actual clickable/visible area follows the
// subject's real outline, not its rectangular bounding box.
//
// CSS mask-image visually hides transparent pixels but does NOT exclude
// them from hit-testing (confirmed empirically in Chromium — a fully
// transparent masked-out area still receives pointer events as if it were
// opaque). clip-path DOES exclude its clipped-away area from hit-testing,
// which is exactly the behavior wanted here — but clip-path only accepts
// vector shapes (polygon/path), not a raster mask directly. So this module
// traces the alpha silhouette's boundary into a polygon.
//
// Algorithm: downsample for speed/smoothness → collect every unit boundary
// edge between an opaque pixel and a transparent/out-of-bounds neighbor,
// oriented consistently → chain edges into closed loops by matching
// endpoints → keep the loop enclosing the largest area (the dominant
// blob's outer boundary — an object with a separate smaller fragment just
// loses its clip-path accuracy there, not its correctness) → drop
// redundant collinear points (long straight runs on a raster staircase
// collapse to their two endpoints) → cap the point count for a
// reasonably-sized clip-path string.
//
// The core of this (mask → clip-path polygon, mask → shape-outside pair)
// works on any 0/1 mask, image-derived or not — divide.js reuses both
// directly on a hand-drawn split instead of a photo's alpha channel.

export const TRACE_MAX = 128; // downsample to at most this many px per side before tracing — a clip-path
// is itself an approximation, so full source resolution buys nothing but slowness and a jagged,
// needlessly detailed polygon; this size still resolves plenty of silhouette detail.
const ALPHA_THRESHOLD = 24; // pixels at/above this alpha count as "inside" the shape
const MAX_POINTS = 160; // hard cap so a noisy/complex silhouette can't produce an unwieldy polygon

/**
 * Returns a CSS clip-path polygon() string (in percentages, so it scales
 * with whatever box ends up displaying the image) approximating the given
 * image src's own alpha silhouette — or null if there's nothing meaningful
 * to clip (fully transparent, decode failure, or too small to trace).
 * Callers should just skip clip-path on null, leaving the plain
 * rectangular box.
 */
export async function alphaClipPath(src) {
  const rasterized = await alphaMask(src);
  if (!rasterized) return null;
  const { insideAt, w, h } = rasterized;
  return maskToClipPath(insideAt, w, h);
}

/**
 * A pair of CSS shape-outside polygon() strings — { left, right } — that
 * make a block of native, live-typed text hug a photo's own silhouette
 * from both sides as it flows, line by line, instead of sitting inside a
 * plain rectangle: a line near the narrow tip of a leaf comes out short, a
 * line through its widest point comes out long. Or null if there's nothing
 * meaningful to trace (mirrors alphaClipPath's own bail-outs).
 *
 * The trick (a standard one for "text inside a shape" in CSS, which has no
 * shape-inside of its own): two invisible floats, one pinned to each side
 * of the text box, each shaped like everything OUTSIDE the silhouette on
 * its half. Native text wraps around them using the browser's own layout
 * engine — so it never has to be told not to split a word mid-line; that's
 * just how in-browser line-wrapping already works once nothing forces it
 * to do otherwise (see items.js, which also stops asking it to for shaped
 * notes specifically).
 */
export async function shapeWrapFloats(src, rows = 40) {
  const rasterized = await alphaMask(src);
  if (!rasterized) return null;
  const { insideAt, w, h } = rasterized;
  return maskToWrapFloats(insideAt, w, h, rows);
}

/**
 * A photo's own natural width/height ratio, or null on decode failure.
 * Used to keep a shaped note's own box the same shape as its photo —
 * object-fit:contain letterboxes the photo inside a box with a different
 * ratio, which silently drags every coordinate alphaClipPath/
 * shapeWrapFloats compute (both worked out in the PHOTO's own 0-100%
 * space) out of alignment with where the photo is actually drawn.
 */
export async function naturalAspect(src) {
  try {
    const img = await loadImage(src);
    return img.naturalWidth / img.naturalHeight || null;
  } catch {
    return null;
  }
}

/**
 * Decodes src, downsamples it to TRACE_MAX, and hands back an
 * insideAt(x,y) alpha test over the result plus its w/h — the shared
 * first step of alphaClipPath and shapeWrapFloats, and also how divide.js
 * gets at a photo-shaped item's own region to divide it further. null on
 * any failure along the way (decode, too-small, tainted canvas, fully
 * transparent).
 */
export async function alphaMask(src) {
  let img;
  try {
    img = await loadImage(src);
  } catch {
    return null;
  }
  const scale = Math.min(1, TRACE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  if (w < 3 || h < 3) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // e.g. a tainted canvas — shouldn't happen for our own data URLs, but never throw over this
  }

  let opaqueCount = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= ALPHA_THRESHOLD) opaqueCount++;
  if (opaqueCount === 0) return null; // nothing to clip TO
  // No "already basically a rectangle, skip it" bailout here even when
  // opaqueCount is nearly w*h: a shape that fills most of its own bounding
  // box (a fat leaf, a portrait crop) is exactly the case a caller fitting
  // a DIFFERENT photo against this one's outline (see items.js's "attach
  // link" host, and studio.js's crop frame) most needs a real polygon for
  // — skipping it there silently swaps a leaf-shaped crop frame for a
  // plain rectangular one, with nothing on screen saying so. Tracing a
  // truly full rectangle (opaqueCount === w*h) still just costs a few
  // wasted point-comparisons; it can't come out wrong.

  const insideAt = (x, y) => x >= 0 && x < w && y >= 0 && y < h && data[(y * w + x) * 4 + 3] >= ALPHA_THRESHOLD;
  return { insideAt, w, h };
}

/**
 * Traces insideAt's boundary (over a w×h grid) into a polygon, as an array
 * of [xFrac, yFrac] points (0..1 of w/h) — or null if there's nothing to
 * trace. Works on ANY 0/1 mask, not just an image's alpha channel —
 * divide.js hands this a hand-drawn region, and keeps the raw points
 * (rather than just the formatted string below) to re-rasterize a region
 * that's already the result of one divide for a second one.
 */
export function maskToPolygonPoints(insideAt, w, h) {
  let loop = traceLargestContour(insideAt, w, h);
  if (!loop || loop.length < 3) return null;
  loop = removeCollinear(loop);
  if (loop.length > MAX_POINTS) loop = decimate(loop, MAX_POINTS);
  if (loop.length < 3) return null;
  return loop.map(([x, y]) => [x / w, y / h]);
}

/** Formats maskToPolygonPoints' output as a CSS clip-path polygon() string. */
export function polygonPointsToClipPath(points) {
  return "polygon(" + points.map(([x, y]) => `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`).join(",") + ")";
}

/**
 * The shared core of alphaClipPath: traces insideAt's boundary (over a w×h
 * grid) into a CSS clip-path polygon() string, in percentages of w/h — or
 * null if there's nothing to trace.
 */
export function maskToClipPath(insideAt, w, h) {
  const points = maskToPolygonPoints(insideAt, w, h);
  return points && polygonPointsToClipPath(points);
}

/**
 * The shared core of shapeWrapFloats: samples insideAt's left/right extent
 * over `rows` evenly-spaced rows (over a w×h grid) and turns that into a
 * { left, right } pair of CSS shape-outside polygon() strings — or null if
 * insideAt is empty everywhere. See shapeWrapFloats for the technique
 * itself; this is the mask-based core divide.js also uses directly.
 */
export function maskToWrapFloats(insideAt, w, h, rows = 40) {
  // Leftmost/rightmost "inside" pixel in row py, as a 0..1 fraction of w —
  // or null if the row has nothing inside at all (a gap in the shape).
  const rowExtent = (py) => {
    let left = -1, right = -1;
    for (let x = 0; x < w; x++) {
      if (insideAt(x, py)) {
        if (left === -1) left = x;
        right = x;
      }
    }
    return left === -1 ? null : { left: left / w, right: (right + 1) / w };
  };

  let sawAny = false;
  const rowsSampled = [];
  for (let i = 0; i < rows; i++) {
    const frac = rows === 1 ? 0 : i / (rows - 1);
    const py = Math.min(h - 1, Math.round(frac * (h - 1)));
    const e = rowExtent(py);
    if (e) sawAny = true;
    // A fully empty row (a real gap, or just antialiasing noise at the very
    // tip of the shape) pinches the available width to nothing right there
    // — correct for a genuine gap, and harmless for a stray one-row sliver.
    rowsSampled.push({ frac, left: e ? e.left : 0.5, right: e ? e.right : 0.5 });
  }
  if (!sawAny) return null;

  // A small inward margin so text sits a breath off the traced edge
  // instead of pressed right up against it — same spirit as
  // alphaClipPath's own downsampling, an approximation on top of an
  // approximation, kept small so the shape still reads as the shape.
  const MARGIN = 0.05;

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const toPct = (v) => `${(v * 100).toFixed(2)}%`;
  // Each float spans one half of the box, in its OWN 0..1 local coordinate
  // space (local 0 sits at the box's own edge, local 1 at the midline) —
  // a row's extent (0..1 of the FULL width) has to be re-expressed in
  // that local space, clamped, since the silhouette needn't be symmetric
  // and can lean entirely into one half at a given row (e.g. a leaf's tip).
  //
  // Left float: solid from its own edge (local 0) up to the silhouette's
  // left boundary — text starts right where that boundary is.
  const left = ["0% 0%", "0% 100%"];
  for (let i = rows - 1; i >= 0; i--) {
    const s = rowsSampled[i];
    const localX = clamp01((s.left + MARGIN) / 0.5);
    left.push(`${toPct(localX)} ${toPct(s.frac)}`);
  }
  // Right float: solid from the silhouette's right boundary out to its
  // own edge (local 1) — mirrored, so local 0 is the box's midline.
  const right = ["100% 0%", "100% 100%"];
  for (let i = rows - 1; i >= 0; i--) {
    const s = rowsSampled[i];
    const localX = clamp01(((s.right - MARGIN) - 0.5) / 0.5);
    right.push(`${toPct(localX)} ${toPct(s.frac)}`);
  }
  return { left: `polygon(${left.join(",")})`, right: `polygon(${right.join(",")})` };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

// Every "inside" pixel contributes one boundary edge per side that touches
// an "outside" (or out-of-bounds) neighbor, each in pixel-CORNER
// coordinates and oriented so that walking edge-end → next edge-start
// always continues in the same rotational direction — which is what lets
// them be chained into closed loops just by matching endpoints, no
// direction bookkeeping needed.
function traceLargestContour(inside, w, h) {
  const edges = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) edges.push([x, y, x + 1, y]);         // top
      if (!inside(x + 1, y)) edges.push([x + 1, y, x + 1, y + 1]); // right
      if (!inside(x, y + 1)) edges.push([x + 1, y + 1, x, y + 1]); // bottom
      if (!inside(x - 1, y)) edges.push([x, y + 1, x, y]);         // left
    }
  }
  if (!edges.length) return null;

  const byStart = new Map();
  edges.forEach((e, i) => byStart.set(`${e[0]},${e[1]}`, i));
  const used = new Uint8Array(edges.length);
  const loops = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    const loop = [];
    let cur = i;
    let guard = 0;
    while (cur !== undefined && !used[cur] && guard++ < edges.length + 1) {
      used[cur] = 1;
      const e = edges[cur];
      loop.push([e[0], e[1]]);
      cur = byStart.get(`${e[2]},${e[3]}`);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  if (!loops.length) return null;

  // Keep the loop with the largest enclosed area (shoelace formula) — the
  // dominant blob's outer boundary. A hole inside the shape (its own,
  // opposite-oriented loop) always encloses less area than the outer
  // boundary that contains it, so this naturally ignores holes too.
  let best = null, bestArea = -1;
  for (const loop of loops) {
    let area = 0;
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = loop[i];
      const [x2, y2] = loop[(i + 1) % loop.length];
      area += x1 * y2 - x2 * y1;
    }
    area = Math.abs(area) / 2;
    if (area > bestArea) { bestArea = area; best = loop; }
  }
  return best;
}

// A pixel-grid trace is a staircase — long straight runs collapse to just
// their two endpoints without changing the shape at all.
function removeCollinear(loop) {
  const n = loop.length;
  if (n < 3) return loop;
  const out = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = loop[(i - 1 + n) % n];
    const [x, y] = loop[i];
    const [nx, ny] = loop[(i + 1) % n];
    const cross = (x - px) * (ny - y) - (y - py) * (nx - x);
    if (cross !== 0) out.push([x, y]);
  }
  return out.length >= 3 ? out : loop;
}

function decimate(loop, maxPoints) {
  const step = loop.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(loop[Math.floor(i * step)]);
  return out;
}
