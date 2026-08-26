// extract.js — pull the shape of a subject out of a photo.
//
// The actual seeing is magiccut's neural segmenter (see magiccut/magiccut.js)
// — a model trained to recognize subjects the way a person does, not a
// color-similarity guess. This module is the plumbing around it: load a
// photo, turn its soft per-pixel mask into a real cutout (feathered alpha,
// despeckled, auto-cropped to the surviving subject), and — for "trace
// around it" — confine that cutout to a hand-drawn loop, which is what lets
// the model isolate ONE thing (a bug) out of several (the leaf it's on).
//
// cropToPath() is the only thing here that doesn't touch the model at all:
// a plain "keep what's inside the loop" crop, used as the honest interim/
// no-model state — never a worse, wrong-looking guess.
//
// Nothing here mutates the source canvas; every function returns a NEW
// canvas (or null if nothing survived), so re-running at a different
// threshold always starts from the original pixels.

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

/**
 * Despeckle: a soft mask can leave scattered flecks of background just
 * above the threshold. Label the surviving pixels into connected blobs and
 * drop any that are tiny relative to the main subject — keep the leaf,
 * lose the static.
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
 * Returns null if nothing survived — the caller decides what that means.
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

/** Rasterize a closed trace into a per-pixel inside mask; null if it encloses nothing. */
function rasterizePathMask(w, h, path) {
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
  const inside = new Uint8Array(w * h);
  let count = 0;
  for (let p = 0; p < w * h; p++) {
    if (mask[p * 4 + 3] > 127) {
      inside[p] = 1;
      count++;
    }
  }
  return count ? inside : null;
}

/** How much of a subject blob must fall inside the traced loop for that
 *  loop to count as "pointing at" it. Deliberately low: the loop says WHICH
 *  thing, so a rough circle that clips the subject's edges still selects the
 *  whole subject — while a background blob that merely grazes the loop is
 *  still rejected. */
const SELECT_OVERLAP = 0.25;

/**
 * Model-driven: cut using a soft subject mask (per-pixel 0..255, from
 * magiccut's neural segmenter). `threshold` (0..255) decides what counts as
 * subject; surviving pixels keep the mask's soft value as their alpha, so
 * edges feather naturally instead of looking stamped — and the alpha only
 * ever gets LOWER than what the source already had, never higher, so
 * re-editing an already-transparent cutout can't paint back opacity that
 * wasn't there.
 *
 * An optional traced `path` SELECTS which subject, rather than clipping to
 * the loop: the mask's connected blobs are found, and the ones the loop
 * actually points at are kept WHOLE — including any part extending past
 * your line. That's the difference between "which of these things do you
 * mean" (what a trace is for) and "cut exactly here" (what pan/zoom is
 * for): circling a leaf roughly gets you the whole leaf, not a leaf with
 * its edges shaved off wherever your hand wobbled inside it.
 *
 * Auto-crops to the surviving subject; returns null if nothing survives.
 * Pure over the source canvas.
 */
export function cutoutFromAlpha(srcCanvas, alpha, threshold, path = null) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const N = w * h;
  const src = srcCanvas.getContext("2d").getImageData(0, 0, w, h);
  const data = src.data;

  const cleared = new Uint8Array(N);
  for (let p = 0; p < N; p++) if (alpha[p] < threshold) cleared[p] = 1;

  if (path) {
    const inside = rasterizePathMask(w, h, path);
    if (!inside) return null; // degenerate loop — same contract as cropToPath
    if (!keepBlobsSelectedBy(cleared, inside, w, h)) return null; // loop pointed at nothing
  }

  for (let p = 0; p < N; p++) {
    if (cleared[p]) continue;
    const a = alpha[p];
    if (a < data[p * 4 + 3]) data[p * 4 + 3] = a; // feathered edge, never MORE opaque than the source
  }
  despeckle(cleared, w, h);
  return buildOutput(srcCanvas, src, cleared, w, h);
}

/**
 * Given a binary subject mask (via `cleared`) and a traced loop's interior,
 * clear every subject blob the loop ISN'T pointing at, keeping the selected
 * ones entire. A blob counts as selected when a meaningful share of it lies
 * inside the loop; if none clears that bar, the single most-overlapped blob
 * wins, so a trace that only nicks the thing still selects it rather than
 * silently selecting nothing. Mutates `cleared`; returns false if the loop
 * caught no subject at all.
 */
function keepBlobsSelectedBy(cleared, inside, w, h) {
  const N = w * h;
  const label = new Int32Array(N);
  const stack = new Int32Array(N);
  const sizes = [0];
  const overlaps = [0];
  let comp = 0;
  for (let p = 0; p < N; p++) {
    if (cleared[p] || label[p]) continue;
    comp++;
    let size = 0;
    let overlap = 0;
    let sp = 0;
    stack[sp++] = p;
    label[p] = comp;
    while (sp > 0) {
      const q = stack[--sp];
      size++;
      if (inside[q]) overlap++;
      const x = q % w;
      const y = (q / w) | 0;
      if (x > 0 && !cleared[q - 1] && !label[q - 1]) { label[q - 1] = comp; stack[sp++] = q - 1; }
      if (x < w - 1 && !cleared[q + 1] && !label[q + 1]) { label[q + 1] = comp; stack[sp++] = q + 1; }
      if (y > 0 && !cleared[q - w] && !label[q - w]) { label[q - w] = comp; stack[sp++] = q - w; }
      if (y < h - 1 && !cleared[q + w] && !label[q + w]) { label[q + w] = comp; stack[sp++] = q + w; }
    }
    sizes[comp] = size;
    overlaps[comp] = overlap;
  }
  if (!comp) return false;

  const keep = new Uint8Array(comp + 1);
  let any = false;
  let best = 0;
  for (let c = 1; c <= comp; c++) {
    if (overlaps[c] > overlaps[best]) best = c;
    if (sizes[c] && overlaps[c] / sizes[c] >= SELECT_OVERLAP) { keep[c] = 1; any = true; }
  }
  if (!any) {
    if (!overlaps[best]) return false; // the loop genuinely touched no subject pixel
    keep[best] = 1;
  }
  for (let p = 0; p < N; p++) if (label[p] && !keep[label[p]]) cleared[p] = 1;
  return true;
}

/**
 * No model involved at all: keep exactly what's inside a traced loop,
 * auto-cropped — the honest "keep everything I circled" result, used while
 * the neural mask is still loading (or unavailable) so the preview is
 * never a worse, wrong-looking guess in the meantime. Returns null for a
 * degenerate trace that encloses nothing (e.g. a straight swipe closes
 * into a zero-area polygon).
 */
export function cropToPath(srcCanvas, path) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const inside = rasterizePathMask(w, h, path);
  if (!inside) return null;
  const src = srcCanvas.getContext("2d").getImageData(0, 0, w, h);
  const cleared = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (!inside[p]) cleared[p] = 1;
  return buildOutput(srcCanvas, src, cleared, w, h);
}
