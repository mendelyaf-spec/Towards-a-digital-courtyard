// main.js — bootstrap. Wires the viewport, item layer, toolbar and studio.

import { Viewport } from "./viewport.js";
import { ItemLayer } from "./items.js";
import { Studio } from "./studio.js";
import { BackgroundLayer } from "../background/background.js";

const zoomLabel = document.getElementById("zoomLabel");

const viewport = new Viewport(
  document.getElementById("viewport"),
  document.getElementById("world"),
  { onChange: (s) => (zoomLabel.textContent = Math.round(s * 100) + "%") }
);

const worldEl = document.getElementById("world");
const bg = new BackgroundLayer(worldEl, viewport);
const layer = new ItemLayer(worldEl, viewport);
const studio = new Studio();

// Now that both layers exist, the viewport can also keep their bars pinned.
viewport.onChange = (s) => {
  zoomLabel.textContent = Math.round(s * 100) + "%";
  layer.positionBar();
  bg.positionBar();
};

// Selecting in one layer clears the selection in the other.
bg.onSelect = () => layer.select(null);
layer.onSelect = (id) => { if (id) bg.select(null); };

// Grouped backgrounds: the background layer asks the item layer about
// open groups; the item layer drives backgrounds when groups move/collapse/delete.
bg.isOpen = (id) => layer.isOpen(id);
layer.groupBg = bg;
layer.onVisibility = () => bg.refreshGroupedVisibility();
layer.onRemove = (ids) => bg.removeGroupedUnder(ids);
bg.refreshGroupedVisibility(); // apply to anything restored from storage

// If an expandable item is open, a new background binds to that group.
const bgParentTarget = () =>
  layer.selected && layer.isOpen(layer.selected) ? layer.selected : undefined;

// --- Background mode toggle ---
const bgToggle = document.getElementById("bgToggle");
bgToggle.addEventListener("click", () => {
  const on = bg.toggleMode();
  bgToggle.classList.toggle("is-on", on);
  bgToggle.setAttribute("aria-pressed", String(on));
});

// --- Toolbar: pick a shape (rect / circle / text) ---
// In background mode, rect/circle become background regions; text is always an item.
for (const btn of document.querySelectorAll(".tool[data-shape]")) {
  btn.addEventListener("click", () => {
    const shape = btn.dataset.shape;
    if (bg.mode && shape !== "text") bg.add(shape, { parentId: bgParentTarget() });
    else layer.add(shape);
  });
}

// --- Toolbar: photo -> cut out shape -> place ---
const photoInput = document.getElementById("photoInput");
document.getElementById("photoBtn").addEventListener("click", () => {
  photoInput.value = ""; // allow re-picking the same file
  photoInput.click();
});
photoInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await studio.open(file, (dataURL, w, h) => {
    if (bg.mode) {
      // The cut-out becomes a translucent background region.
      bg.add("image", { src: dataURL, parentId: bgParentTarget() });
      return;
    }
    // Size the placed cut-out to its own aspect ratio.
    const maxSide = 260;
    const ratio = w / h;
    layer.add("image", {
      src: dataURL,
      w: Math.round(ratio >= 1 ? maxSide : maxSide * ratio),
      h: Math.round(ratio >= 1 ? maxSide / ratio : maxSide),
    });
  });
});

// --- Reset view ---
document.getElementById("resetView").addEventListener("click", () => viewport.reset());

// Enable camera capture on mobile devices that support it.
if (/Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
  photoInput.setAttribute("capture", "environment");
}
