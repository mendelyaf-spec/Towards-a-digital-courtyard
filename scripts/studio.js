// studio.js — the cut-out modal.
//
// Stage 1 answers "what do you want out of this photo?", and there are
// exactly three honest answers, one per mode:
//   'auto'  — cut out the main subject. The model decides what that is.
//   'trace' — several candidates in frame; circle the one you mean. The
//             loop SELECTS a subject, it does not clip to your line: the
//             chosen thing comes out whole even where your rough circle
//             cut through it (see extract.js's cutoutFromAlpha). "Which
//             one", not "cut exactly here".
//   'whole' — don't cut anything out. Keep the photo as a rectangle; pick
//             the part you want by panning/zooming in stage 2. That's the
//             answer whenever you want a SECTION rather than an object.
// The first two are powered by the neural segmenter in magiccut/ — the
// same U²-Net family model behind the background-removal tools people
// actually use. The slider re-thresholds the model's cached mask, so
// dragging it is cheap: inference runs once per photo (or per trace), not
// per tick. While that one inference is in flight — or if the model can't
// load at all (first visit offline, no-WASM browser) — the preview shows
// the honest un-refined state instead of a worse guess: the untouched
// photo in auto mode, or a plain "everything inside the loop" crop in
// trace mode (extract.js's cropToPath, no model involved) — never blocking
// forever, and never showing something that looks wrong.
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

import { fileToCanvas, cutoutFromAlpha, cropToPath } from "./extract.js";
import { subjectAlpha } from "../magiccut/magiccut.js";

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
    this.modeWholeBtn = document.getElementById("studioModeWhole");
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
    this.mode = "auto";   // 'auto' | 'trace' | 'whole' — see the file header
    this.tracePath = null; // completed trace, [[x,y]…] in source-canvas coords
    this._drawPath = null; // trace being drawn right now

    // Smart cutout bookkeeping: ONE model inference per (photo, trace),
    // cached; the slider only re-thresholds the cached mask. Keys change
    // whenever the photo or the accepted trace changes, so an inference
    // resolving late for an abandoned state is recognized as stale and
    // dropped instead of overwriting a newer preview.
    this._photoSeq = 0;
    this._traceSeq = 0;
    this._ai = { key: null, alpha: null, pending: null, failedKey: null };
    this._aiActive = false; // whether the current preview came from the model

    // Coalesce to one recompute per frame: a slider drag fires input events
    // faster than the (full-image) extraction runs, and queuing one pass per
    // event just piles up main-thread work and garbage mid-drag.
    this._recomputeQueued = false;
    this.tolerance.addEventListener("input", () => {
      if (this._recomputeQueued) return;
      this._recomputeQueued = true;
      requestAnimationFrame(() => {
        this._recomputeQueued = false;
        this._recompute();
      });
    });
    this.cancelBtn.addEventListener("click", () => this.close());
    this.nextBtn.addEventListener("click", () => this._toPosition());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });
    this.modeAutoBtn.addEventListener("click", () => this._setMode("auto"));
    this.modeTraceBtn.addEventListener("click", () => this._setMode("trace"));
    this.modeWholeBtn.addEventListener("click", () => this._setMode("whole"));
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
      else if (this._skipCutout) this.close(); // no cutout stage to go back to — this IS the first stage
      else this._toCutout();
    });
    this.posNextBtn.addEventListener("click", () => {
      if (this.previewing) this._commit();
      else this._setPreviewing(true);
    });
    this._wireFrameDrag();
  }

  /** @param {{position?: 'background'|'item', placeLabel?: string, skipCutout?: boolean}} opts
   *  skipCutout — for a thumbnail: pulling a subject's SHAPE out of its
   *  background makes no sense for a small preview photo (there's nothing
   *  to "cut out" of a screenshot), so this bypasses stage 1 entirely and
   *  goes straight to stage 2 with the photo exactly as uploaded — only
   *  cropping/zooming/rotating is offered, never subject extraction. */
  async open(file, onPlace, onCancel, { position = "item", placeLabel, skipCutout = false } = {}) {
    this.onPlace = onPlace;
    this.onCancel = onCancel || null;
    this.positionMode = position;
    this.placeLabel = placeLabel || (position === "background" ? "paste on canvas" : "place on canvas");
    this._skipCutout = skipCutout;
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
    this._photoSeq++;
    this._ai = { key: null, alpha: null, pending: null, failedKey: null };
    if (skipCutout) {
      this.result = this.source;
      this.el.hidden = false; // must be visible before _toPosition reads the frame's on-screen size
      this._toPosition();
    } else {
      this._toCutout();
      this._setMode("auto"); // every photo starts in auto; trace state never carries between photos
      this.el.hidden = false;
    }
  }

  close() {
    this.el.hidden = true;
    this.source = null;
    this.result = null;
    this._drawPath = null; // abandon any half-drawn trace with the modal
    this.tracePath = null;
    this._ai = { key: null, alpha: null, pending: null, failedKey: null }; // in-flight inference is dropped as stale on arrival
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
    this.modeWholeBtn.classList.toggle("is-on", mode === "whole");
    this._recompute();
  }

  // Which cached model mask (if any) applies to the current state. 'whole'
  // never runs the model at all — there's nothing to segment.
  _aiKey() {
    if (this.mode === "auto") return `p${this._photoSeq}:auto`;
    if (this.mode === "trace" && this.tracePath) return `p${this._photoSeq}:trace${this._traceSeq}`;
    return null;
  }

  _recompute() {
    if (!this.source) return;
    const tol = Number(this.tolerance.value);
    // Slider → mask threshold for the model path: min keeps nearly every
    // pixel the model considers faintly subject-like, max cuts tight.
    const aiThr = Math.round(10 + (tol / (Number(this.tolerance.max) || 120)) * 200);
    const key = this._aiKey();
    const cached = key && this._ai.key === key ? this._ai.alpha : null;
    this._aiActive = false;
    this.result = null;

    if (this.mode === "whole") {
      // Nothing to extract — the photo IS the answer. Stage 2's pan/zoom
      // is where you pick which part of it you actually want.
      this.result = this.source;
    } else if (this.mode === "auto") {
      if (cached) {
        this.result = cutoutFromAlpha(this.source, cached, aiThr);
        this._aiActive = !!this.result;
        // The model DID produce a mask, but nothing survives at THIS
        // threshold (possible at the high end, or for a near-featureless
        // photo where the mask barely varies) — never get stuck on a null
        // result just because the current slider position is too tight.
        if (!this.result) this.result = this.source;
      } else if (this._ai.failedKey === key) {
        // Model unavailable for this photo — proceed with the whole,
        // uncut photo rather than leaving the user stuck. They can still
        // crop it by hand in the next step (pan/zoom), or switch to "keep
        // whole photo", which never needed the model in the first place.
        this.result = this.source;
      } else {
        this._ensureAi(key);
      }
    } else if (this.tracePath) {
      // At the slider's minimum the promise is literal — keep EVERYTHING
      // circled, no model, no clean-up.
      const literalKeepAll = tol <= Number(this.tolerance.min);
      if (!literalKeepAll && cached) {
        this.result = cutoutFromAlpha(this.source, cached, aiThr, this.tracePath);
        this._aiActive = !!this.result;
      }
      if (!this.result) {
        // Honest interim/no-model state: exactly what's inside the loop,
        // no refinement — never a worse or wrong-looking guess.
        this.result = cropToPath(this.source, this.tracePath);
        if (!this.result) this.tracePath = null; // the loop enclosed nothing (e.g. a straight swipe) — back to drawing
      }
      if (!literalKeepAll && !cached && this.tracePath && this._ai.failedKey !== this._aiKey()) {
        this._ensureAi(this._aiKey());
      }
    } else {
      this.result = null; // trace mode, nothing drawn yet — showing the raw photo to trace on
    }
    this._syncStage1();
    this._renderPreview();
  }

  // Run the model once for the current (photo, trace) and cache its mask.
  // Everything is captured up front so a result landing after the user moved
  // on (new photo, new trace, modal closed) is detected and dropped.
  _ensureAi(key) {
    if (!key || this._ai.pending === key || this._ai.failedKey === key || (this._ai.key === key && this._ai.alpha)) return;
    this._ai.pending = key;
    const source = this.source;
    const path = this.mode === "trace" ? this.tracePath : null;
    (async () => {
      let alpha = null;
      try {
        if (!path) {
          alpha = await subjectAlpha(source);
        } else {
          // Crop to the loop's neighborhood so the model sees the circled
          // thing as THE subject of its little image — that's what pulls a
          // bug off the leaf it sits on — then paste the mask back into a
          // full-size, zero-elsewhere alpha for the loop intersection.
          const xs = path.map((p) => p[0]);
          const ys = path.map((p) => p[1]);
          const margin = 24;
          const x0 = Math.max(0, Math.floor(Math.min(...xs)) - margin);
          const y0 = Math.max(0, Math.floor(Math.min(...ys)) - margin);
          const x1 = Math.min(source.width, Math.ceil(Math.max(...xs)) + margin);
          const y1 = Math.min(source.height, Math.ceil(Math.max(...ys)) + margin);
          const cw = x1 - x0;
          const ch = y1 - y0;
          if (cw >= 8 && ch >= 8) {
            const crop = document.createElement("canvas");
            crop.width = cw;
            crop.height = ch;
            crop.getContext("2d").drawImage(source, x0, y0, cw, ch, 0, 0, cw, ch);
            const cropAlpha = await subjectAlpha(crop);
            if (cropAlpha) {
              alpha = new Uint8ClampedArray(source.width * source.height);
              for (let y = 0; y < ch; y++) {
                alpha.set(cropAlpha.subarray(y * cw, y * cw + cw), (y0 + y) * source.width + x0);
              }
            }
          }
        }
      } catch (err) {
        console.warn("Smart cutout unavailable for this photo.", err);
      }
      if (this._ai.pending === key) this._ai.pending = null;
      if (this.source !== source || this._aiKey() !== key) return; // stale — a newer state owns the preview now
      if (!alpha) {
        // Model unavailable/failed for THIS state: remember so the next
        // recompute doesn't immediately re-kick it (that would loop), and
        // refresh once so the "sharpening…" hint clears.
        this._ai.failedKey = key;
        this._recompute();
        return;
      }
      this._ai = { key, alpha, pending: null, failedKey: null };
      this._recompute();
    })();
  }

  _syncStage1() {
    const tracing = this.mode === "trace" && !this.tracePath;
    this.previewBox.classList.toggle("is-tracing", tracing);
    this.retraceBtn.hidden = !(this.mode === "trace" && this.tracePath);
    this.nextBtn.disabled = !this.result;

    const key = this._aiKey();
    const aiRan = !!(key && this._ai.key === key && this._ai.alpha); // the model produced A mask for this state
    const aiState = this._aiActive ? "active" : aiRan ? "empty" : key && this._ai.failedKey === key ? "unavailable" : "pending";
    // The slider only governs how tightly the model's mask is cut, so it's
    // meaningless in 'whole' mode (nothing is being cut) and while there's
    // no mask yet in 'auto'. Trace mode keeps it enabled throughout: its
    // minimum works without the model at all (the plain loop crop).
    const sliderRow = this.tolerance.closest(".studio__control") || this.tolerance.parentElement;
    if (sliderRow) sliderRow.style.display = this.mode === "whole" ? "none" : "";
    this.tolerance.disabled = this.mode === "auto" && !aiRan;
    this.toleranceLabel.textContent = aiRan ? "edge trim" : this.mode === "trace" ? "clean-up strength" : "sensitivity";

    let hint;
    if (this.mode === "whole") {
      hint = "Keeping the photo whole — nothing cut out. Choose the part you want in the next step.";
    } else if (this.mode === "auto") {
      hint =
        aiState === "active"
          ? "Found the subject. Drag the slider to trim the edge tighter or keep more of it."
          : aiState === "empty"
            ? "Nothing left at this setting — drag the slider back down to bring some of it back."
            : aiState === "unavailable"
              ? "Smart cutout isn't available right now (you may be offline) — using the whole photo as is. Reopen this photo once you're back online to try again."
              : "Finding the subject… ✨";
    } else if (tracing) {
      hint = "Circle the thing you want — roughly is fine, the loop just says which one, not where to cut.";
    } else if (aiState === "active") {
      hint = "Got it — that's the thing you circled, cut out whole. Drag the slider to trim its edge.";
    } else if (aiState === "empty") {
      hint = "Nothing left at this setting — drag the slider back down toward the left.";
    } else if (aiState === "unavailable") {
      hint = "Smart cutout isn't available right now — keeping everything inside your loop as is.";
    } else {
      hint = "Keeping everything inside your loop for now — finding the thing you circled… ✨";
    }
    this.cutoutHint.textContent = hint;
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
      // _drawPath check: a second finger landing mid-trace must not hijack
      // (or corrupt) the stroke the first finger is still drawing.
      if (this.mode !== "trace" || this.tracePath || this._drawPath || !this.source) return;
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this._drawPath = [this._canvasPoint(e)];
      const cleanup = () => {
        this.canvas.removeEventListener("pointermove", onMove);
        this.canvas.removeEventListener("pointerup", onUp);
        this.canvas.removeEventListener("pointercancel", onCancel);
      };
      const onMove = (ev) => {
        // Only the finger that started the stroke draws; and _drawPath can
        // have been nulled under us (mode switched mid-draw) — just stop.
        if (ev.pointerId !== e.pointerId || !this._drawPath) return;
        const pt = this._canvasPoint(ev);
        const last = this._drawPath[this._drawPath.length - 1];
        if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 3) return;
        this._drawPath.push(pt);
        this._renderPreview();
      };
      const onUp = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        cleanup();
        const path = this._drawPath;
        this._drawPath = null;
        // Only accept a real loop — a stray tap or tiny scribble just resets.
        if (path && path.length >= 12) {
          const xs = path.map((p) => p[0]);
          const ys = path.map((p) => p[1]);
          if (Math.max(...xs) - Math.min(...xs) >= 24 && Math.max(...ys) - Math.min(...ys) >= 24) {
            this.tracePath = path;
            this._traceSeq++; // a NEW loop — never reuse a previous loop's cached mask
          }
        }
        this._recompute();
      };
      // The browser can cancel a touch outright (incoming call, system
      // gesture, palm rejection) — without this, the half-drawn loop would
      // stay painted and the move/up listeners would leak and keep firing.
      const onCancel = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        cleanup();
        this._drawPath = null;
        this._recompute();
      };
      this.canvas.addEventListener("pointermove", onMove);
      this.canvas.addEventListener("pointerup", onUp);
      this.canvas.addEventListener("pointercancel", onCancel);
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
    this.posBackBtn.textContent = on ? "‹ back to edit" : this._skipCutout ? "‹ cancel" : "‹ back to cutout";
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
