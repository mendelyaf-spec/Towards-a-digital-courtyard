// extract.js — pull the shape of a subject out of a photo.
//
// Two ways in (fully offline, no model downloads):
//  - removeBackground(): automatic — the background is whatever touches the
//    edges of the photo. We flood-fill inward from every border pixel,
//    clearing pixels that match the sampled background. Works when the
//    subject sits on a fairly uniform ground.
//  - extractWithinPath(): user-guided — the caller hands us a traced outline
//    and everything outside it is discarded outright. The same flood-clean
//    then runs inward FROM THE TRACE LINE, so the ring of background caught
//    between the trace and the subject's true edge clears too — which is
//    what makes a loose finger-trace good enough: you don't have to hug the
//    edge, just loop around the thing through its surroundings.
//
// Both compare pixels against a small PALETTE of sampled background colors,
// not one averaged color. A gravel path is grey AND brown AND near-black at
// once; the average of those is a muddy mid-tone that matches none of them,
// which is why a single-sample approach either leaves background behind or
// needs a tolerance so high it starts eating the subject.
//
// Neither function mutates the source canvas. Recomputing at a LOWER
// tolerance must bring pixels back, so every pass starts from the original
// pixels. (An earlier version wrote cleared alphas onto the source canvas;
// once a pixel vanished at a high setting it silently stayed gone at every
// setting tried after — the "specks that never heal" bug.)

const MAX_DIM = 1024; // cap working resolution for speed

/** Load a File/Blob into an ImageBitmap-ish canvas, downscaled if huge. */
export async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      // Reject with a real Error, not the raw load-failure Event — an event
      // object has no .message, so an unwrapped `rej` here surfaces (if it
      // surfaces at all) as an unhelpful "Event" and can fail silently.
      im.onerror = () => rej(new Error("Couldn't read that image — it may be corrupted or an unsupported format."));
      im.src = url;
    });
    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- shared machinery ----------

/**
 * Up to maxColors representative colors among the given pixel indices —
 * bin at 4 bits per channel, keep the most populous bins, average each.
 */
function samplePalette(data, idxs, maxColors = 8) {
  const bins = new Map();
  for (const p of idxs) {
    const i = p * 4;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    let b = bins.get(key);
    if (!b) bins.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
    b.n++;
    b.r += data[i];
    b.g += data[i + 1];
    b.b += data[i + 2];
  }
  return [...bins.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, maxColors)
    .map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
}

/**
 * Flood-fill from the seed pixels, clearing connected pixels whose color is
 * within tolerance of ANY palette color. visited/cleared are caller-owned so
 * a region can be pre-excluded (marked visited+cleared) before the fill runs.
 */
function floodClear(data, w, h, seeds, pal, tolerance, visited, cleared) {
  const tol2 = tolerance * tolerance;
  const stack = new Int32Array(w * h);
  let sp = 0;
  const tryClear = (p) => {
    if (visited[p]) return;
    visited[p] = 1;
    const i = p * 4;
    for (const c of pal) {
      const dr = data[i] - c[0];
      const dg = data[i + 1] - c[1];
      const db = data[i + 2] - c[2];
      if (dr * dr + dg * dg + db * db <= tol2) {
        cleared[p] = 1;
        stack[sp++] = p;
        return;
      }
    }
  };
  for (const p of seeds) tryClear(p);
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) tryClear(p - 1);
    if (x < w - 1) tryClear(p + 1);
    if (y > 0) tryClear(p - w);
    if (y < h - 1) tryClear(p + w);
  }
}

/**
 * Despeckle: the flood can leave scattered bits of background that were just
 * outside tolerance. Label the surviving pixels into connected blobs and drop
 * any that are tiny relative to the main subject — keep the leaf, lose the
 * static.
 */
function despeckle(cleared, w, h) {
  const N = w * h;
  const label = new Int32Array(N);
  const stack = new Int32Array(N);
  const sizes = [0];
  let comp = 0;
  let maxSize = 0;
  for (let p = 0; p < N; p++) {
    if (cleared[p] || label[p]) continue;
    comp++;
    let size = 0;
    let sp = 0;
    stack[sp++] = p;
    label[p] = comp;
    while (sp > 0) {
      const q = stack[--sp];
      size++;
      const x = q % w;
      const y = (q / w) | 0;
      if (x > 0 && !cleared[q - 1] && !label[q - 1]) { label[q - 1] = comp; stack[sp++] = q - 1; }
      if (x < w - 1 && !cleared[q + 1] && !label[q + 1]) { label[q + 1] = comp; stack[sp++] = q + 1; }
      if (y > 0 && !cleared[q - w] && !label[q - w]) { label[q - w] = comp; stack[sp++] = q - w; }
      if (y < h - 1 && !cleared[q + w] && !label[q + w]) { label[q + w] = comp; stack[sp++] = q + w; }
    }
    sizes[comp] = size;
    if (size > maxSize) maxSize = size;
  }
  const minBlob = Math.max(16, maxSize * 0.02);
  for (let p = 0; p < N; p++) {
    if (label[p] && sizes[label[p]] < minBlob) cleared[p] = 1;
  }
}

/**
 * Build the output: cleared pixels go transparent (on a COPY — the source
 * canvas is never touched), then auto-crop to the surviving subject.
 * Returns null if nothing survived (empty result) — up to the caller to
 * decide what that means; auto mode falls back to the untouched source
 * (see removeBackground), but a caller with its own idea of a safe
 * fallback (extractWithinPath) should use this instead of assuming.
 */
function buildOutput(srcCanvas, src, cleared, w, h) {
  const data = src.data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let p = 0; p < w * h; p++) {
    if (cleared[p]) {
      data[p * 4 + 3] = 0;
    } else {
      const x = p % w;
      const y = (p / w) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return null; // nothing survived
  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  full.getContext("2d").putImageData(src, 0, 0);

  // Soften the cut edge by a couple of pixels so it doesn't look stamped.
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(full, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}

// ---------- the two extractors ----------

/**
 * Automatic: returns a NEW canvas with the border-connected background
 * removed at the given tolerance. Pure over the source canvas, so the
 * slider can re-run it cheaply — and reversibly.
 */
export function removeBackground(srcCanvas, tolerance) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const src = srcCanvas.getContext("2d").getImageData(0, 0, w, h);

  const border = [];
  for (let x = 0; x < w; x++) { border.push(x); border.push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { border.push(y * w); border.push(y * w + w - 1); }

  const pal = samplePalette(src.data, border);
  const visited = new Uint8Array(w * h);
  const cleared = new Uint8Array(w * h);
  floodClear(src.data, w, h, border, pal, tolerance, visited, cleared);
  despeckle(cleared, w, h);
  // Tolerance ate everything — fall back to the untouched photo, which for
  // auto mode is the honest degraded answer ("couldn't separate anything").
  return buildOutput(srcCanvas, src, cleared, w, h) || srcCanvas;
}

/**
 * User-guided: keep only what's inside the traced outline (an array of
 * [x, y] points in source-canvas coordinates), then flood-clean inward from
 * the trace line at the given tolerance — so the background caught between
 * a loose trace and the subject's true edge clears too. A tolerance of 0
 * skips the clean entirely: a literal "keep everything I circled" crop.
 *
 * Returns null for a degenerate trace that encloses nothing (a straight
 * swipe closes into a zero-area polygon) — the caller should treat that as
 * "no trace", never as a result. And whatever the tolerance, the output can
 * never regress past the loop itself: if the clean eats everything inside,
 * the result falls back to the plain tolerance-0 crop — NOT the full photo,
 * which would silently un-cut everything outside the line.
 */
export function extractWithinPath(srcCanvas, path, tolerance) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const src = srcCanvas.getContext("2d").getImageData(0, 0, w, h);

  // Rasterize the closed trace into an inside/outside mask.
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext("2d");
  mctx.fillStyle = "#fff";
  mctx.beginPath();
  path.forEach((pt, i) => (i ? mctx.lineTo(pt[0], pt[1]) : mctx.moveTo(pt[0], pt[1])));
  mctx.closePath();
  mctx.fill();
  const mask = mctx.getImageData(0, 0, w, h).data;

  const N = w * h;
  const visited = new Uint8Array(N);
  const cleared = new Uint8Array(N);
  const inside = new Uint8Array(N);
  let insideCount = 0;
  for (let p = 0; p < N; p++) {
    if (mask[p * 4 + 3] > 127) { inside[p] = 1; insideCount++; }
    else { visited[p] = 1; cleared[p] = 1; } // outside the trace: gone, and the flood never crosses it
  }
  if (!insideCount) return null; // the loop enclosed nothing at all

  // Seed ring: inside pixels that touch the outside (or the image edge) —
  // i.e. the pixels lying directly under the drawn trace line.
  const ring = [];
  for (let p = 0; p < N; p++) {
    if (!inside[p]) continue;
    const x = p % w;
    const y = (p / w) | 0;
    if (
      x === 0 || x === w - 1 || y === 0 || y === h - 1 ||
      !inside[p - 1] || !inside[p + 1] || !inside[p - w] || !inside[p + w]
    ) ring.push(p);
  }

  if (ring.length && tolerance > 0) {
    const pal = samplePalette(src.data, ring);
    floodClear(src.data, w, h, ring, pal, tolerance, visited, cleared);
    despeckle(cleared, w, h);
    const out = buildOutput(srcCanvas, src, cleared, w, h);
    if (out) return out;
    // The clean ate everything inside the loop — degrade to the plain crop.
    // Rebuild state (buildOutput zeroed alphas on `src`'s data) from scratch.
    const src2 = srcCanvas.getContext("2d").getImageData(0, 0, w, h);
    const cleared2 = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (!inside[p]) cleared2[p] = 1;
    return buildOutput(srcCanvas, src2, cleared2, w, h);
  }
  return buildOutput(srcCanvas, src, cleared, w, h);
}
