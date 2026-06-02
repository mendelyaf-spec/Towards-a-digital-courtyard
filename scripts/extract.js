// extract.js — pull the shape of a subject out of a photo.
//
// Strategy (fully offline, no model downloads): the background is whatever
// touches the edges of the photo. We flood-fill inward from every border
// pixel, clearing pixels whose colour is within `tolerance` of the sampled
// background. Connected-only fill means colours that also appear inside the
// subject are kept. We then auto-crop to the remaining subject.

const MAX_DIM = 1024; // cap working resolution for speed

/** Load a File/Blob into an ImageBitmap-ish canvas, downscaled if huge. */
export async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
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

/** Average colour of the photo's border ring — our background estimate. */
function sampleBackground(data, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  const take = (i) => { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; };
  for (let x = 0; x < w; x++) {
    take((x) * 4);                    // top row
    take(((h - 1) * w + x) * 4);      // bottom row
  }
  for (let y = 0; y < h; y++) {
    take((y * w) * 4);                // left col
    take((y * w + (w - 1)) * 4);      // right col
  }
  return [r / n, g / n, b / n];
}

/**
 * Returns a NEW canvas with the background removed at the given tolerance.
 * Pure function over the source canvas so the slider can re-run cheaply.
 */
export function removeBackground(srcCanvas, tolerance) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const sctx = srcCanvas.getContext("2d");
  const src = sctx.getImageData(0, 0, w, h);
  const data = src.data;

  const [br, bg, bb] = sampleBackground(data, w, h);
  const tol2 = tolerance * tolerance;

  // Flood fill from the borders.
  const N = w * h;
  const visited = new Uint8Array(N);
  const cleared = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;

  const pushIfBg = (p) => {
    if (visited[p]) return;
    visited[p] = 1;
    const i = p * 4;
    const dr = data[i] - br;
    const dg = data[i + 1] - bg;
    const db = data[i + 2] - bb;
    if (dr * dr + dg * dg + db * db <= tol2) {
      cleared[p] = 1;
      stack[sp++] = p;
    }
  };

  for (let x = 0; x < w; x++) { pushIfBg(x); pushIfBg((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { pushIfBg(y * w); pushIfBg(y * w + w - 1); }

  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) pushIfBg(p - 1);
    if (x < w - 1) pushIfBg(p + 1);
    if (y > 0) pushIfBg(p - w);
    if (y < h - 1) pushIfBg(p + w);
  }

  // Despeckle: the flood-fill can leave scattered specks of background that
  // were just outside tolerance. Label the surviving (kept) pixels into
  // connected blobs and drop any that are tiny relative to the main subject,
  // so we keep the leaf and lose the "static".
  const label = new Int32Array(N);
  const sizes = [0];
  let comp = 0;
  let maxSize = 0;
  for (let p = 0; p < N; p++) {
    if (cleared[p] || label[p]) continue;
    comp++;
    let size = 0;
    let sp2 = 0;
    stack[sp2++] = p;
    label[p] = comp;
    while (sp2 > 0) {
      const q = stack[--sp2];
      size++;
      const x = q % w;
      const y = (q / w) | 0;
      if (x > 0 && !cleared[q - 1] && !label[q - 1]) { label[q - 1] = comp; stack[sp2++] = q - 1; }
      if (x < w - 1 && !cleared[q + 1] && !label[q + 1]) { label[q + 1] = comp; stack[sp2++] = q + 1; }
      if (y > 0 && !cleared[q - w] && !label[q - w]) { label[q - w] = comp; stack[sp2++] = q - w; }
      if (y < h - 1 && !cleared[q + w] && !label[q + w]) { label[q + w] = comp; stack[sp2++] = q + w; }
    }
    sizes[comp] = size;
    if (size > maxSize) maxSize = size;
  }
  // Keep blobs that are a meaningful fraction of the biggest one; clear specks.
  const minBlob = Math.max(16, maxSize * 0.02);
  for (let p = 0; p < N; p++) {
    if (label[p] && sizes[label[p]] < minBlob) cleared[p] = 1;
  }

  // Build output: clear background, find subject bounds.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let p = 0; p < N; p++) {
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

  sctx.putImageData(src, 0, 0);

  if (maxX < minX) {
    // Everything got cleared — return the source untouched as a fallback.
    return srcCanvas;
  }

  // Soften the cut edge by 1px so it doesn't look stamped.
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
  const octx = out.getContext("2d");
  octx.drawImage(srcCanvas, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}
