# magiccut — vendored third-party files

This folder holds the smart-cutout engine's dependencies, vendored so the
app stays a zero-build static site (no CDN, works offline once cached).

| File | What it is | License |
| --- | --- | --- |
| `vendor/ort.min.js`, `vendor/ort-wasm-simd.wasm` | ONNX Runtime Web 1.16.3 (Microsoft) — runs the model in the browser via WebAssembly | MIT |
| `u2netp.onnx` | U²-Net-p salient object detection model (Qin et al., "U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection", Pattern Recognition 2020) — the small 4.5MB variant, as distributed by the rembg project | Apache-2.0 (model), MIT (rembg distribution) |

Sources:
- https://www.npmjs.com/package/onnxruntime-web (1.16.3)
- https://github.com/danielgatis/rembg (model release v0.0.0)
- https://github.com/xuebinqin/U-2-Net
