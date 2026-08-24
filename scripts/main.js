// main.js — app shell. Sets up the canvas subsystem once, then routes between
// the home page, a single canvas, and a courtyard.

import { Viewport } from "./viewport.js";
import { ItemLayer } from "./items.js";
import { Studio } from "./studio.js";
import { FramePicker } from "../videoframe/videoframe.js";
import { InAppBrowser } from "../browser/browser.js";
import { DocViewer, isViewableDoc, isPlainText } from "../docviewer/docviewer.js";
import { BackgroundLayer } from "../background/background.js";
import { PocketPanel, getPocketBlobURL, sendItemToPocket, addToPocket, getPocketItem } from "../pocket/pocket.js";
import { openLinkPrompt, closeLinkPrompt, setPhotoEditor } from "../links/links.js";
import { startRouter, go } from "./router.js";
import { renderHome } from "./home.js";
import { renderCourtyard } from "./courtyard.js";
import { migrate, getCanvas, createCanvas, listCanvases, renameCanvas, save } from "./store.js";
import { canUndo, setUndoChangeListener } from "./undo.js";
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
const docViewer = new DocViewer();

// A thumbnail photo (for a link's preview) gets to choose its crop/zoom/
// rotate before it's used, same as any other photo — but skips subject
// extraction entirely (skipCutout): pulling a shape out of its background
// only makes sense for something going onto the canvas as its own object,
// not a small preview image where the whole point is showing the photo
// (or screenshot) as it actually is.
setPhotoEditor(
  (file) =>
    new Promise((resolve) => {
      studio.open(file, (dataURL) => resolve(dataURL), () => resolve(null), {
        position: "item",
        placeLabel: "use this photo",
        skipCutout: true,
      });
    })
);

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
  if (bg.mode) { bg.add("image", { src: dataURL, parentId: bgParentTarget(), ...extra }); return; }
  const maxSide = 260;
  const ratio = w / h;
  layer.add("image", {
    src: dataURL,
    w: Math.round(ratio >= 1 ? maxSide : maxSide * ratio),
    h: Math.round(ratio >= 1 ? maxSide / ratio : maxSide),
    ...extra,
  });
}
// Studio's stage-2 pos ({scale, rotate, offsetX, offsetY}) — only ever set
// in 'background' mode (see studio.js); a regular item's crop is baked
// straight into the image instead, so pos is always null there and this is
// a no-op.
function posToExtra(pos) {
  return pos ? { imgScale: pos.scale, imgRotate: pos.rotate, imgOffsetX: pos.offsetX, imgOffsetY: pos.offsetY } : {};
}
// Upload is one door for everything now, so it routes by what the file
// actually is: a video picks a still frame first, a photo goes to the
// cut-out studio, a plain text file drops its words straight onto the
// canvas as a note, and a PDF becomes a document card you read (and
// annotate) in the viewer.
async function handleUploadedFile(file) {
  if (!file) return;
  if (file.type.startsWith("video/")) {
    // Pick a still frame first — it then flows into the exact same cut-out
    // pipeline as any photo, so nothing downstream needs to know a video
    // was ever involved.
    framePicker.open(file, (stillFrame) => handleUploadedFile(stillFrame));
    return;
  }
  if (isViewableDoc(file.type, file.name)) {
    await placeDocument(file);
    return;
  }
  // 'background' mode (non-destructive, still adjustable afterward) while
  // the background tool is on; 'item' mode (baked into the image, no
  // separate zoom/rotate left over on the placed item) otherwise.
  await studio.open(
    file,
    (dataURL, w, h, pos) => placeCutout(dataURL, w, h, posToExtra(pos)),
    null,
    { position: bg.mode ? "background" : "item" }
  );
}

// How much of a text file goes onto the canvas as a note. The whole file
// still lives in the pocket and opens in full in the viewer — this is just
// what a note can hold before it stops being a note and starts being a wall.
const TEXT_NOTE_MAX = 1200;

async function placeDocument(file) {
  // Everything readable is kept in the pocket, which is what gives it a
  // durable home for its blob AND its margin notes (see docviewer.js).
  const pocketId = await addToPocket(pocket.canvasId, file);
  if (isPlainText(file.type, file.name)) {
    // "A text file simply uploads the text": the words land as a real,
    // editable note in the default note shape — restyle it like any other.
    let text = "";
    try {
      text = await file.text();
    } catch {
      /* unreadable as text after all — fall through to a document card */
    }
    if (text.trim()) {
      const truncated = text.length > TEXT_NOTE_MAX;
      const item = layer.add("text", {
        text: truncated ? text.slice(0, TEXT_NOTE_MAX).trimEnd() + "…" : text,
        w: 300,
        h: Math.min(420, Math.max(90, Math.round(text.length / 3.2))),
      });
      // Keep the tie to the full document either way, so "open" in the
      // viewer always reaches the complete file and its marginalia.
      item.pocketId = pocketId;
      item.name = file.name;
      item.mime = file.type || "text/plain";
      save();
      layer._reRender(item);
      return;
    }
  }
  layer.add("file", { pocketId, name: file.name, mime: file.type || "application/octet-stream" });
}
photoCamera.addEventListener("change", (e) => handleUploadedFile(e.target.files?.[0]));
photoUpload.addEventListener("change", (e) => handleUploadedFile(e.target.files?.[0]));

// ---------- pocket: staged docs/videos/object photos for this canvas ----------
layer.resolveFileUrl = getPocketBlobURL; // 'file' items open by resolving their pocket blob on click
// A readable document (PDF / text) opens in the viewer instead of a new
// tab — that's where its highlights and margin notes live. Returns false
// for anything else so items.js falls back to the plain new-tab open.
layer.onOpenDoc = async (pocketId) => {
  const record = await getPocketItem(pocketId);
  if (!record || !isViewableDoc(record.mime, record.name)) return false;
  await docViewer.open(record);
  return true;
};

let pocket; // referenced by the hooks below, assigned once constructed
layer.getPocketDropRect = () => pocket?.getDropRect() ?? null;
layer.onSendToPocket = (item) => sendItemToPocket(pocket.canvasId, item);
layer.onOpenLink = (url, title) => inAppBrowser.open(url, title);

pocket = new PocketPanel({
  // dropPos (world coords) is set when this came from dragging a card
  // straight onto the canvas, instead of tapping "add to canvas" — omitted,
  // the item centers on the current view as usual.
  onPlace: async (record, dropPos) => {
    if (record.kind === "photo") {
      // Route through the same cut-out studio as the toolbar.
      await studio.open(
        record.blob,
        (dataURL, w, h, pos) =>
          placeCutout(dataURL, w, h, { ...posToExtra(pos), ...(dropPos ? { nearCenter: dropPos } : {}) }),
        null,
        { position: bg.mode ? "background" : "item" }
      );
    } else if (record.kind === "youtube") {
      layer.add("youtube", {
        videoId: record.videoId,
        title: record.name,
        thumbnailUrl: record.thumbnailUrl,
        thumbnailImage: record.thumbnailImage,
        thumbnailText: record.thumbnailText,
        ...(dropPos ? { nearCenter: dropPos } : {}),
      });
    } else if (record.kind === "link") {
      layer.add("link", {
        url: record.url,
        name: record.name,
        domain: record.domain,
        faviconUrl: record.faviconUrl,
        thumbnailImage: record.thumbnailImage,
        thumbnailText: record.thumbnailText,
        ...(dropPos ? { nearCenter: dropPos } : {}),
      });
    } else {
      layer.add("file", {
        pocketId: record.id,
        name: record.name,
        mime: record.mime,
        ...(dropPos ? { nearCenter: dropPos } : {}),
      });
    }
  },
});
pocket.onOpenLink = (url, title) => inAppBrowser.open(url, title);
pocket.worldPointFromScreen = (x, y) => viewport.screenToWorld(x, y);

// ---------- links: embed a video or drop a bookmark directly, no pocket needed ----------
const linkBtn = document.getElementById("linkBtn");
linkBtn.addEventListener("click", () => {
  openLinkPrompt(linkBtn, (link) => {
    if (link.kind === "youtube") {
      layer.add("youtube", { videoId: link.videoId, title: link.title, thumbnailUrl: link.thumbnailUrl, thumbnailImage: link.thumbnailImage, thumbnailText: link.thumbnailText });
    } else {
      layer.add("link", { url: link.url, name: link.title || link.domain, domain: link.domain, faviconUrl: link.faviconUrl, thumbnailImage: link.thumbnailImage, thumbnailText: link.thumbnailText });
    }
  });
});

document.getElementById("resetView").addEventListener("click", () => viewport.reset());
document.getElementById("canvasBack").addEventListener("click", () => go(""));

document.getElementById("canvasRename").addEventListener("click", () => {
  if (!currentCanvasId) return;
  const current = getCanvas(currentCanvasId)?.name || "";
  const name = prompt("Rename canvas", current);
  if (name && name.trim() && name.trim() !== current) {
    renameCanvas(currentCanvasId, name.trim());
    canvasTitle.textContent = name.trim();
  }
});

// ---------- undo ----------
const undoBtn = document.getElementById("undoBtn");
const refreshUndoBtn = () => { undoBtn.disabled = !canUndo(); };
undoBtn.addEventListener("click", () => layer.undo());
setUndoChangeListener(refreshUndoBtn);

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
let currentCanvasId = null;
function showCanvas(id) {
  if (!id || !getCanvas(id)) return go("");
  showView("canvas");
  currentCanvasId = id;
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
