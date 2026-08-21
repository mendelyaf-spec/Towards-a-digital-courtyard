// studio.js — the cut-out modal.
// Stage 1 shows the photo with its background removed, lets you tune the
// sensitivity. For a background photo specifically, stage 2 then lets you
// pan/zoom/rotate to choose what actually shows BEFORE it ever lands on the
// canvas — with a preview/back-to-edit loop — instead of only being able to
// adjust that after placing it. Everything placed still stays editable
// afterward too; this only adds the choice to also do it up front.

import { fileToCanvas, removeBackground } from "./extract.js";

const FRAME_W = 320, FRAME_H = 240; // must match background.js's default region size —
// the studio's preview frame and the eventual on-canvas box need to be the
// same size for a pixel of drag here to mean the same offset there.

export class Studio {
  constructor() {
    this.el = document.getElementById("studio");
    this.canvas = document.getElementById("studioCanvas");
    this.tolerance = document.getElementById("tolerance");
    this.cutoutStage = document.getElementById("studioCutoutStage");
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
    this.onPlace = null;  // callback(dataURL, w, h, pos|null)
    this.onCancel = null; // callback() — fired if closed WITHOUT committing (cancel, backdrop, or a load error)
    this.withPosition = false; // whether this open() includes stage 2 (backgrounds only)
    this.previewing = false;
    this.pos = { scale: 1, rotate: 0, offsetX: 0, offsetY: 0 };
    this.frameScale = 1; // the frame's actual on-screen size can be smaller than FRAME_W on a narrow viewport

    this.tolerance.addEventListener("input", () => this._recompute());
    this.cancelBtn.addEventListener("click", () => this.close());
    this.nextBtn.addEventListener("click", () => this._toPosition());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });

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

  /** @param {{withPosition?: boolean}} opts — withPosition adds stage 2 (only meaningful for backgrounds) */
  async open(file, onPlace, onCancel, { withPosition = false } = {}) {
    this.onPlace = onPlace;
    this.onCancel = onCancel || null;
    this.withPosition = withPosition;
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
    this._recompute();
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

  _recompute() {
    if (!this.source) return;
    this.result = removeBackground(this.source, Number(this.tolerance.value));
    // Paint the cut-out onto the preview canvas.
    this.canvas.width = this.result.width;
    this.canvas.height = this.result.height;
    const ctx = this.canvas.getContext("2d");
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.result, 0, 0);
  }

  _toCutout() {
    this.cutoutStage.hidden = false;
    this.positionStage.hidden = true;
  }

  // Stage 1 → stage 2 (backgrounds), or straight to commit (everything else
  // — regular photo/video items, thumbnails — unchanged from before).
  _toPosition() {
    if (!this.result || !this.onPlace) return this.close();
    if (!this.withPosition) return this._commit();
    this.pos = { scale: 1, rotate: 0, offsetX: 0, offsetY: 0 };
    this.zoomInput.value = 100;
    this.rotateInput.value = 0;
    this.frameImg.src = this.result.toDataURL("image/png");
    this.cutoutStage.hidden = true;
    this.positionStage.hidden = false;
    this.frameScale = (this.frame.clientWidth || FRAME_W) / FRAME_W;
    this._setPreviewing(false);
    this._renderFrame();
  }

  _setPreviewing(on) {
    this.previewing = on;
    this.positionStage.classList.toggle("is-previewing", on);
    this.posBackBtn.textContent = on ? "‹ back to edit" : "‹ back to cutout";
    this.posNextBtn.textContent = on ? "paste on canvas" : "preview →";
    this.positionHint.textContent = on
      ? "This is what lands on your canvas. Paste it, or go back to adjust it more."
      : "Drag the photo to reposition it, zoom and rotate to choose what shows — this is the section that becomes your background.";
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

  _commit() {
    if (!this.result || !this.onPlace) return this.close();
    const dataURL = this.result.toDataURL("image/png");
    const w = this.result.width, h = this.result.height;
    const pos = this.withPosition ? { ...this.pos } : null;
    const onPlace = this.onPlace;
    this.onPlace = null;
    this.onCancel = null; // committed — close() below shouldn't also fire cancel
    this.close();
    onPlace(dataURL, w, h, pos);
  }
}
