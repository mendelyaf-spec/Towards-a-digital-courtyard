// magiccut/magiccut.js — the smart cutout engine.
//
// Runs U²-Net-p, the neural network behind most "remove background" tools
// (rembg and the web services built on it), entirely in the browser via
// ONNX Runtime's WebAssembly backend. Unlike the color-based flood fill in
// scripts/extract.js, the model was trained on tens of thousands of real
// photos to see subjects the way a person does — a leaf on gravel is a
// leaf, not "pixels that differ from the border colors".
//
// Everything is vendored (see LICENSES.md): no CDN, no API, no network
// beyond fetching our own files, which the service worker then caches like
// any other asset. ~16MB total, loaded lazily the first time a photo is
// opened for cutting — never on app boot.
//
// Every entry point degrades gracefully: if the runtime or model can't
// load (first visit while offline, ancient browser without WASM SIMD),
// callers get null and fall back to the classical extractor, which is the
// exact behavior the app had before this engine existed.

const MODEL_SIZE = 320; // u2netp's fixed input resolution

let ortLoading = null;    // promise for the <script> that defines window.ort
let sessionLoading = null; // promise resolving to the InferenceSession, or null on any failure

function loadOrtScript() {
  if (window.ort) return Promise.resolve();
  if (ortLoading) return ortLoading;
  ortLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "magiccut/vendor/ort.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load the cutout runtime"));
    document.head.appendChild(s);
  });
  return ortLoading;
}

/**
 * Lazily load the runtime + model. Resolves to the session, or null if the
 * smart cutout isn't available in this browser/session — callers should
 * fall back to the classical extractor on null, never throw at the user.
 */
export function loadSegmenter() {
  if (sessionLoading) return sessionLoading;
  sessionLoading = (async () => {
    try {
      await loadOrtScript();
      const ort = window.ort;
      ort.env.wasm.wasmPaths = "magiccut/vendor/";
      ort.env.wasm.numThreads = 1; // threaded wasm needs cross-origin isolation headers static hosts don't send
      const resp = await fetch("magiccut/u2netp.onnx");
      if (!resp.ok) throw new Error(`model fetch: HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      return await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
    } catch (err) {
      console.warn("Smart cutout unavailable — falling back to the classical extractor.", err);
      return null;
    }
  })();
  return sessionLoading;
}

/**
 * Soft subject mask for a canvas: resolves to a Uint8ClampedArray of
 * width*height alpha values (0 = background, 255 = subject), or null if
 * the model isn't available. Pure over the input canvas.
 */
export async function subjectAlpha(canvas) {
  const session = await loadSegmenter();
  if (!session) return null;
  const ort = window.ort;
  const S = MODEL_SIZE;

  // Squash to the model's input size (same approach as rembg) and
  // normalize with the ImageNet mean/std the network was trained with.
  const small = document.createElement("canvas");
  small.width = S;
  small.height = S;
  const sctx = small.getContext("2d");
  sctx.drawImage(canvas, 0, 0, S, S);
  const d = sctx.getImageData(0, 0, S, S).data;
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    input[i] = (d[i * 4] / 255 - 0.485) / 0.229;
    input[S * S + i] = (d[i * 4 + 1] / 255 - 0.456) / 0.224;
    input[2 * S * S + i] = (d[i * 4 + 2] / 255 - 0.406) / 0.225;
  }

  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, S, S]) };
  const outputs = await session.run(feeds);
  const raw = outputs[session.outputNames[0]].data; // fused saliency map, S*S floats

  // Normalize to the map's own range (standard for u2net — its raw output
  // isn't guaranteed to span 0..1) and paint into a small grayscale canvas.
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < mn) mn = raw[i];
    if (raw[i] > mx) mx = raw[i];
  }
  const span = mx - mn || 1;
  const maskImg = sctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = Math.round(((raw[i] - mn) / span) * 255);
    const o = i * 4;
    maskImg.data[o] = v;
    maskImg.data[o + 3] = 255;
  }
  const maskSmall = document.createElement("canvas");
  maskSmall.width = S;
  maskSmall.height = S;
  maskSmall.getContext("2d").putImageData(maskImg, 0, 0);

  // Upsample smoothly back to the source's resolution and read one channel.
  const w = canvas.width, h = canvas.height;
  const up = document.createElement("canvas");
  up.width = w;
  up.height = h;
  const uctx = up.getContext("2d");
  uctx.imageSmoothingEnabled = true;
  uctx.imageSmoothingQuality = "high";
  uctx.drawImage(maskSmall, 0, 0, w, h);
  const upData = uctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8ClampedArray(w * h);
  for (let p = 0; p < w * h; p++) alpha[p] = upData[p * 4];
  return alpha;
}
