// items.js — everything that lives on the canvas.
//
// Every item is the same kind of citizen: a shape, a cut-out photo, or a
// text note. Any item can be drawn on, can have text, and can hold attached
// notes that reveal/hide when you tap it — and those notes are themselves
// full items, so the nesting goes as deep as you like.

import { items, save, addItem, removeItem, newId, openCanvas } from "./store.js";
import { youtubeEmbedUrl } from "../youtube/youtube.js";
import { pushUndoSnapshot, resetUndo, canUndo, popUndoSnapshot } from "./undo.js";
import { alphaClipPath } from "./silhouette.js";

const MIN_SIZE = 24;
const TAP_SLOP = 5; // px of movement still counts as a tap, not a drag

// Base fill color (as r,g,b) per item type, matching the CSS defaults, so
// the opacity slider can fade the fill without touching its content. Text
// isn't here — its background is its own explicit item.bgColor field (see
// _applyFill), not a shared type default, since text color and text
// background are two independently-editable things, not one "fill."
const FILL_RGB = { rect: "233,201,163", circle: "205,217,195", file: "239,231,210", link: "251,248,242" };
const DEFAULT_OPACITY = { rect: 1, circle: 1, text: 1, image: 1, file: 1, youtube: 1, link: 1 };

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return m ? `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}` : null;
}

export class ItemLayer {
  constructor(worldEl, viewport) {
    this.world = worldEl;
    this.vp = viewport;
    this.nodes = new Map(); // id -> element
    this._shapeClipCache = new Map(); // item.src -> clip-path string | null, computed once per distinct image
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
    this.onOpenLink = null;        // hook: (url, title) -> void — opens the in-app browser, if wired
    this._activeEmbed = null;      // { item, stop() } for whichever embed is currently playing, if any

    this.bar = document.getElementById("itemBar");
    this._wireBar();

    viewport.vp.addEventListener("pointerdown", (e) => {
      if (e.target === viewport.vp) this.select(null);
    });

    // A reliable "exit" that works whether or not the video ever entered
    // real native fullscreen — Escape always stops whatever is playing.
    // Ctrl/Cmd+Z undoes the last edit — but not while actually typing in a
    // text note, where it should mean the browser's own native text undo.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._activeEmbed) this._activeEmbed.stop();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !e.target?.isContentEditable) {
        e.preventDefault();
        this.undo();
      }
    });

    resetUndo();
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
    resetUndo(); // undo history doesn't carry across canvases
    for (const it of items) this._render(it);
    this._applyVisibility();
  }

  // ---------- undo ----------
  undo() {
    if (!canUndo()) return;
    this._activeEmbed?.stop();
    const ok = popUndoSnapshot();
    if (!ok) return;
    for (const el of this.nodes.values()) el.remove();
    this.nodes.clear();
    this.selected = null;
    this._hideBar();
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
  // Either type also takes an optional thumbnailImage (data URL) or
  // thumbnailText — a custom preview overriding the auto-detected one.
  // `near` places the item's top-left at a world point; `nearCenter` places
  // its CENTER there instead (used for "drag from the pocket and drop it
  // here") — works with whatever w/h ends up resolved, default or explicit.
  add(type, { src, w, h, text, parentId, near, nearCenter, pocketId, name, mime, location, videoId, title, thumbnailUrl, url, domain, faviconUrl, thumbnailImage, thumbnailText } = {}) {
    pushUndoSnapshot();
    // Type-specific defaults must be resolved BEFORE the generic 160x160
    // fallback below, or `w || 160` there clobbers them and every text/file/
    // youtube/link item silently reverts to a square 160x160 (a real bug we hit).
    if (type === "text") {
      w = w || 140;
      h = h || 40;
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
    w = w || 160;
    h = h || 160;
    if (near) {
      x = near.x;
      y = near.y;
    } else if (nearCenter) {
      x = Math.round(nearCenter.x - w / 2);
      y = Math.round(nearCenter.y - h / 2);
    } else {
      const c = this.vp.centerWorld();
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
      // imgScale/imgRotate/imgOffsetX/imgOffsetY pan/zoom/rotate the photo
      // *within* its box — independent of the box's own size (w/h).
      ...(type === "image" ? { imgScale: 1, imgRotate: 0, imgOffsetX: 0, imgOffsetY: 0 } : {}),
      // Black on white by default — not tied to whatever the ink/drawing
      // color happens to be set to, which used to leave fresh notes in
      // whatever color you last drew with.
      ...(type === "text" ? { text: text ?? "", color: "#1a1a1a", bgColor: "#ffffff", fontSize: 16 } : {}),
      ...(type === "file" ? { pocketId, name: name || "file", mime: mime || "" } : {}),
      ...(type === "youtube" ? { videoId, title: title || "", thumbnailUrl: thumbnailUrl || "" } : {}),
      ...(type === "link" ? { url, name: name || domain || "link", domain: domain || "", faviconUrl: faviconUrl || "" } : {}),
      ...(type === "youtube" || type === "link" ? { thumbnailImage: thumbnailImage || null, thumbnailText: thumbnailText || null } : {}),
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

    let imageClip = null;
    if (item.type === "image") {
      const clip = document.createElement("div");
      clip.className = "item--image__clip";
      const img = document.createElement("img");
      img.src = item.src;
      img.alt = "";
      clip.appendChild(img);
      el.appendChild(clip);
      this._styleImageContent(el, item);
      this._applyShapeClip(el, item);
      imageClip = clip;
    }
    if (item.type === "text") {
      const t = document.createElement("div");
      t.className = "text-body";
      t.textContent = item.text || "";
      t.style.color = item.color || this.color;
      t.style.fontSize = (item.fontSize || 16) + "px";
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
    let ytCard = null;
    if (item.type === "youtube") {
      ytCard = document.createElement("div");
      ytCard.className = "yt-card";
      ytPoster = this._buildYtPoster(item);
      ytCard.append(ytPoster, ytTitleEl(item), this._buildYtEditBtn());
      el.appendChild(ytCard);
    }
    let linkOpen = null;
    let linkEdit = null;
    if (item.type === "link") {
      const card = document.createElement("div");
      // A custom photo (as opposed to a favicon or a short text label) is
      // substantial enough to BE the item, not sit in a tiny corner icon —
      // the whole card becomes the photo, with the title/link controls
      // floating over it instead of in a row beside a thumbnail.
      card.className = item.thumbnailImage ? "link-card link-card--photo" : "link-card";
      const favicon = document.createElement("div");
      favicon.className = "link-card__favicon";
      this._setLinkFavicon(favicon, item);
      const text = document.createElement("div");
      text.className = "link-card__text";
      const title = document.createElement("div");
      title.className = "link-card__title";
      title.textContent = item.name || item.domain || "link";
      const domain = document.createElement("div");
      domain.className = "link-card__domain";
      domain.textContent = item.domain || "";
      text.append(title, domain);
      linkEdit = document.createElement("button");
      linkEdit.type = "button";
      linkEdit.className = "link-card__edit";
      linkEdit.title = "Edit this link or its thumbnail";
      linkEdit.textContent = "✎";
      linkOpen = document.createElement("button");
      linkOpen.type = "button";
      linkOpen.className = "link-card__open";
      linkOpen.textContent = "open";
      card.append(favicon, text, linkEdit, linkOpen);
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
      const v = embedThumbVisual(item.embed);
      if (item.embed.showThumbnail && v.has) {
        const thumbLayer = document.createElement("div");
        thumbLayer.className = "embed-thumb-layer";
        thumbLayer.classList.toggle("embed-thumb-layer--icon", v.iconMode);
        thumbLayer.classList.toggle("embed-thumb-layer--text", !!v.text);
        if (v.image) thumbLayer.style.backgroundImage = `url(${v.image})`;
        else if (v.text) thumbLayer.textContent = v.text;
        else thumbLayer.style.backgroundImage = `url(${v.url})`;
        thumbLayer.style.opacity = item.embed.thumbnailOpacity ?? 1;
        this._applyClipMask(thumbLayer, item, v);
        el.appendChild(thumbLayer);
      }

      // A real button, not just a decorative indicator — its own dedicated
      // tap target for activating the embed, always reachable regardless of
      // whether the item also has attached notes (see the tap-priority
      // comment below for why the body tap alone can't always be trusted
      // to reach this for a non-YouTube item with no poster of its own).
      const embedBadge = document.createElement("button");
      embedBadge.type = "button";
      embedBadge.className = "embed-badge";
      embedBadge.title = item.embed.title || (isYt ? "Play this video" : "Open this link");
      embedBadge.textContent = isYt ? "▶" : "🔗";
      el.appendChild(embedBadge);

      embedOverlay = document.createElement("div");
      embedOverlay.className = "embed-overlay";
      el.appendChild(embedOverlay);
    }

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
    this._wire(el, item, { svg, handle, del, badge, fileOpen, linkOpen, linkEdit, ytPoster, ytCard, embedOverlay, imageClip });
    this.world.appendChild(el);
    this.nodes.set(item.id, el);
    this._updateBadge(item);
    return el;
  }

  // A photo item's crop is chosen up front now (the studio's "position it"
  // step bakes it straight into the image before placing — see studio.js),
  // so there's no item-bar control for this anymore. This just renders
  // whichever values the item actually has: identity for anything placed
  // since that change, or a real pan/zoom/rotate for an item placed while
  // this WAS still editable after the fact, so it keeps looking right.
  _styleImageContent(el, item) {
    const img = el.querySelector("img");
    if (!img) return;
    const scale = item.imgScale ?? 1;
    const rot = item.imgRotate ?? 0;
    const ox = item.imgOffsetX ?? 0;
    const oy = item.imgOffsetY ?? 0;
    img.style.transform = `translate(-50%, -50%) translate(${ox}px, ${oy}px) rotate(${rot}deg) scale(${scale})`;
  }

  // Traces the cutout's own alpha silhouette into a CSS clip-path (see
  // silhouette.js) and applies it to .item--image__clip — so the item's
  // actual clickable/visible area follows the leaf/bug/whatever's real
  // outline instead of always being its rectangular box. Async (tracing
  // takes a moment); the item renders as a plain rectangle until this
  // resolves, same "upgrades in place" pattern as the AI cutout mask.
  // Cached per distinct image, so re-rendering the same photo (undo,
  // switching canvases back and forth, duplicating) never re-traces it.
  async _applyShapeClip(el, item) {
    const src = item.src;
    if (!src) return;
    let clipPath = this._shapeClipCache.get(src);
    if (clipPath === undefined) {
      clipPath = await alphaClipPath(src).catch(() => null);
      this._shapeClipCache.set(src, clipPath);
    }
    if (!clipPath) return;
    // The node may have been removed, re-rendered, or repurposed for a
    // different item by the time an async trace resolves — only apply to
    // the exact clip element this call started with, and only if it's
    // still live in the DOM for the SAME item/photo.
    const clipEl = el.querySelector(".item--image__clip");
    if (!clipEl || !this.world.contains(el) || this._get(item.id)?.src !== src) return;
    clipEl.style.clipPath = clipPath;
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
    if (item.type === "text") {
      // item.color is the text's own foreground — the background is its
      // own separate field, not the same "fill" every other shape has.
      const rgb = (item.bgColor && hexToRgb(item.bgColor)) || hexToRgb("#ffffff");
      el.style.backgroundColor = `rgba(${rgb}, ${op})`;
      return;
    }
    const rgb = (item.color && hexToRgb(item.color)) || FILL_RGB[item.type];
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
    if (item.thumbnailImage) {
      poster.style.backgroundImage = `url(${item.thumbnailImage})`;
    } else if (item.thumbnailText) {
      const label = document.createElement("span");
      label.className = "yt-card__poster-label";
      label.textContent = item.thumbnailText;
      poster.appendChild(label);
    } else if (item.thumbnailUrl) {
      poster.style.backgroundImage = `url(${item.thumbnailUrl})`;
    }
    const play = document.createElement("span");
    play.className = "yt-card__play";
    play.textContent = "▶";
    poster.appendChild(play);
    return poster;
  }

  // A custom photo/label overrides the auto-detected favicon on a dedicated
  // link item's card — same override a buried embed's preview also honors.
  _setLinkFavicon(el, item) {
    el.style.backgroundImage = "";
    el.textContent = "";
    el.classList.remove("link-card__favicon--text");
    if (item.thumbnailImage) {
      el.style.backgroundImage = `url(${item.thumbnailImage})`;
    } else if (item.thumbnailText) {
      el.classList.add("link-card__favicon--text");
      el.textContent = item.thumbnailText.slice(0, 2).toUpperCase();
      el.title = item.thumbnailText;
    } else if (item.faviconUrl) {
      el.style.backgroundImage = `url(${item.faviconUrl})`;
    } else {
      el.textContent = "🔗";
    }
  }

  _buildYtEditBtn() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "yt-card__edit";
    btn.title = "Edit this link or its thumbnail";
    btn.textContent = "✎";
    return btn;
  }

  // Hitting play grows the item to a big, easy-to-watch size by default (you
  // can still drag the corner handle to adjust it further — doing so keeps
  // your size instead of snapping back). Stopping restores the size it was
  // before you pressed play, unless you resized it yourself in the meantime.
  _setYtPlaying(card, item, playing) {
    const el = card.closest(".item");
    if (!playing) {
      card.innerHTML = "";
      card.append(this._buildYtPoster(item), ytTitleEl(item), this._buildYtEditBtn());
      if (this._activeEmbed?.item === item) this._activeEmbed = null;
      if (item._preBigSize) {
        Object.assign(item, item._preBigSize);
        delete item._preBigSize;
        this._layout(el, item);
        this.positionBar();
      }
      save();
      return;
    }
    if (!item._preBigSize) {
      item._preBigSize = { x: item.x, y: item.y, w: item.w, h: item.h };
      const big = this._bigSizeFor();
      item.x = Math.round(item.x + item.w / 2 - big.w / 2);
      item.y = Math.round(item.y + item.h / 2 - big.h / 2);
      item.w = big.w;
      item.h = big.h;
      this._layout(el, item);
      this.positionBar();
      save();
    }
    card.innerHTML = "";
    const stop = () => this._setYtPlaying(card, item, false);
    const { iframe, close } = this._buildEmbedIframe(item.videoId, stop);
    iframe.className = "yt-card__iframe";
    close.className = "yt-card__shrink";
    close.title = "Stop (Esc also works)";
    close.textContent = "✕";
    card.append(iframe, close);
    this._activeEmbed = { item, stop };
  }

  // A big-but-reasonable target size, in world units, so it reads as the
  // same comfortable screen size regardless of the current zoom level.
  _bigSizeFor(aspect = 16 / 9) {
    const screenW = Math.min(720, window.innerWidth * 0.7);
    return {
      w: Math.round(screenW / this.vp.scale),
      h: Math.round(screenW / aspect / this.vp.scale),
    };
  }

  // Shared by the dedicated 'youtube' item's poster AND any item carrying a
  // "buried" item.embed — both just need an iframe + a way to stop it.
  //
  // Fullscreen IS allowed here: the player's own native fullscreen icon
  // works, and Escape is the standard, browser-guaranteed way back out of
  // it — the same as it works on any video anywhere on the web. Our own
  // close button (below) covers the non-native case, and this class also
  // listens for Escape itself (see the keydown handler in the constructor)
  // so it works as an exit even without ever touching real fullscreen.
  _buildEmbedIframe(videoId, onClose) {
    const iframe = document.createElement("iframe");
    iframe.src = youtubeEmbedUrl(videoId, { autoplay: true });
    iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    iframe.allowFullscreen = true;
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
  // Any other link opens in the in-app browser (if wired) so the canvas
  // isn't left behind — some sites still won't allow being framed at all,
  // but that in-app view always offers "open in new tab" as a fallback.
  _activateEmbed(overlay, item) {
    if (!item.embed) return;
    if (!isYoutubeEmbed(item.embed)) {
      this._openLink(item.embed.url, item.embed.title);
      return;
    }
    if (!overlay || overlay.classList.contains("is-active")) return;
    const stop = () => {
      overlay.classList.remove("is-active");
      overlay.innerHTML = "";
      if (this._activeEmbed?.item === item) this._activeEmbed = null;
    };
    const { iframe, close } = this._buildEmbedIframe(item.embed.videoId, stop);
    iframe.className = "embed-overlay__iframe";
    close.className = "embed-overlay__close";
    close.title = "Stop (Esc also works)";
    overlay.append(iframe, close);
    overlay.classList.add("is-active");
    this._activeEmbed = { item, stop };
  }

  // Opens a link in the app's own browser panel if one is wired up (keeps
  // the canvas exactly as you left it underneath); falls back to a plain
  // new tab otherwise, so this class still works standalone.
  _openLink(url, title) {
    if (this.onOpenLink) this.onOpenLink(url, title);
    else window.open(url, "_blank", "noopener");
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
    const inkColorRow = this.bar.querySelector("#inkColor").parentElement;
    this.bar.querySelector("#inkColor").value = item?.color || this.color;
    inkColorRow.title = item?.type === "text" ? "Note text color" : "Choose color";
    // A note gets a second, independent swatch for its own background —
    // #inkColor above becomes specifically "text color" once one's selected.
    const bgColorRow = this.bar.querySelector("#textBgColor").parentElement;
    bgColorRow.style.display = item?.type === "text" ? "" : "none";
    if (item?.type === "text") this.bar.querySelector("#textBgColor").value = item.bgColor || "#ffffff";
    // When an item carries a buried link, the SAME opacity slider controls
    // that link's preview visibility instead of the item's own fill — one
    // discoverable control instead of a second one hidden in a popover.
    const opInput = this.bar.querySelector("#itemOpacity");
    const opRow = opInput.parentElement;
    if (item?.embed) {
      opRow.style.display = "";
      opInput.value = Math.round((item.embed.showThumbnail ? item.embed.thumbnailOpacity ?? 1 : 0) * 100);
      opRow.querySelector("span").textContent = "preview";
    } else if (item?.type === "text") {
      // A text item's "fill" is just a faint wash behind the words — not
      // something worth a control of its own; font size covers what people
      // actually mean to adjust here.
      opRow.style.display = "none";
    } else {
      opRow.style.display = "";
      const def = DEFAULT_OPACITY[item?.type] ?? 1;
      opInput.value = Math.round((item?.opacity ?? def) * 100);
      opRow.querySelector("span").textContent = "opacity";
    }
    const fontRow = this.bar.querySelector(".item-bar__op--font");
    fontRow.style.display = item?.type === "text" ? "" : "none";
    this.bar.querySelector("#itemFontSize").value = item?.fontSize || 16;

    // Same button opens the same popover either way, but its label should
    // say "edit" once there's something to edit (and remove) — "attach"
    // reads like a dead end once a link is already there.
    const embedBtn = this.bar.querySelector('[data-act="embed"]');
    embedBtn.classList.toggle("is-on", !!item?.embed);
    embedBtn.textContent = item?.embed ? "🔗 edit / remove link" : "🔗 attach link";

    // Only makes sense once there's both a buried link AND an actual photo
    // outline to clip its preview to.
    const clipBtn = this.bar.querySelector('[data-act="clipshape"]');
    const showClip = !!item?.embed && item?.type === "image";
    clipBtn.style.display = showClip ? "" : "none";
    if (showClip) clipBtn.classList.toggle("is-on", !!item.embed.clipToShape);
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
    // One undo snapshot per drag gesture on a slider (at pointerdown, before
    // any change), not one per 'input' tick — otherwise dragging a slider
    // from one end to the other would flood the stack with dozens of steps.
    const snapshotOnce = () => pushUndoSnapshot();
    this.bar.querySelector("#inkColor").addEventListener("pointerdown", snapshotOnce);
    this.bar.querySelector("#textBgColor").addEventListener("pointerdown", snapshotOnce);
    this.bar.querySelector("#itemOpacity").addEventListener("pointerdown", snapshotOnce);
    this.bar.querySelector("#itemFontSize").addEventListener("pointerdown", snapshotOnce);

    this.bar.querySelector("#inkColor").addEventListener("input", (e) =>
      this.setColor(e.target.value)
    );
    this.bar.querySelector("#textBgColor").addEventListener("input", (e) =>
      this.setBgColor(e.target.value)
    );
    this.bar.querySelector("#itemOpacity").addEventListener("input", (e) =>
      this.setOpacity(e.target.value / 100)
    );
    this.bar.querySelector("#itemFontSize").addEventListener("input", (e) =>
      this.setFontSize(Number(e.target.value))
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
    this.bar.querySelector('[data-act="embed"]').addEventListener("click", async (e) => {
      const anchorEl = e.currentTarget; // capture before the await — currentTarget goes null once dispatch ends
      const item = this._get(this.selected);
      if (!item) return;
      const { openEmbedPrompt } = await import("../links/links.js");
      openEmbedPrompt(
        anchorEl,
        item.embed || null,
        (embed) => {
          pushUndoSnapshot();
          item.embed = embed;
          save();
          this._reRender(item);
        },
        () => {
          pushUndoSnapshot();
          delete item.embed;
          save();
          this._reRender(item);
        }
      );
    });
    this.bar.querySelector('[data-act="clipshape"]').addEventListener("click", (e) => {
      const item = this._get(this.selected);
      if (!item?.embed) return;
      pushUndoSnapshot();
      item.embed.clipToShape = !item.embed.clipToShape;
      e.currentTarget.classList.toggle("is-on", item.embed.clipToShape);
      this._applyEmbedThumb(this.nodes.get(item.id), item);
      save();
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
    if (!item) return;
    if (item.type === "text") {
      item.color = c;
      this.nodes.get(item.id).querySelector(".text-body").style.color = c;
      save();
    } else if (FILL_RGB[item.type]) {
      // rect/circle/file/link — recolor the shape's own fill/wash, same as
      // text above. Every shape of a given type used to share one hardcoded
      // color (FILL_RGB) with no way to override it per item — this swatch
      // looked live but silently did nothing outside of text.
      item.color = c;
      this._applyFill(this.nodes.get(item.id), item);
      save();
    }
  }

  // A note's own background — separate from setColor's text-foreground
  // color, so both are independently editable instead of one swatch
  // fighting over what "color" means for a text item.
  setBgColor(c) {
    const item = this._get(this.selected);
    if (!item || item.type !== "text") return;
    item.bgColor = c;
    this._applyFill(this.nodes.get(item.id), item);
    save();
  }

  setOpacity(op) {
    const item = this._get(this.selected);
    if (!item) return;
    const el = this.nodes.get(item.id);
    if (item.embed) {
      // Doubles as the buried link's preview control (see _showBar) — one
      // slider that's always visible, instead of a second one hidden away
      // in the attach-link popover.
      item.embed.showThumbnail = op > 0.02;
      item.embed.thumbnailOpacity = Math.max(op, 0.02);
      this._applyEmbedThumb(el, item);
    } else {
      item.opacity = op;
      this._applyFill(el, item);
    }
    save();
  }

  setFontSize(size) {
    const item = this._get(this.selected);
    if (!item || item.type !== "text") return;
    item.fontSize = size;
    const body = this.nodes.get(item.id)?.querySelector(".text-body");
    if (body) body.style.fontSize = size + "px";
    save();
  }

  // Adds/updates/removes an item's embed-preview wash in place, without a
  // full _reRender (which would rebuild the whole node — noticeably janky
  // on every tick while the opacity slider is being dragged).
  _applyEmbedThumb(el, item) {
    if (!el) return;
    let layer = el.querySelector(".embed-thumb-layer");
    const v = item.embed && embedThumbVisual(item.embed);
    if (!item.embed?.showThumbnail || !v?.has) {
      layer?.remove();
      return;
    }
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "embed-thumb-layer";
      el.insertBefore(layer, el.querySelector(".embed-badge") || el.firstChild);
    }
    layer.classList.toggle("embed-thumb-layer--icon", v.iconMode);
    layer.classList.toggle("embed-thumb-layer--text", !!v.text);
    if (v.image) { layer.style.backgroundImage = `url(${v.image})`; layer.textContent = ""; }
    else if (v.text) { layer.style.backgroundImage = ""; layer.textContent = v.text; }
    else { layer.style.backgroundImage = `url(${v.url})`; layer.textContent = ""; }
    layer.style.opacity = item.embed.thumbnailOpacity ?? 1;
    this._applyClipMask(layer, item, v);
  }

  // Optionally limits a buried embed's preview wash to the leaf/cutout's own
  // outline (using its own image as an alpha mask) instead of its whole
  // rectangular box — only meaningful for an actual photo (a text label has
  // no shape to clip to), and only on an image item (the only type that
  // HAS an irregular outline to clip to in the first place).
  _applyClipMask(el, item, v) {
    const useMask = item.type === "image" && item.src && !!item.embed?.clipToShape && !v.text;
    const mask = useMask ? `url(${item.src})` : "";
    el.style.maskImage = mask;
    el.style.webkitMaskImage = mask;
    if (useMask) {
      el.style.maskSize = el.style.webkitMaskSize = "contain";
      el.style.maskRepeat = el.style.webkitMaskRepeat = "no-repeat";
      el.style.maskPosition = el.style.webkitMaskPosition = "center";
    }
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
    pushUndoSnapshot();
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
  _wire(el, item, { svg, handle, del, badge, fileOpen, linkOpen, linkEdit, ytPoster, ytCard, embedOverlay, imageClip }) {
    // For an image item, the body select/move/tap gesture is hosted on the
    // (now shape-clipped) clip element instead of the item itself — el is
    // pointer-events:none for images (see styles/main.css) precisely so a
    // click on a transparent corner of the cutout falls through to
    // whatever's behind, and that only works for the element clip-path is
    // actually applied to. Every other item type is unaffected: el IS the
    // body target, exactly as before.
    const bodyTarget = imageClip || el;
    badge.style.pointerEvents = "none";

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

    // Link cards (any saved URL) open in the in-app browser if wired.
    if (linkOpen) {
      linkOpen.addEventListener("pointerdown", (e) => e.stopPropagation());
      linkOpen.addEventListener("click", (e) => {
        e.stopPropagation();
        this._openLink(item.url, item.name);
      });
    }

    // A buried item.embed's own always-reachable activation target — needed
    // because a plain body tap (see the tap-priority chain below) can't
    // always be trusted to get here: if this item also has attached notes,
    // the body tap is busy toggling those instead. This badge works either way.
    if (embedOverlay) {
      const embedBadge = el.querySelector(".embed-badge");
      embedBadge?.addEventListener("pointerdown", (e) => e.stopPropagation());
      embedBadge?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!embedOverlay.classList.contains("is-active")) this._activateEmbed(embedOverlay, item);
      });
    }

    // A dedicated link item's own edit button — change the URL and/or swap
    // in a custom thumbnail (photo or short label) instead of the favicon.
    if (linkEdit) {
      linkEdit.addEventListener("pointerdown", (e) => e.stopPropagation());
      linkEdit.addEventListener("click", async (e) => {
        e.stopPropagation();
        const { openLinkPrompt } = await import("../links/links.js");
        openLinkPrompt(
          linkEdit,
          (link) => {
            pushUndoSnapshot();
            item.url = link.url;
            item.name = link.title || link.domain;
            item.domain = link.domain;
            item.faviconUrl = link.faviconUrl;
            item.thumbnailImage = link.thumbnailImage || null;
            item.thumbnailText = link.thumbnailText || null;
            save();
            this._reRender(item);
          },
          { kind: "link", url: item.url, title: item.name, domain: item.domain, faviconUrl: item.faviconUrl, thumbnailImage: item.thumbnailImage, thumbnailText: item.thumbnailText }
        );
      });
    }

    // A dedicated YouTube item's edit button — delegated on the card, not
    // bound to one poster instance, since play/stop rebuilds the card's
    // contents (see _setYtPlaying) and a direct reference would go stale.
    if (ytCard) {
      ytCard.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".yt-card__edit")) e.stopPropagation();
      });
      ytCard.addEventListener("click", async (e) => {
        const btn = e.target.closest(".yt-card__edit");
        if (!btn) return;
        e.stopPropagation();
        const { openLinkPrompt } = await import("../links/links.js");
        openLinkPrompt(
          btn,
          (link) => {
            pushUndoSnapshot();
            item.videoId = link.videoId;
            item.title = link.title || item.title;
            item.thumbnailUrl = link.thumbnailUrl || item.thumbnailUrl;
            item.thumbnailImage = link.thumbnailImage || null;
            item.thumbnailText = link.thumbnailText || null;
            save();
            this._reRender(item);
          },
          { kind: "youtube", videoId: item.videoId, title: item.title, thumbnailUrl: item.thumbnailUrl, thumbnailImage: item.thumbnailImage, thumbnailText: item.thumbnailText }
        );
      });
    }

    // Body: draw, move, or tap-to-toggle depending on mode/state. A tap (no
    // movement) on a YouTube poster, or on any item carrying a buried
    // item.embed, plays the video — but a drag still moves the item first,
    // since a tap is only decided by whether the pointer actually moved.
    bodyTarget.addEventListener("pointerdown", (e) => {
      if (e.target === handle || e.target === del || e.target === fileOpen || e.target === linkOpen || e.target === linkEdit || e.target.closest?.(".yt-card__edit, .embed-badge")) return;
      if (e.target.isContentEditable) return; // editing text
      if (embedOverlay?.classList.contains("is-active") || e.target.closest?.(".yt-card__iframe, .embed-overlay__iframe, .yt-card__shrink, .embed-overlay__close")) return; // let the live embed / its controls handle their own input
      e.stopPropagation();
      const wasSelected = this.selected === item.id;
      const tappedPoster = !!(ytPoster && (e.target === ytPoster || ytPoster.contains(e.target)));
      this.select(item.id);

      if (this.drawMode) return this._startStroke(e, bodyTarget, item, svg);

      bodyTarget.setPointerCapture(e.pointerId);
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
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > TAP_SLOP) {
          moved = true;
          pushUndoSnapshot(); // once per drag gesture, right as it turns into a real move
        }
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
        bodyTarget.releasePointerCapture(ev.pointerId);
        bodyTarget.removeEventListener("pointermove", onMove);
        bodyTarget.removeEventListener("pointerup", onUp);
        this.groupBg?.endGroupDrag();
        el.classList.remove("is-over-pocket");
        if (moved && overPocket && pocketEligible && this.onSendToPocket) {
          this.onSendToPocket(item).then((handled) => {
            if (handled) this.remove(item.id);
            else save(); // pocket couldn't take it — leave it where it was dropped
          });
          return;
        }
        // A tap SELECTS first; only a second tap on an already-selected item
        // activates it (plays / opens). Otherwise the first touch on a link
        // item would always fire off to a webpage before you ever got the
        // chance to just select it — no way to tell "go there" from "edit
        // this" apart. Same reasoning toggleExpand already used for notes.
        //
        // tappedPoster is checked BEFORE the attached-notes check on purpose:
        // a tap on the poster is a specific, unambiguous target, so it should
        // still play even once the item also has a note attached — otherwise
        // attaching a note to a video silently makes the video untappable
        // (a real bug this order fixes; a buried item.embed with no poster
        // of its own gets the same fix via its badge, wired below instead).
        if (moved) {
          save();
        } else if (wasSelected && tappedPoster && item.type === "youtube") {
          this._setYtPlaying(el.querySelector(".yt-card"), item, true);
        } else if (wasSelected && this._children(item.id).length) {
          this.toggleExpand(item);
        } else if (wasSelected && item.embed && embedOverlay && !embedOverlay.classList.contains("is-active")) {
          this._activateEmbed(embedOverlay, item);
        }
      };
      bodyTarget.addEventListener("pointermove", onMove);
      bodyTarget.addEventListener("pointerup", onUp);
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
      pushUndoSnapshot();
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
        // A manual resize while auto-expanded (see _setYtPlaying) locks in
        // that size — stopping playback then keeps it instead of snapping
        // back to whatever size it was before you pressed play.
        delete item._preBigSize;
        save();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });

    // Delete this item and everything attached beneath it — confirm first,
    // since there's no undo once it's gone. Exception: an empty text box
    // with nothing attached has nothing to lose, so it just goes.
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const noteCount = this._descendants(item.id).length;
      const isEmptyText = item.type === "text" && !item.text?.trim();
      if (isEmptyText && !noteCount) {
        this.remove(item.id);
        return;
      }
      const msg = noteCount
        ? `Delete this and its ${noteCount} attached note${noteCount === 1 ? "" : "s"}? This can't be undone.`
        : "Delete this? This can't be undone.";
      if (confirm(msg)) this.remove(item.id);
    });
  }

  _editText(item, el) {
    pushUndoSnapshot(); // captures the pre-edit text — one undo step per edit session
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
    pushUndoSnapshot();
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
    pushUndoSnapshot();
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

// What a buried embed's preview wash should actually show: a custom photo
// or label always wins over the auto-detected video thumbnail/favicon. Only
// a real thumbnail (video frame, or a custom photo) should stretch to cover
// the item — a bare favicon or a text label stay icon-sized instead.
function embedThumbVisual(embed) {
  const isYt = isYoutubeEmbed(embed);
  const image = embed.thumbnailImage || null;
  const text = !image ? embed.thumbnailText || null : null;
  const url = !image && !text ? (isYt ? embed.thumbnailUrl : embed.faviconUrl) : null;
  return { image, text, url, iconMode: !isYt && !image, has: !!(image || text || url) };
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
