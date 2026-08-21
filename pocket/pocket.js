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
import { youtubeEmbedUrl } from "../youtube/youtube.js";
import { openLinkPrompt } from "../links/links.js";

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

/**
 * Add a link (from links.js's resolveLink) to a canvas's pocket — YouTube or
 * any other site. No blob, just the small bits needed to show and open it.
 */
export async function addLinkToPocket(canvasId, link) {
  const record =
    link.kind === "youtube"
      ? {
          id: newId(), canvasId, kind: "youtube",
          videoId: link.videoId,
          name: link.title || "YouTube video",
          url: link.url,
          thumbnailUrl: link.thumbnailUrl,
          createdAt: Date.now(),
          location: null,
        }
      : {
          id: newId(), canvasId, kind: "link",
          name: link.title || link.domain,
          url: link.url,
          domain: link.domain,
          faviconUrl: link.faviconUrl,
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

/**
 * Send a canvas item back into the pocket — the reverse of "add to canvas".
 * Returns true if it was handled (caller should then remove the item from
 * the canvas), false if this item type has nothing sensible to return to
 * the pocket (a plain shape, a note, text — those just aren't pocket things).
 */
export async function sendItemToPocket(canvasId, item) {
  let newRecordId = null;
  if (item.type === "youtube") {
    newRecordId = await addLinkToPocket(canvasId, {
      kind: "youtube", videoId: item.videoId, title: item.title,
      thumbnailUrl: item.thumbnailUrl, url: `https://www.youtube.com/watch?v=${item.videoId}`,
    });
  } else if (item.type === "link") {
    newRecordId = await addLinkToPocket(canvasId, {
      kind: "link", title: item.name, faviconUrl: item.faviconUrl, domain: item.domain, url: item.url,
    });
  } else if (item.type === "file") {
    // Placing never deletes the original pocket record, so it's likely still
    // there — just confirm before telling the caller it's safe to drop the
    // canvas item (otherwise the file would vanish from both places).
    return !!(item.pocketId && (await getPocketItem(item.pocketId)));
  } else if (item.type === "image" && item.src) {
    // The item only carries a data URL — turn it back into a real Blob.
    const blob = await (await fetch(item.src)).blob();
    const file = new File([blob], "cutout.png", { type: blob.type || "image/png" });
    newRecordId = await addToPocket(canvasId, file);
  } else {
    return false; // rect/circle/text/notes have no pocket equivalent
  }
  if (newRecordId && item.location) await setPocketLocation(newRecordId, item.location);
  return true;
}

// ---------------- panel UI ----------------
// Reads its markup from index.html (#pocketToggle / #pocketPanel / #pocketGrid
// / #pocketAdd / #pocketPreview*) the same way ItemLayer reads #itemBar.

export class PocketPanel {
  constructor({ onPlace } = {}) {
    this.onPlace = onPlace || (() => {});
    this.canvasId = null;
    this.onOpenLink = null; // hook: (url, title) -> void — opens the in-app browser, if wired
    this.worldPointFromScreen = null; // hook: (clientX, clientY) -> {x,y} world coords, for drag-to-canvas
    this.objectUrls = new Set(); // revoked on refresh/teardown to avoid leaking memory
    this._justDragged = false; // suppresses the click-based "view" firing right after a real drag

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
      openLinkPrompt(this.addLinkBtn, async (link) => {
        await addLinkToPocket(this.canvasId, link);
        this.refresh();
      });
    });

    this.grid.addEventListener("click", (e) => this._onGridClick(e));
    this.grid.addEventListener("pointerdown", (e) => this._onThumbPointerDown(e));
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

  /** The current drop target for "drag an item back into the pocket" — the
   *  open panel if it's showing, otherwise the toggle button itself. */
  getDropRect() {
    return this.panel.hidden ? this.toggleBtn.getBoundingClientRect() : this.panel.getBoundingClientRect();
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
    if (this._justDragged) { this._justDragged = false; return; } // a real drag already handled this pointer's up
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

  // Drag a card's thumbnail out onto the canvas to place it there directly —
  // release over the pocket itself (or anywhere that isn't the canvas) and
  // nothing happens, same as just letting go of a plain tap. A tap under the
  // movement threshold still falls through to the normal click-based "view".
  _onThumbPointerDown(e) {
    const thumb = e.target.closest(".pocket-card__thumb");
    const card = thumb?.closest(".pocket-card");
    const id = card?.dataset.id;
    if (!thumb || !id) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let ghost = null;

    const onMove = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) {
        dragging = true;
        ghost = document.createElement("div");
        ghost.className = "pocket-drag-ghost";
        const bg = thumb.style.backgroundImage;
        if (bg) ghost.style.backgroundImage = bg;
        else ghost.textContent = thumb.textContent;
        document.body.appendChild(ghost);
      }
      if (!ghost) return;
      ghost.style.left = ev.clientX + "px";
      ghost.style.top = ev.clientY + "px";
      const overCanvas = !!document.elementFromPoint(ev.clientX, ev.clientY)?.closest("#viewport");
      ghost.classList.toggle("is-over-canvas", overCanvas);
    };
    const onUp = async (ev) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (!dragging) return;
      ghost?.remove();
      this._justDragged = true;
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (target?.closest("#viewport") && this.worldPointFromScreen) {
        const record = await getPocketItem(id);
        if (record) this.onPlace(record, this.worldPointFromScreen(ev.clientX, ev.clientY));
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  async _preview(id) {
    const rec = await getPocketItem(id);
    if (!rec) return;
    if (rec.kind === "link") {
      // Opens in the in-app browser if wired (falls back to a new tab);
      // some sites still refuse to be framed, but that view always offers
      // "open in new tab" as a fallback.
      if (this.onOpenLink) this.onOpenLink(rec.url, rec.name);
      else window.open(rec.url, "_blank", "noopener");
      return;
    }
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
  const icon = meta.kind === "video" ? "🎬" : meta.kind === "doc" ? "📄" : meta.kind === "youtube" ? "▶" : meta.kind === "link" ? "🔗" : "🖼";
  const isLink = meta.kind === "link";
  const hasInlineThumb = (meta.kind === "youtube" || isLink) && (meta.thumbnailUrl || meta.faviconUrl);
  const thumbStyle = isLink
    ? meta.faviconUrl ? `style="background-image:url(${meta.faviconUrl});background-size:36px 36px;background-repeat:no-repeat;"` : ""
    : hasInlineThumb ? `style="background-image:url(${meta.thumbnailUrl})"` : "";
  return `
    <div class="pocket-card" data-id="${meta.id}" data-kind="${meta.kind}">
      <button type="button" class="pocket-card__thumb" data-kind="${meta.kind}" data-act="view" ${thumbStyle}
        >${meta.kind === "photo" || hasInlineThumb ? "" : icon}</button>
      <div class="pocket-card__name" title="${escapeHtml(meta.name)}">${escapeHtml(meta.name)}</div>
      ${isLink ? `<div class="pocket-card__domain">${escapeHtml(meta.domain || "")}</div>` : ""}
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
