// videoframe/videoframe.js — pick a still frame out of an uploaded video.
//
// Lets "cut from photo / upload" also accept a short video (of an insect, a
// tree in the wind, whatever): scrub to the moment that looks right, capture
// that frame, and hand it back as a plain image File — which then flows into
// the exact same cut-out pipeline (extract.js/studio.js) as any photo. This
// module's only job is turning "a video + a chosen instant" into "a File";
// everything downstream never needs to know a video was involved at all.

const MAX_DIM = 1024; // match extract.js's cap, so a captured frame isn't huge

export class FramePicker {
  constructor() {
    this.el = document.getElementById("framePicker");
    this.video = document.getElementById("framePickerVideo");
    this.scrub = document.getElementById("framePickerScrub");
    this.timeLabel = document.getElementById("framePickerTime");
    this.playBtn = document.getElementById("framePickerPlay");
    this.useBtn = document.getElementById("framePickerUse");
    this.cancelBtn = document.getElementById("framePickerCancel");

    this.objectUrl = null;
    this.onChoose = null;

    this.scrub.addEventListener("input", () => {
      this.video.pause();
      this._reflectPlayState();
      this.video.currentTime = Number(this.scrub.value);
    });
    this.video.addEventListener("timeupdate", () => this._reflectTime());
    this.video.addEventListener("seeked", () => this._reflectTime());
    this.playBtn.addEventListener("click", () => {
      if (this.video.paused) this.video.play();
      else this.video.pause();
    });
    this.video.addEventListener("play", () => this._reflectPlayState());
    this.video.addEventListener("pause", () => this._reflectPlayState());
    this.cancelBtn.addEventListener("click", () => this.close());
    this.useBtn.addEventListener("click", () => this._useFrame());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });
  }

  /** @param {File} file @param {(stillFrame: File) => void} onChoose */
  open(file, onChoose) {
    this.onChoose = onChoose;
    this.objectUrl = URL.createObjectURL(file);
    this.video.src = this.objectUrl;
    this.video.currentTime = 0;
    this.el.hidden = false;
    this.useBtn.disabled = true;

    const onError = () => {
      this.close();
      alert("Couldn't read that video — it may be an unsupported format.");
    };
    this.video.addEventListener("error", onError, { once: true });
    this.video.addEventListener(
      "loadedmetadata",
      () => {
        this.video.removeEventListener("error", onError);
        this.scrub.min = "0";
        this.scrub.max = String(this.video.duration || 0);
        this.scrub.step = "0.01";
        this.scrub.value = "0";
        this.useBtn.disabled = false;
        this._reflectTime();
      },
      { once: true }
    );
  }

  close() {
    this.el.hidden = true;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load(); // stop any in-flight buffering
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.onChoose = null;
  }

  _reflectTime() {
    this.scrub.value = String(this.video.currentTime);
    this.timeLabel.textContent = `${fmt(this.video.currentTime)} / ${fmt(this.video.duration || 0)}`;
  }
  _reflectPlayState() {
    this.playBtn.textContent = this.video.paused ? "▶" : "❚❚";
  }

  _useFrame() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(1, MAX_DIM / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(this.video, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], "frame.png", { type: "image/png" });
      const onChoose = this.onChoose;
      this.close();
      onChoose?.(file);
    }, "image/png");
  }
}

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
