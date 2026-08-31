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

const TRACE_MAX = 128; // downsample to at most this many px per side before tracing — a clip-path
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

  let loop = traceLargestContour(insideAt, w, h);
  if (!loop || loop.length < 3) return null;
  loop = removeCollinear(loop);
  if (loop.length > MAX_POINTS) loop = decimate(loop, MAX_POINTS);
  if (loop.length < 3) return null;

  return "polygon(" + loop.map(([x, y]) => `${((x / w) * 100).toFixed(2)}% ${((y / h) * 100).toFixed(2)}%`).join(",") + ")";
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
