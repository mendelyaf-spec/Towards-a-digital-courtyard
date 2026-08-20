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
    this.onPlace = null;  // callback(dataURL)

    this.tolerance.addEventListener("input", () => this._recompute());
    this.cancelBtn.addEventListener("click", () => this.close());
    this.placeBtn.addEventListener("click", () => this._commit());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });
  }

  async open(file, onPlace) {
    this.onPlace = onPlace;
    try {
      this.source = await fileToCanvas(file);
    } catch (err) {
      console.error(err);
      alert(err.message || "Couldn't open that photo.");
      return;
    }
    this._recompute();
    this.el.hidden = false;
  }

  close() {
    this.el.hidden = true;
    this.source = null;
    this.result = null;
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
    this.onPlace(dataURL, this.result.width, this.result.height);
    this.close();
  }
}
