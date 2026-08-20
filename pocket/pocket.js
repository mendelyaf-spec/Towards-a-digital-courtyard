// pocket/pocket.js — "each mosaic has a pocket."
//
// A staging drawer per canvas for documents, videos, and photos of objects
// (leaves, rocks…) you might one day add to the mosaic, but haven't yet.
//
// Storage: IndexedDB, not localStorage. A video or PDF can easily blow past
// localStorage's ~5–10MB origin quota; IndexedDB stores the actual Blob
// (no base64 bloat) and has a far larger practical quota. Once something is
// placed on the canvas, an 'image' item still carries its own small data URL
// (consistent with the existing cut-out flow), but a 'file' item (doc/video)
// just references its pocket record by id and resolves a blob URL on demand
// — see ItemLayer's `resolveFileUrl` hook in scripts/items.js.

import { newId } from "../scripts/store.js";
import { openGeotagPopover, formatCoords } from "../geotag/geotag.js";
import { openYoutubePrompt, youtubeThumbnail, youtubeEmbedUrl, fetchYouTubeTitle } from "../youtube/youtube.js";

const DB_NAME = "dc-pocket";
const STORE = "items";
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("canvasId", "canvasId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function kindOf(file) {
  if (file.type.startsWith("image/")) return "photo";
  if (file.type.startsWith("video/")) return "video";
  return "doc";
}

/** Add a File to a canvas's pocket. Auto-tags location from a photo's EXIF GPS, if present. */
export async function addToPocket(canvasId, file) {
  const kind = kindOf(file);
  let location = null;
  if (kind === "photo") {
    const { extractExifGPS } = await import("../geotag/geotag.js");
    const gps = await extractExifGPS(file).catch(() => null);
    if (gps) location = { ...gps, label: "", source: "exif" };
  }
  const record = {
    id: newId(),
    canvasId,
    kind,
    name: file.name || `${kind}-${Date.now()}`,
    mime: file.type || "application/octet-stream",
    size: file.size,
    blob: file,
    createdAt: Date.now(),
    location,
  };
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return record.id;
}

/** Add a YouTube link to a canvas's pocket. No blob — just the id/title/thumbnail. */
export async function addLinkToPocket(canvasId, { videoId, title, thumbnailUrl, url }) {
  const record = {
    id: newId(),
    canvasId,
    kind: "youtube",
    videoId,
    name: title || "YouTube video",
    url,
    thumbnailUrl,
    createdAt: Date.now(),
    location: null,
  };
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return record.id;
}

/**
 * Metadata for every pocket item on a canvas (blobs stripped — cheap to list,
 * even with videos in the pocket; fetch the blob only when actually needed).
 */
export async function listPocketMeta(canvasId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("canvasId").getAll(IDBKeyRange.only(canvasId));
    req.onsuccess = () => resolve(req.result.map(({ blob, ...meta }) => meta).sort((a, b) => b.createdAt - a.createdAt));
    req.onerror = () => reject(req.error);
  });
}

export async function getPocketItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Blob URL for a pocket item's file — remember to URL.revokeObjectURL it when done. */
export async function getPocketBlobURL(id) {
  const rec = await getPocketItem(id);
  return rec ? URL.createObjectURL(rec.blob) : null;
}

export async function removeFromPocket(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function setPocketLocation(id, location) {
  const rec = await getPocketItem(id);
  if (!rec) return;
  rec.location = location;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------- panel UI ----------------
// Reads its markup from index.html (#pocketToggle / #pocketPanel / #pocketGrid
// / #pocketAdd / #pocketPreview*) the same way ItemLayer reads #itemBar.

export class PocketPanel {
  constructor({ onPlace } = {}) {
    this.onPlace = onPlace || (() => {});
    this.canvasId = null;
    this.objectUrls = new Set(); // revoked on refresh/teardown to avoid leaking memory

    this.toggleBtn = document.getElementById("pocketToggle");
    this.panel = document.getElementById("pocketPanel");
    this.grid = document.getElementById("pocketGrid");
    this.addInput = document.getElementById("pocketAdd");
    this.addLinkBtn = document.getElementById("pocketAddLink");
    this.preview = document.getElementById("pocketPreview");
    this.previewBody = document.getElementById("pocketPreviewBody");

    this.toggleBtn.addEventListener("click", () => this.toggle());
    document.getElementById("pocketClose").addEventListener("click", () => this.close());
    document.getElementById("pocketPreviewClose").addEventListener("click", () => this.closePreview());
    this.preview.addEventListener("pointerdown", (e) => {
      if (e.target === this.preview) this.closePreview();
    });

    this.addInput.addEventListener("change", async (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = "";
      for (const f of files) {
        try {
          await addToPocket(this.canvasId, f);
        } catch (err) {
          alert(`Couldn't save "${f.name}" — it may be too large for this browser's storage.`);
          console.error(err);
        }
      }
      this.refresh();
    });

    this.addLinkBtn.addEventListener("click", () => {
      openYoutubePrompt(this.addLinkBtn, async (videoId, url) => {
        const title = await fetchYouTubeTitle(videoId); // best-effort; null offline/blocked
        await addLinkToPocket(this.canvasId, { videoId, title, thumbnailUrl: youtubeThumbnail(videoId), url });
        this.refresh();
      });
    });

    this.grid.addEventListener("click", (e) => this._onGridClick(e));
  }

  // Swap to another canvas's pocket (same pattern as ItemLayer/BackgroundLayer.loadCanvas).
  loadCanvas(id) {
    this.canvasId = id;
    this.close();
    this._revokeAll();
  }

  toggle() { this.panel.hidden ? this.open() : this.close(); }
  open() {
    this.panel.hidden = false;
    this.toggleBtn.hidden = true; // the panel covers the same corner; its own × closes it
    this.refresh();
  }
  close() {
    this.panel.hidden = true;
    this.toggleBtn.hidden = false;
  }

  async refresh() {
    if (!this.canvasId) return;
    this._revokeAll();
    const items = await listPocketMeta(this.canvasId);
    if (!items.length) {
      this.grid.innerHTML = `<p class="pocket-grid__empty">nothing saved yet — add a photo, document, or video to keep here until you're ready to place it.</p>`;
      return;
    }
    this.grid.innerHTML = items.map(cardHTML).join("");
    // Lazily fill in real photo thumbnails (listPocketMeta strips blobs to stay cheap).
    for (const meta of items.filter((m) => m.kind === "photo")) {
      getPocketBlobURL(meta.id).then((url) => {
        if (!url) return;
        this.objectUrls.add(url);
        const thumb = this.grid.querySelector(`.pocket-card[data-id="${meta.id}"] .pocket-card__thumb`);
        if (thumb) thumb.style.backgroundImage = `url(${url})`;
      });
    }
  }

  async _onGridClick(e) {
    const card = e.target.closest(".pocket-card");
    if (!card) return;
    const id = card.dataset.id;
    const act = e.target.dataset.act;
    if (act === "delete") {
      if (confirm("Remove this from your pocket?")) {
        await removeFromPocket(id);
        this.refresh();
      }
    } else if (act === "view") {
      this._preview(id);
    } else if (act === "place") {
      const record = await getPocketItem(id);
      if (record) this.onPlace(record);
    } else if (act === "geo") {
      const record = await getPocketItem(id);
      openGeotagPopover(e.target, record?.location || null, async (loc) => {
        await setPocketLocation(id, loc);
        this.refresh();
      });
    }
  }

  async _preview(id) {
    const rec = await getPocketItem(id);
    if (!rec) return;
    if (rec.kind === "youtube") {
      this.previewBody.innerHTML = `<iframe class="pocket-preview__yt" src="${youtubeEmbedUrl(rec.videoId, { autoplay: true })}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen frameborder="0"></iframe>`;
      this.preview.hidden = false;
      return;
    }
    const url = URL.createObjectURL(rec.blob);
    this.objectUrls.add(url);
    this.previewBody.innerHTML =
      rec.kind === "photo" ? `<img src="${url}" alt="${escapeHtml(rec.name)}" />`
      : rec.kind === "video" ? `<video src="${url}" controls autoplay></video>`
      : `<p>${escapeHtml(rec.name)}</p><a href="${url}" target="_blank" rel="noopener">open “${escapeHtml(rec.name)}”</a>`;
    this.preview.hidden = false;
  }
  closePreview() {
    this.preview.hidden = true;
    this.previewBody.innerHTML = "";
  }

  _revokeAll() {
    for (const u of this.objectUrls) URL.revokeObjectURL(u);
    this.objectUrls.clear();
  }
}

function cardHTML(meta) {
  const icon = meta.kind === "video" ? "🎬" : meta.kind === "doc" ? "📄" : meta.kind === "youtube" ? "▶" : "🖼";
  const hasInlineThumb = meta.kind === "youtube" && meta.thumbnailUrl;
  return `
    <div class="pocket-card" data-id="${meta.id}">
      <button type="button" class="pocket-card__thumb" data-kind="${meta.kind}" data-act="view"
        ${hasInlineThumb ? `style="background-image:url(${meta.thumbnailUrl})"` : ""}
        >${meta.kind === "photo" || hasInlineThumb ? "" : icon}</button>
      <div class="pocket-card__name" title="${escapeHtml(meta.name)}">${escapeHtml(meta.name)}</div>
      ${meta.location
        ? `<button type="button" class="pocket-card__geo" data-act="geo">📍 ${escapeHtml(meta.location.label || formatCoords(meta.location))}</button>`
        : `<button type="button" class="pocket-card__geo pocket-card__geo--empty" data-act="geo">📍 tag location</button>`}
      <div class="pocket-card__row">
        <button type="button" data-act="place">add to canvas</button>
        <button type="button" class="pocket-card__del" data-act="delete" aria-label="Delete">×</button>
      </div>
    </div>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
