// main.js — bootstrap. Wires the viewport, item layer, toolbar and studio.

import { Viewport } from "./viewport.js";
import { ItemLayer } from "./items.js";
import { Studio } from "./studio.js";

const zoomLabel = document.getElementById("zoomLabel");

const viewport = new Viewport(
  document.getElementById("viewport"),
  document.getElementById("world"),
  { onChange: (s) => (zoomLabel.textContent = Math.round(s * 100) + "%") }
);

const layer = new ItemLayer(document.getElementById("world"), viewport);
const studio = new Studio();

// --- Toolbar: pick a shape ---
for (const btn of document.querySelectorAll(".tool[data-shape]")) {
  btn.addEventListener("click", () => layer.add(btn.dataset.shape));
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
