// items.js — everything that lives on the canvas.
//
// Every item is the same kind of citizen: a shape, a cut-out photo, or a
// text note. Any item can be drawn on, can have text, and can hold attached
// notes that reveal/hide when you tap it — and those notes are themselves
// full items, so the nesting goes as deep as you like.

import { items, save, addItem, removeItem, newId, openCanvas } from "./store.js";
import { openGeotagPopover, formatCoords } from "../geotag/geotag.js";
import { youtubeEmbedUrl } from "../youtube/youtube.js";

const MIN_SIZE = 24;
const TAP_SLOP = 5; // px of movement still counts as a tap, not a drag

// Base fill color (as r,g,b) per item type, matching the CSS defaults, so
// the opacity slider can fade the fill without touching its content.
const FILL_RGB = { rect: "233,201,163", circle: "205,217,195", text: "255,253,247", file: "239,231,210", link: "251,248,242" };
const DEFAULT_OPACITY = { rect: 1, circle: 1, text: 0.82, image: 1, file: 1, youtube: 1, link: 1 };

export class ItemLayer {
  constructor(worldEl, viewport) {
    this.world = worldEl;
    this.vp = viewport;
    this.nodes = new Map(); // id -> element
    this.selected = null;
    this.drawMode = false;
    this.color = "#b04b4b";
    this.onSelect = null;     // hook: notified with the newly selected id (or null)
    this.groupBg = null;      // background layer, so grouped backgrounds travel with groups
    this.onVisibility = null; // hook: fired when expand/collapse changes what's visible
    this.onRemove = null;     // hook: fired with the ids removed by a delete
    this.resolveFileUrl = null; // hook: async(pocketId) -> blob URL, for 'file' items (docs/videos from the pocket)
    this.getPocketDropRect = null; // hook: () -> DOMRect | null — where "drag to pocket" drops
    this.onSendToPocket = null;    // hook: async(item) -> boolean — true if the pocket accepted it

    this.bar = document.getElementById("itemBar");
    this._wireBar();

    viewport.vp.addEventListener("pointerdown", (e) => {
      if (e.target === viewport.vp) this.select(null);
    });

    for (const it of items) this._render(it);
    this._applyVisibility();
  }

  // Swap the whole canvas: clear the current nodes and render another canvas's
  // items. The store rebinds `items` to the opened canvas.
  loadCanvas(id) {
    for (const el of this.nodes.values()) el.remove();
    this.nodes.clear();
    this.selected = null;
    this.drawMode = false;
    this._hideBar();
    openCanvas(id);
    for (const it of items) this._render(it);
    this._applyVisibility();
  }

  // ---------- tree helpers (recursive grouping) ----------
  _children(id) {
    return items.filter((it) => it.parentId === id);
  }
  _descendants(id) {
    const out = [];
    const walk = (pid) => {
      for (const c of this._children(pid)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }
  _get(id) {
    return items.find((it) => it.id === id);
  }
  _visible(item) {
    // Visible only if every ancestor up the chain is expanded.
    let p = item.parentId;
    while (p) {
      const parent = this._get(p);
      if (!parent || !parent.expanded) return false;
      p = parent.parentId;
    }
    return true;
  }

  // Public: does this item have attached notes?
  hasChildren(id) {
    return this._children(id).length > 0;
  }
  // Public: is this group "open" — expanded and itself visible? A grouped
  // background binds to / shows with an open group.
  isOpen(id) {
    const item = this._get(id);
    return !!(item && item.expanded && this._visible(item));
  }

  // ---------- creating ----------
  // For type 'file' (a document/video placed from the pocket), pass
  // { pocketId, name, mime, location } instead of src/text.
  // For type 'youtube', pass { videoId, title, thumbnailUrl, location }.
  // For type 'link' (any other URL), pass { url, name, domain, faviconUrl, location }.
  add(type, { src, w, h, text, parentId, near, pocketId, name, mime, location, videoId, title, thumbnailUrl, url, domain, faviconUrl } = {}) {
    // Type-specific defaults must be resolved BEFORE the generic 160x160
    // fallback below, or `w || 160` there clobbers them and every text/file/
    // youtube/link item silently reverts to a square 160x160 (a real bug we hit).
    if (type === "text") {
      w = w || 200;
      h = h || 60;
    } else if (type === "file") {
      w = w || 180;
      h = h || 90;
    } else if (type === "youtube") {
      w = w || 240;
      h = h || 176;
    } else if (type === "link") {
      w = w || 200;
      h = h || 68;
    }
    let x, y;
    if (near) {
      x = near.x;
      y = near.y;
    } else {
      const c = this.vp.centerWorld();
      w = w || 160;
      h = h || 160;
      x = Math.round(c.x - w / 2);
      y = Math.round(c.y - h / 2);
    }
    const item = addItem({
      id: newId(),
      type,
      x: Math.round(x),
      y: Math.round(y),
      w: w || 160,
      h: h || 160,
      ...(src ? { src } : {}),
      ...(type === "text" ? { text: text ?? "", color: this.color } : {}),
      ...(type === "file" ? { pocketId, name: name || "file", mime: mime || "" } : {}),
      ...(type === "youtube" ? { videoId, title: title || "", thumbnailUrl: thumbnailUrl || "" } : {}),
      ...(type === "link" ? { url, name: name || domain || "link", domain: domain || "", faviconUrl: faviconUrl || "" } : {}),
      ...(parentId ? { parentId } : {}),
      ...(location ? { location } : {}),
    });
    const el = this._render(item);
    this._applyVisibility();
    this.select(item.id);
    if (type === "text") this._editText(item, el);
    return item;
  }

  // ---------- rendering ----------
  _render(item) {
    const el = document.createElement("div");
    el.className = `item item--${item.type}`;
    el.dataset.id = item.id;
    this._layout(el, item);

    if (item.type === "image") {
      const img = document.createElement("img");
      img.src = item.src;
      img.alt = "";
      el.appendChild(img);
    }
    if (item.type === "text") {
      const t = document.createElement("div");
      t.className = "text-body";
      t.textContent = item.text || "";
      t.style.color = item.color || this.color;
      el.appendChild(t);
    }
    let fileOpen = null;
    if (item.type === "file") {
      const card = document.createElement("div");
      card.className = "file-card";
      const isVideo = (item.mime || "").startsWith("video/");
      card.innerHTML = `
        <span class="file-card__icon">${isVideo ? "🎬" : "📄"}</span>
        <span class="file-card__name"></span>
        <button type="button" class="file-card__open">open</button>`;
      card.querySelector(".file-card__name").textContent = item.name || "file";
      el.appendChild(card);
      fileOpen = card.querySelector(".file-card__open");
    }
    let ytPoster = null;
    if (item.type === "youtube") {
      const ytCard = document.createElement("div");
      ytCard.className = "yt-card";
      ytPoster = this._buildYtPoster(item);
      ytCard.append(ytPoster, ytTitleEl(item));
      el.appendChild(ytCard);
    }
    let linkOpen = null;
    if (item.type === "link") {
      const card = document.createElement("div");
      card.className = "link-card";
      const favicon = document.createElement("div");
      favicon.className = "link-card__favicon";
      if (item.faviconUrl) favicon.style.backgroundImage = `url(${item.faviconUrl})`;
      else favicon.textContent = "🔗";
      const text = document.createElement("div");
      text.className = "link-card__text";
      const title = document.createElement("div");
      title.className = "link-card__title";
      title.textContent = item.name || item.domain || "link";
      const domain = document.createElement("div");
      domain.className = "link-card__domain";
      domain.textContent = item.domain || "";
      text.append(title, domain);
      linkOpen = document.createElement("button");
      linkOpen.type = "button";
      linkOpen.className = "link-card__open";
      linkOpen.textContent = "open";
      card.append(favicon, text, linkOpen);
      el.appendChild(card);
    }

    // A "buried" link: any item can carry one (item.embed). A YouTube link
    // plays inline right over the item on tap; any other link just opens in
    // a new tab on tap (older saved items with no .kind predate this and are
    // always YouTube — see isYoutubeEmbed()). By default the item stays
    // invisible — it looks exactly like its normal content — until tapped.
    // Optionally, its preview image (video thumbnail, or the page's favicon)
    // can show as a translucent wash instead of staying fully hidden
    // (item.embed.showThumbnail + .thumbnailOpacity).
    let embedOverlay = null;
    if (item.embed) {
      const isYt = isYoutubeEmbed(item.embed);
      const previewUrl = isYt ? item.embed.thumbnailUrl : item.embed.faviconUrl;
      if (item.embed.showThumbnail && previewUrl) {
        const thumbLayer = document.createElement("div");
        thumbLayer.className = "embed-thumb-layer";
        if (!isYt) thumbLayer.classList.add("embed-thumb-layer--icon"); // a favicon shouldn't stretch to cover
        thumbLayer.style.backgroundImage = `url(${previewUrl})`;
        thumbLayer.style.opacity = item.embed.thumbnailOpacity ?? 1;
        el.appendChild(thumbLayer);
      }

      const embedBadge = document.createElement("div");
      embedBadge.className = "embed-badge";
      embedBadge.title = item.embed.title || (isYt ? "Has a video" : "Has a link");
      embedBadge.textContent = isYt ? "▶" : "🔗";
      el.appendChild(embedBadge);

      embedOverlay = document.createElement("div");
      embedOverlay.className = "embed-overlay";
      el.appendChild(embedOverlay);
    }

    // Geotag pin — shown on any item with a saved location.
    const geo = document.createElement("button");
    geo.type = "button";
    geo.className = "geo-badge";
    geo.title = "Where this lived";
    geo.textContent = "📍";
    el.appendChild(geo);

    // Ink overlay (freehand drawing). Stretches with the item.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ink");
    svg.setAttribute("viewBox", "0 0 1000 1000");
    svg.setAttribute("preserveAspectRatio", "none");
    el.appendChild(svg);
    this._renderStrokes(item, svg);

    // Badge showing attached-note count + expand state.
    const badge = document.createElement("div");
    badge.className = "badge";
    el.appendChild(badge);

    const del = document.createElement("button");
    del.className = "delete";
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", "Delete");
    el.appendChild(del);

    const handle = document.createElement("div");
    handle.className = "handle";
    el.appendChild(handle);

    this._applyFill(el, item);
    this._wire(el, item, { svg, handle, del, badge, geo, fileOpen, linkOpen, ytPoster, embedOverlay });
    this.world.appendChild(el);
    this.nodes.set(item.id, el);
    this._updateBadge(item);
    this._updateGeoBadge(item);
    return el;
  }

  _updateGeoBadge(item) {
    const el = this.nodes.get(item.id);
    if (!el) return;
    const geo = el.querySelector(".geo-badge");
    if (!geo) return;
    geo.style.display = item.location ? "" : "none";
    geo.title = item.location
      ? `${item.location.label || "Where this lived"} — ${formatCoords(item.location)}`
      : "Where this lived";
  }

  // Fades just the shape's fill / wash — text, ink, image, and controls
  // stay fully visible so text placed on a lighter shape reads clearly.
  _applyFill(el, item) {
    const op = item.opacity ?? DEFAULT_OPACITY[item.type] ?? 1;
    if (item.type === "image") {
      const img = el.querySelector("img");
      if (img) img.style.opacity = op;
      return;
    }
    const rgb = FILL_RGB[item.type];
    if (rgb) el.style.backgroundColor = `rgba(${rgb}, ${op})`;
  }

  // A YouTube item shows a poster (its thumbnail) until played. The poster
  // itself has NO click/drag handling of its own — it participates in the
  // ordinary body pointerdown handler below like any other item content, so
  // dragging it works exactly like dragging anything else. Playing is
  // triggered from there too (a tap that didn't move). Giving the poster its
  // own stopPropagation()'d click handler was the earlier bug: it ate every
  // pointerdown before a drag could ever begin, so the item couldn't be moved.
  _buildYtPoster(item) {
    const poster = document.createElement("button");
    poster.type = "button";
    poster.className = "yt-card__poster";
    if (item.thumbnailUrl) poster.style.backgroundImage = `url(${item.thumbnailUrl})`;
    const play = document.createElement("span");
    play.className = "yt-card__play";
    play.textContent = "▶";
    poster.appendChild(play);
    return poster;
  }

  _setYtPlaying(card, item, playing) {
    card.innerHTML = "";
    if (!playing) {
      card.append(this._buildYtPoster(item), ytTitleEl(item));
      return;
    }
    const { iframe, close } = this._buildEmbedIframe(item.videoId, () => this._setYtPlaying(card, item, false));
    iframe.className = "yt-card__iframe";
    close.className = "yt-card__shrink";
    close.title = "Back to thumbnail";
    close.textContent = "⤡";
    card.append(iframe, close);
  }

  // Shared by the dedicated 'youtube' item's poster AND any item carrying a
  // "buried" item.embed — both just need an iframe + a way to stop it.
  //
  // Deliberately NOT allowing fullscreen: the browser's Fullscreen API
  // replaces the entire screen with just the fullscreened element's own
  // subtree — nothing outside it (including our close button, which lives
  // outside the iframe, since it's foreign YouTube content we can't inject
  // into) can render on top. Once someone taps the player's own fullscreen
  // button there is no way back except the OS/browser's own exit gesture,
  // which isn't reliable across every device — so this content never enters
  // true fullscreen, keeping our own close button always reachable instead.
  _buildEmbedIframe(videoId, onClose) {
    const iframe = document.createElement("iframe");
    iframe.src = youtubeEmbedUrl(videoId, { autoplay: true });
    iframe.allow = "autoplay; encrypted-media; picture-in-picture";
    iframe.setAttribute("frameborder", "0");
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      onClose();
    });
    return { iframe, close };
  }

  // "Bury" a link into any item (e.g. a photo): it stays looking exactly
  // like its normal content until tapped. A YouTube link plays right over
  // it, in place — since it's the SAME item, moving it moves the video too.
  // Any other link just opens in a new tab (most sites can't be framed).
  _activateEmbed(overlay, item) {
    if (!item.embed) return;
    if (!isYoutubeEmbed(item.embed)) {
      window.open(item.embed.url, "_blank", "noopener");
      return;
    }
    if (!overlay || overlay.classList.contains("is-active")) return;
    const { iframe, close } = this._buildEmbedIframe(item.embed.videoId, () => {
      overlay.classList.remove("is-active");
      overlay.innerHTML = "";
    });
    iframe.className = "embed-overlay__iframe";
    close.className = "embed-overlay__close";
    close.title = "Stop video";
    overlay.append(iframe, close);
    overlay.classList.add("is-active");
  }

  _layout(el, item) {
    el.style.left = item.x + "px";
    el.style.top = item.y + "px";
    el.style.width = item.w + "px";
    el.style.height = item.h + "px";
  }

  _renderStrokes(item, svg) {
    svg.innerHTML = "";
    for (const s of item.strokes || []) svg.appendChild(strokePath(s));
  }

  _updateBadge(item) {
    const el = this.nodes.get(item.id);
    if (!el) return;
    const badge = el.querySelector(".badge");
    const n = this._children(item.id).length;
    if (n === 0) {
      badge.style.display = "none";
      el.classList.remove("has-notes");
    } else {
      badge.style.display = "";
      badge.textContent = (item.expanded ? "▾ " : "▸ ") + n;
      el.classList.add("has-notes");
    }
  }

  // ---------- visibility (collapse/expand) ----------
  _applyVisibility() {
    for (const it of items) {
      const el = this.nodes.get(it.id);
      if (!el) continue;
      el.classList.toggle("is-hidden", !this._visible(it));
    }
    if (this.selected && !this._visible(this._get(this.selected))) {
      this.select(null);
    }
    this.onVisibility?.(); // grouped backgrounds follow expand/collapse
  }

  toggleExpand(item) {
    item.expanded = !item.expanded;
    this._updateBadge(item);
    this._applyVisibility();
    save();
  }

  // ---------- selection + contextual bar ----------
  select(id) {
    if (id === this.selected) return; // re-affirming keeps draw mode intact
    if (this.selected) this.nodes.get(this.selected)?.classList.remove("is-selected");
    this.drawMode = false; // only reset when switching to a different item
    this.selected = id;
    if (id) {
      const el = this.nodes.get(id);
      el?.classList.add("is-selected");
      this.world.appendChild(el); // bring to front
      this._showBar();
    } else {
      this._hideBar();
    }
    this._reflectDrawState();
    this.onSelect?.(id);
  }

  _showBar() {
    this.bar.hidden = false;
    const item = this._get(this.selected);
    this.bar.querySelector("#inkColor").value = item?.color || this.color;
    const def = DEFAULT_OPACITY[item?.type] ?? 1;
    this.bar.querySelector("#itemOpacity").value = Math.round((item?.opacity ?? def) * 100);
    this.bar.querySelector('[data-act="geo"]').classList.toggle("is-on", !!item?.location);
    this.bar.querySelector('[data-act="embed"]').classList.toggle("is-on", !!item?.embed);
    this.positionBar();
  }
  _hideBar() {
    this.bar.hidden = true;
  }
  positionBar() {
    if (this.bar.hidden || !this.selected) return;
    const item = this._get(this.selected);
    if (!item) return;
    const s = this.vp.scale;
    let sx = this.vp.x + (item.x + item.w / 2) * s;
    let sy = this.vp.y + item.y * s - this.bar.offsetHeight - 12;
    // Clamp on-screen so a very large or panned-away item can't push the
    // bar (draw/note/opacity controls) out of reach.
    const barW = this.bar.offsetWidth || 200;
    const barH = this.bar.offsetHeight || 40;
    sx = Math.min(Math.max(sx, barW / 2 + 8), window.innerWidth - barW / 2 - 8);
    sy = Math.min(Math.max(sy, 8), window.innerHeight - barH - 8);
    this.bar.style.left = sx + "px";
    this.bar.style.top = sy + "px";
  }

  _wireBar() {
    this.bar.querySelector("#inkColor").addEventListener("input", (e) =>
      this.setColor(e.target.value)
    );
    this.bar.querySelector("#itemOpacity").addEventListener("input", (e) =>
      this.setOpacity(e.target.value / 100)
    );
    this.bar.querySelector('[data-act="draw"]').addEventListener("click", () => {
      this.drawMode = !this.drawMode;
      this._reflectDrawState();
    });
    this.bar.querySelector('[data-act="note"]').addEventListener("click", () =>
      this.attachNote()
    );
    this.bar.querySelector('[data-act="duplicate"]').addEventListener("click", () => {
      const item = this._get(this.selected);
      if (item) this.duplicate(item);
    });
    this.bar.querySelector('[data-act="geo"]').addEventListener("click", (e) => {
      const item = this._get(this.selected);
      if (!item) return;
      openGeotagPopover(e.currentTarget, item.location || null, (loc) => {
        if (loc) item.location = loc;
        else delete item.location;
        this._updateGeoBadge(item);
        save();
      });
    });
    this.bar.querySelector('[data-act="embed"]').addEventListener("click", async (e) => {
      const anchorEl = e.currentTarget; // capture before the await — currentTarget goes null once dispatch ends
      const item = this._get(this.selected);
      if (!item) return;
      const { openEmbedPrompt } = await import("../links/links.js");
      openEmbedPrompt(
        anchorEl,
        item.embed || null,
        (embed) => {
          item.embed = embed;
          save();
          this._reRender(item);
        },
        () => {
          delete item.embed;
          save();
          this._reRender(item);
        }
      );
    });
  }

  // Rebuild an item's DOM in place after a data change (e.g. its embed) that
  // isn't worth a targeted patch — re-selects it afterward if it was selected.
  _reRender(item) {
    const wasSelected = this.selected === item.id;
    this.nodes.get(item.id)?.remove();
    this.nodes.delete(item.id);
    this._render(item);
    this._updateBadge(item);
    this._updateGeoBadge(item);
    if (wasSelected) {
      this.selected = null;
      this.select(item.id);
    }
  }

  _reflectDrawState() {
    this.bar.querySelector('[data-act="draw"]').classList.toggle("is-on", this.drawMode);
    if (this.selected) {
      this.nodes.get(this.selected)?.classList.toggle("is-drawing", this.drawMode);
    }
  }

  setColor(c) {
    this.color = c;
    const item = this._get(this.selected);
    if (item?.type === "text") {
      item.color = c;
      this.nodes.get(item.id).querySelector(".text-body").style.color = c;
      save();
    }
  }

  setOpacity(op) {
    const item = this._get(this.selected);
    if (!item) return;
    item.opacity = op;
    this._applyFill(this.nodes.get(item.id), item);
    save();
  }

  attachNote() {
    const parent = this._get(this.selected);
    if (!parent) return;
    parent.expanded = true;
    const note = this.add("text", {
      parentId: parent.id,
      text: "",
      near: { x: parent.x + parent.w + 28, y: parent.y },
    });
    this._updateBadge(parent);
    this._applyVisibility();
    return note;
  }

  // Clone an item — everything about it (color, opacity, strokes, location,
  // embed…) except its id and position, offset a little so the copy is
  // visibly distinct rather than sitting exactly on top of the original.
  // A duplicate never carries over the original's own attached notes — it
  // starts fresh, even if the original had children.
  duplicate(item) {
    const clone = JSON.parse(JSON.stringify(item));
    clone.id = newId();
    clone.x = item.x + 24;
    clone.y = item.y + 24;
    delete clone.expanded;
    const added = addItem(clone);
    this._render(added);
    this._applyVisibility();
    this.select(added.id);
    return added;
  }

  // ---------- per-item interaction ----------
  _wire(el, item, { svg, handle, del, badge, geo, fileOpen, linkOpen, ytPoster, embedOverlay }) {
    badge.style.pointerEvents = "none";

    // Geotag pin — click to view/edit where this item's subject lived.
    geo.addEventListener("pointerdown", (e) => e.stopPropagation());
    geo.addEventListener("click", (e) => {
      e.stopPropagation();
      openGeotagPopover(geo, item.location || null, (loc) => {
        if (loc) item.location = loc;
        else delete item.location;
        this._updateGeoBadge(item);
        save();
      });
    });

    // File cards (docs/videos placed from the pocket) open on their own button.
    if (fileOpen) {
      fileOpen.addEventListener("pointerdown", (e) => e.stopPropagation());
      fileOpen.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!this.resolveFileUrl || !item.pocketId) { alert("This file isn't available."); return; }
        const url = await this.resolveFileUrl(item.pocketId);
        if (url) window.open(url, "_blank", "noopener");
        else alert("This file is no longer in your pocket.");
      });
    }

    // Link cards (any saved URL) open directly — no blob to resolve, it's just a link.
    if (linkOpen) {
      linkOpen.addEventListener("pointerdown", (e) => e.stopPropagation());
      linkOpen.addEventListener("click", (e) => {
        e.stopPropagation();
        window.open(item.url, "_blank", "noopener");
      });
    }

    // Body: draw, move, or tap-to-toggle depending on mode/state. A tap (no
    // movement) on a YouTube poster, or on any item carrying a buried
    // item.embed, plays the video — but a drag still moves the item first,
    // since a tap is only decided by whether the pointer actually moved.
    el.addEventListener("pointerdown", (e) => {
      if (e.target === handle || e.target === del || e.target === geo || e.target === fileOpen || e.target === linkOpen) return;
      if (e.target.isContentEditable) return; // editing text
      if (embedOverlay?.classList.contains("is-active") || e.target.closest?.(".yt-card__iframe, .embed-overlay__iframe, .yt-card__shrink, .embed-overlay__close")) return; // let the live embed / its controls handle their own input
      e.stopPropagation();
      const wasSelected = this.selected === item.id;
      const tappedPoster = !!(ytPoster && (e.target === ytPoster || ytPoster.contains(e.target)));
      this.select(item.id);

      if (this.drawMode) return this._startStroke(e, el, item, svg);

      el.setPointerCapture(e.pointerId);
      const kids = this._descendants(item.id).map((k) => ({
        k,
        node: this.nodes.get(k.id),
        ix: k.x,
        iy: k.y,
      }));
      // Backgrounds attached anywhere in this subtree move with it.
      const affected = new Set([item.id, ...kids.map((c) => c.k.id)]);
      this.groupBg?.beginGroupDrag(affected);
      const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y };
      let moved = false;
      // Dragging one of these onto the pocket (open panel, or its toggle
      // button when closed) sends it back and removes it from the canvas —
      // the reverse of "add to canvas". Plain shapes/text/notes have no
      // pocket equivalent, so they're never eligible drop sources.
      const pocketEligible = ["youtube", "link", "file", "image"].includes(item.type);
      let overPocket = false;

      const onMove = (ev) => {
        const dx = (ev.clientX - start.x) / this.vp.scale;
        const dy = (ev.clientY - start.y) / this.vp.scale;
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > TAP_SLOP) moved = true;
        item.x = Math.round(start.ix + dx);
        item.y = Math.round(start.iy + dy);
        this._layout(el, item);
        for (const c of kids) {
          c.k.x = Math.round(c.ix + dx);
          c.k.y = Math.round(c.iy + dy);
          this._layout(c.node, c.k);
        }
        this.groupBg?.groupDragTo(dx, dy);
        this.positionBar();
        if (pocketEligible && this.getPocketDropRect) {
          const r = this.getPocketDropRect();
          overPocket = !!(r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom);
          el.classList.toggle("is-over-pocket", overPocket);
        }
      };
      const onUp = (ev) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        this.groupBg?.endGroupDrag();
        el.classList.remove("is-over-pocket");
        if (moved && overPocket && pocketEligible && this.onSendToPocket) {
          this.onSendToPocket(item).then((handled) => {
            if (handled) this.remove(item.id);
            else save(); // pocket couldn't take it — leave it where it was dropped
          });
          return;
        }
        if (moved) {
          save();
        } else if (wasSelected && this._children(item.id).length) {
          this.toggleExpand(item);
        } else if (tappedPoster && item.type === "youtube") {
          this._setYtPlaying(el.querySelector(".yt-card"), item, true);
        } else if (item.embed && embedOverlay && !embedOverlay.classList.contains("is-active")) {
          this._activateEmbed(embedOverlay, item);
        }
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });

    // Double-click a text note to edit it.
    if (item.type === "text") {
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this._editText(item, el);
      });
    }

    // Resize via the corner handle.
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.select(item.id);
      handle.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, w: item.w, h: item.h };
      const keepSquare = item.type === "circle";
      const onMove = (ev) => {
        const dx = (ev.clientX - start.x) / this.vp.scale;
        const dy = (ev.clientY - start.y) / this.vp.scale;
        if (keepSquare) {
          const d = Math.max(start.w + dx, start.h + dy);
          item.w = item.h = Math.max(MIN_SIZE, Math.round(d));
        } else {
          item.w = Math.max(MIN_SIZE, Math.round(start.w + dx));
          item.h = Math.max(MIN_SIZE, Math.round(start.h + dy));
        }
        this._layout(el, item);
        this.positionBar();
      };
      const onUp = (ev) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        save();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });

    // Delete this item and everything attached beneath it — confirm first,
    // since there's no undo once it's gone.
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const noteCount = this._descendants(item.id).length;
      const msg = noteCount
        ? `Delete this and its ${noteCount} attached note${noteCount === 1 ? "" : "s"}? This can't be undone.`
        : "Delete this? This can't be undone.";
      if (confirm(msg)) this.remove(item.id);
    });
  }

  _editText(item, el) {
    const body = el.querySelector(".text-body");
    body.contentEditable = "true";
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const finish = () => {
      body.contentEditable = "false";
      item.text = body.textContent.trim();
      body.removeEventListener("blur", finish);
      save();
    };
    body.addEventListener("blur", finish);
  }

  _startStroke(e, el, item, svg) {
    el.setPointerCapture(e.pointerId);
    const stroke = { color: this.color, points: [] };
    item.strokes = item.strokes || [];
    item.strokes.push(stroke);
    const path = strokePath(stroke);
    svg.appendChild(path);

    const addPoint = (ev) => {
      const w = this.vp.screenToWorld(ev.clientX, ev.clientY);
      const nx = clamp01((w.x - item.x) / item.w);
      const ny = clamp01((w.y - item.y) / item.h);
      stroke.points.push([+nx.toFixed(4), +ny.toFixed(4)]);
      path.setAttribute("d", strokeD(stroke));
    };
    addPoint(e);
    const onMove = (ev) => addPoint(ev);
    const onUp = (ev) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      if (stroke.points.length < 2) item.strokes.pop(), path.remove();
      save();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  remove(id) {
    const removed = [id, ...this._descendants(id).map((d) => d.id)];
    for (const d of this._descendants(id)) {
      this.nodes.get(d.id)?.remove();
      this.nodes.delete(d.id);
      removeItem(d.id);
    }
    const parentId = this._get(id)?.parentId;
    this.nodes.get(id)?.remove();
    this.nodes.delete(id);
    removeItem(id);
    if (this.selected === id) this.select(null);
    if (parentId) this._updateBadge(this._get(parentId));
    this.onRemove?.(removed); // drop any backgrounds bound to this subtree
  }
}

// ---- youtube helpers ----
function ytTitleEl(item) {
  const t = document.createElement("div");
  t.className = "yt-card__title";
  t.textContent = item.title || "YouTube video";
  return t;
}

// An item.embed with no .kind predates the generic-link version of this
// feature and was always YouTube — treat that as youtube too, not just an
// explicit kind:'youtube', so existing saved canvases keep working.
function isYoutubeEmbed(embed) {
  return !embed.kind || embed.kind === "youtube";
}

// ---- stroke helpers ----
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function strokeD(s) {
  return s.points
    .map(([x, y], i) => `${i ? "L" : "M"}${(x * 1000).toFixed(1)} ${(y * 1000).toFixed(1)}`)
    .join(" ");
}
function strokePath(s) {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", strokeD(s));
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", s.color);
  p.setAttribute("stroke-width", "14");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  return p;
}
