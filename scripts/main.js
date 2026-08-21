// main.js — app shell. Sets up the canvas subsystem once, then routes between
// the home page, a single canvas, and a courtyard.

import { Viewport } from "./viewport.js";
import { ItemLayer } from "./items.js";
import { Studio } from "./studio.js";
import { FramePicker } from "../videoframe/videoframe.js";
import { InAppBrowser } from "../browser/browser.js";
import { BackgroundLayer } from "../background/background.js";
import { PocketPanel, getPocketBlobURL, sendItemToPocket } from "../pocket/pocket.js";
import { openLinkPrompt, closeLinkPrompt } from "../links/links.js";
import { startRouter, go } from "./router.js";
import { renderHome } from "./home.js";
import { renderCourtyard } from "./courtyard.js";
import { migrate, getCanvas, createCanvas, listCanvases } from "./store.js";
import { consumeInvite } from "../courtyardcreationlogic.js";

migrate(); // bring any old single-canvas data forward

const homeView = document.getElementById("homeView");
const canvasView = document.getElementById("canvasView");
const courtyardView = document.getElementById("courtyardView");
const zoomLabel = document.getElementById("zoomLabel");
const canvasTitle = document.getElementById("canvasTitle");

// ---------- canvas subsystem (built once, loads a canvas on demand) ----------
const viewport = new Viewport(
  document.getElementById("viewport"),
  document.getElementById("world"),
  { onChange: (s) => (zoomLabel.textContent = Math.round(s * 100) + "%") }
);

const worldEl = document.getElementById("world");
const bg = new BackgroundLayer(worldEl, viewport);
const layer = new ItemLayer(worldEl, viewport);
const studio = new Studio();
const framePicker = new FramePicker();
const inAppBrowser = new InAppBrowser();

viewport.onChange = (s) => {
  zoomLabel.textContent = Math.round(s * 100) + "%";
  layer.positionBar();
  bg.positionBar();
};

bg.onSelect = () => layer.select(null);
layer.onSelect = (id) => { if (id) bg.select(null); };
bg.isOpen = (id) => layer.isOpen(id);
layer.groupBg = bg;
layer.onVisibility = () => bg.refreshGroupedVisibility();
layer.onRemove = (ids) => bg.removeGroupedUnder(ids);

const bgParentTarget = () =>
  layer.selected && layer.isOpen(layer.selected) ? layer.selected : undefined;

// --- toolbar wiring ---
const bgToggle = document.getElementById("bgToggle");
bgToggle.addEventListener("click", () => {
  const on = bg.toggleMode();
  bgToggle.classList.toggle("is-on", on);
  bgToggle.setAttribute("aria-pressed", String(on));
});

for (const btn of document.querySelectorAll(".tool[data-shape]")) {
  btn.addEventListener("click", () => {
    const shape = btn.dataset.shape;
    if (bg.mode && shape !== "text") bg.add(shape, { parentId: bgParentTarget() });
    else layer.add(shape);
  });
}

const photoBtn = document.getElementById("photoBtn");
const photoMenu = document.getElementById("photoMenu");
const photoCamera = document.getElementById("photoCamera");
const photoUpload = document.getElementById("photoUpload");

function openPhotoMenu(open) {
  if (open) {
    const r = photoBtn.getBoundingClientRect();
    photoMenu.style.left = r.left + r.width / 2 + "px";
    photoMenu.style.bottom = window.innerHeight - r.top + 10 + "px";
  }
  photoMenu.hidden = !open;
  photoBtn.setAttribute("aria-expanded", String(open));
}
photoBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoMenu(photoMenu.hidden); });
document.addEventListener("pointerdown", (e) => {
  if (!photoMenu.hidden && !photoMenu.contains(e.target) && e.target !== photoBtn) openPhotoMenu(false);
});
photoMenu.querySelectorAll(".photo-menu__item").forEach((item) => {
  item.addEventListener("click", () => {
    const input = item.dataset.source === "camera" ? photoCamera : photoUpload;
    input.value = "";
    input.click();
    openPhotoMenu(false);
  });
});
// Places a cut-out result either as a background region or a normal item,
// sized to fit its own aspect ratio. Shared by the toolbar's camera/upload
// flow and by "add to canvas" on a pocket photo.
function placeCutout(dataURL, w, h, extra = {}) {
  if (bg.mode) { bg.add("image", { src: dataURL, parentId: bgParentTarget() }); return; }
  const maxSide = 260;
  const ratio = w / h;
  layer.add("image", {
    src: dataURL,
    w: Math.round(ratio >= 1 ? maxSide : maxSide * ratio),
    h: Math.round(ratio >= 1 ? maxSide / ratio : maxSide),
    ...extra,
  });
}
async function handlePhotoFile(file) {
  if (!file) return;
  if (file.type.startsWith("video/")) {
    // Pick a still frame first — it then flows into the exact same cut-out
    // pipeline as any photo, so nothing downstream needs to know a video
    // was ever involved.
    framePicker.open(file, (stillFrame) => handlePhotoFile(stillFrame));
    return;
  }
  await studio.open(file, (dataURL, w, h) => placeCutout(dataURL, w, h));
}
photoCamera.addEventListener("change", (e) => handlePhotoFile(e.target.files?.[0]));
photoUpload.addEventListener("change", (e) => handlePhotoFile(e.target.files?.[0]));

// ---------- pocket: staged docs/videos/object photos for this canvas ----------
layer.resolveFileUrl = getPocketBlobURL; // 'file' items open by resolving their pocket blob on click

let pocket; // referenced by the hooks below, assigned once constructed
layer.getPocketDropRect = () => pocket?.getDropRect() ?? null;
layer.onSendToPocket = (item) => sendItemToPocket(pocket.canvasId, item);
layer.onOpenLink = (url, title) => inAppBrowser.open(url, title);

pocket = new PocketPanel({
  onPlace: async (record) => {
    if (record.kind === "photo") {
      // Route through the same cut-out studio as the toolbar, carrying the
      // pocket photo's location (often read from its EXIF GPS) onto the item.
      await studio.open(record.blob, (dataURL, w, h) =>
        placeCutout(dataURL, w, h, record.location ? { location: record.location } : {})
      );
    } else if (record.kind === "youtube") {
      layer.add("youtube", {
        videoId: record.videoId,
        title: record.name,
        thumbnailUrl: record.thumbnailUrl,
        location: record.location || undefined,
      });
    } else if (record.kind === "link") {
      layer.add("link", {
        url: record.url,
        name: record.name,
        domain: record.domain,
        faviconUrl: record.faviconUrl,
        location: record.location || undefined,
      });
    } else {
      layer.add("file", {
        pocketId: record.id,
        name: record.name,
        mime: record.mime,
        location: record.location || undefined,
      });
    }
  },
});
pocket.onOpenLink = (url, title) => inAppBrowser.open(url, title);

// ---------- links: embed a video or drop a bookmark directly, no pocket needed ----------
const linkBtn = document.getElementById("linkBtn");
linkBtn.addEventListener("click", () => {
  openLinkPrompt(linkBtn, (link) => {
    if (link.kind === "youtube") {
      layer.add("youtube", { videoId: link.videoId, title: link.title, thumbnailUrl: link.thumbnailUrl });
    } else {
      layer.add("link", { url: link.url, name: link.title || link.domain, domain: link.domain, faviconUrl: link.faviconUrl });
    }
  });
});

document.getElementById("resetView").addEventListener("click", () => viewport.reset());
document.getElementById("canvasBack").addEventListener("click", () => go(""));

if (/Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
  photoCamera.setAttribute("capture", "environment");
}

// ---------- views ----------
function showView(name) {
  // Leaving the canvas: drop any selection / open menus.
  layer.select(null);
  bg.select(null);
  studio.close();
  framePicker.close();
  inAppBrowser.close();
  pocket.close();
  openPhotoMenu(false);
  closeLinkPrompt();
  homeView.hidden = name !== "home";
  canvasView.hidden = name !== "canvas";
  courtyardView.hidden = name !== "courtyard";
}

function showHome() {
  showView("home");
  renderHome(homeView);
}
function showCanvas(id) {
  if (!id || !getCanvas(id)) return go("");
  showView("canvas");
  canvasTitle.textContent = getCanvas(id).name;
  layer.loadCanvas(id);
  bg.loadCanvas(id);
  pocket.loadCanvas(id);
  viewport.reset();
}
function showCourtyard(id) {
  showView("courtyard");
  renderCourtyard(courtyardView, id);
}
function showJoin(token) {
  // On this device, consume the invite and jump into the new courtyard.
  // (Cross-device joining needs the shared backend.)
  const myCanvas = listCanvases()[0] || createCanvas("My canvas");
  const res = consumeInvite(token, myCanvas.id);
  if (res.error) { alert(res.error); return go(""); }
  go("courtyard/" + res.courtyard.id);
}

startRouter({
  "": showHome,
  canvas: showCanvas,
  courtyard: showCourtyard,
  join: showJoin,
});
