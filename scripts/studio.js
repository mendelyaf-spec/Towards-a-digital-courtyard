// studio.js — the cut-out modal.
// Stage 1 extracts the subject, two ways: "auto" clears whatever touches the
// photo's edges (good on plain backgrounds), and "trace around it" lets you
// draw a loop around the one thing you want — everything outside the loop is
// cut away, and the sensitivity slider then cleans the background caught
// INSIDE the loop, working inward from your line. That's the tool for a
// casual phone photo: a leaf on gravel next to a stick, a bug sitting on a
// leaf — loop the thing you're after and slide until only it remains.
//
// Stage 2 always follows — pan/zoom/rotate to choose exactly what you're
// about to place, with a preview/back-to-edit loop, BEFORE anything commits.
// Two flavors, picked via open()'s `position` option:
//   - 'background': the frame is fixed at background.js's own region size
//     (320x240) and the chosen pan/zoom/rotate is handed back as data
//     (imgScale/imgRotate/imgOffsetX/imgOffsetY) for the placed region to
//     keep applying live — non-destructive, still adjustable afterward via
//     the background bar, exactly as before.
//   - 'item': for a regular canvas photo or a link's thumbnail. The frame
//     matches the cutout's own aspect ratio, and what you chose gets BAKED
//     into the exported image itself — the placed item is just that image,
//     opacity still adjustable, no separate zoom/rotate left to fiddle with
//     afterward. What you picked before placing is what you get.

import { fileToCanvas, removeBackground, extractWithinPath } from "./extract.js";

const FRAME_W = 320, FRAME_H = 240; // 'background' mode's frame size — must match
// background.js's default region size, so a pixel of drag here means the
// same offset there.
const BAKE_MAX = 420; // 'item' mode's frame/output long edge, in native px

export class Studio {
  constructor() {
    this.el = document.getElementById("studio");
    this.canvas = document.getElementById("studioCanvas");
    this.tolerance = document.getElementById("tolerance");
    this.toleranceLabel = document.getElementById("studioToleranceLabel");
    this.cutoutStage = document.getElementById("studioCutoutStage");
    this.cutoutHint = document.getElementById("studioCutoutHint");
    this.previewBox = document.getElementById("studioPreviewBox");
    this.modeAutoBtn = document.getElementById("studioModeAuto");
    this.modeTraceBtn = document.getElementById("studioModeTrace");
    this.retraceBtn = document.getElementById("studioRetrace");
    this.cancelBtn = document.getElementById("studioCancel");
    this.nextBtn = document.getElementById("studioNext");

    this.positionStage = document.getElementById("studioPositionStage");
    this.positionHint = document.getElementById("studioPositionHint");
    this.frame = document.getElementById("studioFrame");
    this.frameImg = document.getElementById("studioFrameImg");
    this.zoomInput = document.getElementById("studioZoom");
    this.rotateInput = document.getElementById("studioRotate");
    this.posBackBtn = document.getElementById("studioPosBack");
    this.posNextBtn = document.getElementById("studioPosNext");

    this.source = null;   // downscaled source canvas
    this.result = null;   // current cut-out canvas
    this.onPlace = null;  // callback(dataURL, w, h, pos|null) — pos only ever set in 'background' mode
    this.onCancel = null; // callback() — fired if closed WITHOUT committing (cancel, backdrop, or a load error)
    this.positionMode = "item"; // 'background' | 'item' — see file header
    this.placeLabel = "place on canvas"; // stage 2's final button text once previewing
    this.previewing = false;
    this.pos = { scale: 1, rotate: 0, offsetX: 0, offsetY: 0 };
    this.frameNativeW = FRAME_W; // the frame's logical size — fixed for 'background', per-photo for 'item'
    this.frameNativeH = FRAME_H;
    this.frameScale = 1; // the frame's actual on-screen size can be smaller than frameNativeW on a narrow viewport
    this.mode = "auto";   // 'auto' | 'trace'
    this.tracePath = null; // completed trace, [[x,y]…] in source-canvas coords
    this._drawPath = null; // trace being drawn right now

    this.tolerance.addEventListener("input", () => this._recompute());
    this.cancelBtn.addEventListener("click", () => this.close());
    this.nextBtn.addEventListener("click", () => this._toPosition());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });
    this.modeAutoBtn.addEventListener("click", () => this._setMode("auto"));
    this.modeTraceBtn.addEventListener("click", () => this._setMode("trace"));
    this.retraceBtn.addEventListener("click", () => {
      this.tracePath = null;
      this._recompute();
    });
    this._wireTraceDraw();

    this.zoomInput.addEventListener("input", () => {
      this.pos.scale = this.zoomInput.value / 100;
      this._renderFrame();
    });
    this.rotateInput.addEventListener("input", () => {
      this.pos.rotate = Number(this.rotateInput.value);
      this._renderFrame();
    });
    this.posBackBtn.addEventListener("click", () => {
      if (this.previewing) this._setPreviewing(false);
      else this._toCutout();
    });
    this.posNextBtn.addEventListener("click", () => {
      if (this.previewing) this._commit();
      else this._setPreviewing(true);
    });
    this._wireFrameDrag();
  }

  /** @param {{position?: 'background'|'item', placeLabel?: string}} opts */
  async open(file, onPlace, onCancel, { position = "item", placeLabel } = {}) {
    this.onPlace = onPlace;
    this.onCancel = onCancel || null;
    this.positionMode = position;
    this.placeLabel = placeLabel || (position === "background" ? "paste on canvas" : "place on canvas");
    try {
      this.source = await fileToCanvas(file);
    } catch (err) {
      console.error(err);
      alert(err.message || "Couldn't open that photo.");
      const cb = this.onCancel;
      this.onPlace = null;
      this.onCancel = null;
      cb?.(); // never got as far as showing the modal — still counts as "not committed"
      return;
    }
    this._toCutout();
    this._setMode("auto"); // every photo starts in auto; trace state never carries between photos
    this.el.hidden = false;
  }

  close() {
    this.el.hidden = true;
    this.source = null;
    this.result = null;
    const cb = this.onCancel;
    this.onPlace = null;
    this.onCancel = null;
    cb?.();
  }

  _setMode(mode) {
    this.mode = mode;
    this.tracePath = null;
    this._drawPath = null;
    this.modeAutoBtn.classList.toggle("is-on", mode === "auto");
    this.modeTraceBtn.classList.toggle("is-on", mode === "trace");
    this._recompute();
  }

  _recompute() {
    if (!this.source) return;
    if (this.mode === "auto") {
      this.result = removeBackground(this.source, Number(this.tolerance.value));
    } else if (this.tracePath) {
      // At the slider's minimum the promise is literal — keep EVERYTHING
      // circled, no clean-up — so pass 0 rather than the min value itself.
      const tol = Number(this.tolerance.value);
      this.result = extractWithinPath(this.source, this.tracePath, tol <= Number(this.tolerance.min) ? 0 : tol);
    } else {
      this.result = null; // trace mode, nothing drawn yet — showing the raw photo to trace on
    }
    this._syncStage1();
    this._renderPreview();
  }

  _syncStage1() {
    const tracing = this.mode === "trace" && !this.tracePath;
    this.previewBox.classList.toggle("is-tracing", tracing);
    this.retraceBtn.hidden = !(this.mode === "trace" && this.tracePath);
    this.nextBtn.disabled = !this.result;
    this.toleranceLabel.textContent = this.mode === "auto" ? "background sensitivity" : "clean-up strength";
    this.cutoutHint.textContent =
      this.mode === "auto"
        ? "We trace the subject by clearing away the background. Drag the slider until the edges look right."
        : tracing
          ? "Draw a loop around the one thing you want — everything outside your line is cut away."
          : "Slide to clear the background caught inside your loop — all the way left keeps everything you circled.";
  }

  // Draws whatever stage 1 should currently show: the finished cut-out, or
  // (in trace mode, pre-trace) the raw photo with the in-progress loop on top.
  _renderPreview() {
    const view = this.result || this.source;
    if (!view) return;
    this.canvas.width = view.width;
    this.canvas.height = view.height;
    const ctx = this.canvas.getContext("2d");
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(view, 0, 0);
    if (!this.result && this._drawPath && this._drawPath.length > 1) {
      // Stroke width in canvas px that reads as ~3 screen px at any display scale.
      const rect = this.canvas.getBoundingClientRect();
      const lw = 3 * (this.canvas.width / (rect.width || this.canvas.width));
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      this._drawPath.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
      ctx.strokeStyle = "rgba(255,255,255,.95)";
      ctx.lineWidth = lw * 1.8;
      ctx.stroke();
      ctx.strokeStyle = "#b07d4b";
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }

  _canvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) * this.canvas.width) / (rect.width || 1);
    const y = ((e.clientY - rect.top) * this.canvas.height) / (rect.height || 1);
    return [
      Math.max(0, Math.min(this.canvas.width, x)),
      Math.max(0, Math.min(this.canvas.height, y)),
    ];
  }

  _wireTraceDraw() {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (this.mode !== "trace" || this.tracePath || !this.source) return;
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this._drawPath = [this._canvasPoint(e)];
      const onMove = (ev) => {
        const pt = this._canvasPoint(ev);
        const last = this._drawPath[this._drawPath.length - 1];
        if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 3) return;
        this._drawPath.push(pt);
        this._renderPreview();
      };
      const onUp = (ev) => {
        this.canvas.releasePointerCapture(ev.pointerId);
        this.canvas.removeEventListener("pointermove", onMove);
        this.canvas.removeEventListener("pointerup", onUp);
        const path = this._drawPath;
        this._drawPath = null;
        // Only accept a real loop — a stray tap or tiny scribble just resets.
        if (path && path.length >= 12) {
          const xs = path.map((p) => p[0]);
          const ys = path.map((p) => p[1]);
          if (Math.max(...xs) - Math.min(...xs) >= 24 && Math.max(...ys) - Math.min(...ys) >= 24) {
            this.tracePath = path;
          }
        }
        this._recompute();
      };
      this.canvas.addEventListener("pointermove", onMove);
      this.canvas.addEventListener("pointerup", onUp);
    });
  }

  _toCutout() {
    this.cutoutStage.hidden = false;
    this.positionStage.hidden = true;
  }

  // Stage 1 → stage 2. Always — every photo/thumbnail gets to choose its
  // crop before anything commits, not just backgrounds.
  _toPosition() {
    if (!this.onPlace) return this.close();
    if (!this.result) return; // trace mode with nothing drawn yet — the button is disabled, but never close-and-lose here
    this.pos = { scale: 1, rotate: 0, offsetX: 0, offsetY: 0 };
    this.zoomInput.value = 100;
    this.rotateInput.value = 0;
    if (this.positionMode === "background") {
      this.frameNativeW = FRAME_W;
      this.frameNativeH = FRAME_H;
    } else {
      // Match the cutout's own aspect ratio — an organic cutout's shape
      // matters (a tall leaf needs a tall frame), unlike a background
      // region which is always the same fixed rectangle.
      const ratio = this.result.width / this.result.height;
      this.frameNativeW = ratio >= 1 ? BAKE_MAX : Math.round(BAKE_MAX * ratio);
      this.frameNativeH = ratio >= 1 ? Math.round(BAKE_MAX / ratio) : BAKE_MAX;
    }
    this.frame.style.aspectRatio = `${this.frameNativeW} / ${this.frameNativeH}`;
    this.frameImg.src = this.result.toDataURL("image/png");
    this.cutoutStage.hidden = true;
    this.positionStage.hidden = false;
    this.frameScale = (this.frame.clientWidth || this.frameNativeW) / this.frameNativeW;
    this._setPreviewing(false);
    this._renderFrame();
  }

  _setPreviewing(on) {
    this.previewing = on;
    this.positionStage.classList.toggle("is-previewing", on);
    this.posBackBtn.textContent = on ? "‹ back to edit" : "‹ back to cutout";
    this.posNextBtn.textContent = on ? this.placeLabel : "preview →";
    this.positionHint.textContent = on
      ? "This is exactly what you're about to place. Go back to adjust it more, or use it as is."
      : "Drag the photo to reposition it, zoom and rotate to choose what shows.";
  }

  _renderFrame() {
    const { scale, rotate, offsetX, offsetY } = this.pos;
    this.frameImg.style.transform = `translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px) rotate(${rotate}deg) scale(${scale})`;
  }

  _wireFrameDrag() {
    this.frame.addEventListener("pointerdown", (e) => {
      if (this.previewing || this.positionStage.hidden) return;
      this.frame.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, ox: this.pos.offsetX, oy: this.pos.offsetY };
      const onMove = (ev) => {
        this.pos.offsetX = start.ox + (ev.clientX - start.x) / this.frameScale;
        this.pos.offsetY = start.oy + (ev.clientY - start.y) / this.frameScale;
        this._renderFrame();
      };
      const onUp = (ev) => {
        this.frame.releasePointerCapture(ev.pointerId);
        this.frame.removeEventListener("pointermove", onMove);
        this.frame.removeEventListener("pointerup", onUp);
      };
      this.frame.addEventListener("pointermove", onMove);
      this.frame.addEventListener("pointerup", onUp);
    });
  }

  // 'item' mode only: render the chosen pan/zoom/rotate onto a new canvas at
  // the frame's own native size — replicating the CSS transform on
  // frameImg exactly (same translate/rotate/scale, same centering), so the
  // baked pixels match what stage 2 actually showed.
  _bakePosition() {
    const { scale, rotate, offsetX, offsetY } = this.pos;
    const w = this.frameNativeW, h = this.frameNativeH;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.translate(w / 2 + offsetX, h / 2 + offsetY);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.scale(scale, scale);
    // At scale 1 with no pan/rotate, the source exactly fills w×h (the frame
    // was sized to the source's own aspect ratio) — same as object-fit:cover
    // does for frameImg when the aspect ratio already matches.
    ctx.drawImage(this.result, -w / 2, -h / 2, w, h);
    return canvas;
  }

  _commit() {
    if (!this.result || !this.onPlace) return this.close();
    let dataURL, w, h, pos = null;
    if (this.positionMode === "item") {
      const canvas = this._bakePosition();
      dataURL = canvas.toDataURL("image/png");
      w = canvas.width;
      h = canvas.height;
    } else {
      dataURL = this.result.toDataURL("image/png");
      w = this.result.width;
      h = this.result.height;
      pos = { ...this.pos };
    }
    const onPlace = this.onPlace;
    this.onPlace = null;
    this.onCancel = null; // committed — close() below shouldn't also fire cancel
    this.close();
    onPlace(dataURL, w, h, pos);
  }
}
