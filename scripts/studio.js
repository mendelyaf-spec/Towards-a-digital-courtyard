// studio.js — the cut-out modal.
// Shows the photo with its background removed, lets you tune the
// sensitivity, then hands a transparent PNG back to the caller.

import { fileToCanvas, removeBackground } from "./extract.js";

export class Studio {
  constructor() {
    this.el = document.getElementById("studio");
    this.canvas = document.getElementById("studioCanvas");
    this.tolerance = document.getElementById("tolerance");
    this.placeBtn = document.getElementById("studioPlace");
    this.cancelBtn = document.getElementById("studioCancel");

    this.source = null;   // downscaled source canvas
    this.result = null;   // current cut-out canvas
    this.onPlace = null;  // callback(dataURL, w, h)
    this.onCancel = null; // callback() — fired if closed WITHOUT committing (cancel, backdrop, or a load error)

    this.tolerance.addEventListener("input", () => this._recompute());
    this.cancelBtn.addEventListener("click", () => this.close());
    this.placeBtn.addEventListener("click", () => this._commit());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });
  }

  async open(file, onPlace, onCancel) {
    this.onPlace = onPlace;
    this.onCancel = onCancel || null;
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

  _commit() {
    if (!this.result || !this.onPlace) return this.close();
    const dataURL = this.result.toDataURL("image/png");
    const w = this.result.width, h = this.result.height;
    const onPlace = this.onPlace;
    this.onPlace = null;
    this.onCancel = null; // committed — close() below shouldn't also fire cancel
    this.close();
    onPlace(dataURL, w, h);
  }
}
