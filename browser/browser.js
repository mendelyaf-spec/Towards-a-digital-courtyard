// browser/browser.js — a small in-app browser panel.
//
// Opens a link on top of the canvas instead of navigating away to a new
// tab, so the mosaic (pan/zoom position, selection, everything) is exactly
// as you left it the moment you close the panel.
//
// Whether a given site will actually show up inside it depends entirely on
// that site: browsers respect an X-Frame-Options / Content-Security-Policy
// header the SITE sends, which can flatly refuse to be framed by anyone —
// that's a security boundary we can't see past or work around from here,
// and JS in this page has no reliable way to detect that refusal (a blocked
// frame just renders blank; there's no catchable "failed" event for it,
// since revealing the reason would itself leak cross-origin information).
// So there's always a visible, one-click "open in a new tab instead" — the
// honest fallback for whenever a site says no.

export class InAppBrowser {
  constructor() {
    this.el = document.getElementById("inAppBrowser");
    this.frame = document.getElementById("inAppBrowserFrame");
    this.titleEl = document.getElementById("inAppBrowserTitle");
    this.openTabBtn = document.getElementById("inAppBrowserOpenTab");
    this.closeBtn = document.getElementById("inAppBrowserClose");
    this.currentUrl = null;

    this.closeBtn.addEventListener("click", () => this.close());
    this.openTabBtn.addEventListener("click", () => {
      if (this.currentUrl) window.open(this.currentUrl, "_blank", "noopener");
    });
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });
  }

  open(url, title) {
    this.currentUrl = url;
    this.titleEl.textContent = title || url;
    this.titleEl.title = url;
    this.frame.src = url;
    this.el.hidden = false;
  }

  close() {
    this.el.hidden = true;
    this.frame.src = "about:blank"; // stop any playback/loading, free resources
    this.currentUrl = null;
  }
}
