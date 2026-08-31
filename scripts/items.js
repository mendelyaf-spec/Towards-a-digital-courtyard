// items.js — everything that lives on the canvas.
//
// Every item is the same kind of citizen: a shape, a cut-out photo, or a
// text note. Any item can be drawn on, can have text, and can hold attached
// notes that reveal/hide when you tap it — and those notes are themselves
// full items, so the nesting goes as deep as you like.

import { items, save, addItem, removeItem, newId, openCanvas } from "./store.js";
import { youtubeEmbedUrl } from "../youtube/youtube.js";
import { YouTubePlayer, fireCrossings, formatTime, parseTime } from "../youtube/timednotes.js";
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

/** The first few words of a note — its header until you write your own. */
function deriveTitle(text) {
  const firstLine = String(text || "").split("\n").find((l) => l.trim()) || "";
  const words = firstLine.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  let t = words.join(" ");
  if (t.length > 42) t = t.slice(0, 42).trimEnd() + "…";
  return t;
}

/**
 * Keep the caret visible inside a scrolling editable box, so typing past
 * the bottom follows the words instead of hiding them. A collapsed range
 * can report an empty rect in some positions; when it does we simply don't
 * scroll, rather than guessing and jumping somewhere wrong.
 */
function scrollCaretIntoView(container) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(false);
  const rect = r.getBoundingClientRect();
  if (!rect || (!rect.height && !rect.top)) return;
  const box = container.getBoundingClientRect();
  if (rect.bottom > box.bottom) container.scrollTop += rect.bottom - box.bottom + 6;
  else if (rect.top < box.top) container.scrollTop -= box.top - rect.top + 6;
}

// The shape a buried link's preview takes. Stored as embed.clipShape;
// older items only have the clipToShape boolean, so read through this —
// true meant "the photo's own outline", false meant "the whole box". The
// picker itself lives in links.js's add/edit-link popover now — choosing
// a shape only ever matters in the context of a link's preview, so it
// moved in with everything else about that preview instead of being a
// second, separate item-bar trip.
function embedClipShape(embed) {
  if (!embed) return "box";
  if (embed.clipShape) return embed.clipShape;
  return embed.clipToShape ? "own" : "box";
}

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
    // Layers: every item on the mosaic is "layer one"; an item with
    // children has a layer beneath it you can descend into (double-click
    // an item wearing the halo). focusStack is the breadcrumb trail —
    // [] means the top-level mosaic; its last id is the current layer.
    // Descending/ascending is navigation, not an edit — it never touches
    // undo history, same as selecting or panning.
    this.focusStack = [];
    this.viewStack = [];   // a Viewport snapshot per focusStack entry, so ascending returns you to exactly where you were
    this.ghostOpacity = 0.35; // the layer above, showing through like tracing paper — see setGhostOpacity
    // Connection lines live in their own layer, kept as world's FIRST child
    // so they always paint behind items — select() appends the selected
    // item to world, which would otherwise keep shuffling them in front.
    this.connLayer = document.createElement("div");
    this.connLayer.className = "conn-layer";
    worldEl.prepend(this.connLayer);
    this.connectFrom = null; // armed by "connect": the next item tapped gets joined to this one
    this._connLive = null;   // the rubber-band line following the pointer while armed
    this.onFocusChange = null; // hook: (breadcrumb: [{id,label}]) -> void — main.js renders it
    // The mosaic is view-only by default — dragging, resizing, deleting,
    // drawing, typing, and adding new items all require Edit first. Viewing
    // stays fully alive either way: pan/zoom, tapping a video to play it,
    // opening a link, reading a note.
    this.locked = true;
    this.onLockChange = null; // hook: (locked) -> void — main.js hides the add-toolbar and tints the canvas
    this.onSelect = null;     // hook: notified with the newly selected id (or null)
    this.groupBg = null;      // background layer, so grouped backgrounds travel with groups
    this.onVisibility = null; // hook: fired when expand/collapse changes what's visible
    this.onRemove = null;     // hook: fired with the ids removed by a delete
    this.resolveFileUrl = null; // hook: async(pocketId) -> blob URL, for 'file' items (docs/videos from the pocket)
    this.onOpenDoc = null;    // hook: async(pocketId) -> true if it opened in the document viewer; false to fall back to a new tab
    this.getPocketDropRect = null; // hook: () -> DOMRect | null — where "drag to pocket" drops
    this.onSendToPocket = null;    // hook: async(item) -> boolean — true if the pocket accepted it
    this.onOpenLink = null;        // hook: (url, title) -> void — opens the in-app browser, if wired
    this.onPickNoteShape = null;   // hook: (item) -> void — pick a photo whose cutout becomes this note's shape
    this.onReadNote = null;        // hook: (item) -> void — open a note for reading
    this._activeEmbed = null;      // { item, stop() } for whichever embed is currently playing, if any

    this.bar = document.getElementById("itemBar");
    this._wireBar();

    viewport.vp.addEventListener("pointerdown", (e) => {
      if (e.target === viewport.vp) {
        if (this.connectFrom) this.endConnect(); // tapping nowhere cancels "connect"
        this.select(null);
      }
    });
    // The rubber-band line follows the pointer while a connection is armed.
    viewport.vp.addEventListener("pointermove", (e) => {
      if (!this.connectFrom || !this._connLive) return;
      const from = this._get(this.connectFrom);
      if (!from) return this.endConnect();
      const pt = this.vp.screenToWorld(e.clientX, e.clientY);
      this._layoutConn(this._connLive, from.x + from.w / 2, from.y + from.h / 2, pt.x, pt.y);
    });

    // A reliable "exit" that works whether or not the video ever entered
    // real native fullscreen — Escape always stops whatever is playing.
    // Ctrl/Cmd+Z undoes the last edit — but not while actually typing in a
    // text note, where it should mean the browser's own native text undo.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.connectFrom) this.endConnect();
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

  /** The layer you're currently inside, or null for the top-level mosaic. */
  get focusId() {
    return this.focusStack.length ? this.focusStack[this.focusStack.length - 1] : null;
  }

  // Swap the whole canvas: clear the current nodes and render another canvas's
  // items. The store rebinds `items` to the opened canvas.
  loadCanvas(id) {
    this._activeEmbed?.stop(); // a playing video must not keep ticking into another canvas
    this.closeTimedNotes();
    this.focusStack = [];
    this.viewStack = [];
    this._notifyFocus();
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

  // ---------- view / edit mode ----------
  /** Lock (view) or unlock (edit) the whole mosaic. Locking also clears any
   *  selection and editing state, so nothing stays half-open. */
  setLocked(locked) {
    this.locked = locked;
    if (locked) {
      this.select(null);
      this.drawMode = false;
      this.closeTimedNotes();
      this.endConnect();
    }
    this.onLockChange?.(locked);
  }

  // ---------- undo ----------
  undo() {
    if (this.locked) return; // view mode: the board doesn't change, so neither does history
    if (!canUndo()) return;
    this._activeEmbed?.stop();
    this.closeTimedNotes();
    const ok = popUndoSnapshot();
    if (!ok) return;
    for (const el of this.nodes.values()) el.remove();
    this.nodes.clear();
    this.selected = null;
    this._hideBar();
    // An undo can remove the very item whose layer you're inside (or
    // anything above it) — surface back to wherever in the trail still
    // exists rather than leave focusId pointing at nothing.
    while (this.focusStack.length && !this._get(this.focusId)) {
      this.focusStack.pop();
      this.viewStack.pop();
    }
    for (const it of items) this._render(it);
    this._applyVisibility();
    this._notifyFocus();
  }

  // ---------- tree helpers (recursive grouping) ----------
  _children(id) {
    return items.filter((it) => it.parentId === id);
  }

  // ---------- connections: items joined by a line share ONE layer ----------
  /** Every id reachable from `id` through connection lines, including it. */
  _component(id) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const cur = this._get(stack.pop());
      for (const nid of cur?.links || []) {
        if (!seen.has(nid) && this._get(nid)) { seen.add(nid); stack.push(nid); }
      }
    }
    return [...seen];
  }

  /** The single item that owns a connected group's shared layer. Lowest id
   *  wins — an arbitrary but STABLE choice, so the same group always
   *  resolves to the same owner no matter which member you ask from. */
  _layerOwner(id) {
    const comp = this._component(id);
    let owner = comp[0];
    for (const c of comp) if (c < owner) owner = c;
    return owner;
  }

  /** What's on this item's layer — its own, or the one it shares. */
  _layerChildren(id) {
    return this._children(this._layerOwner(id));
  }

  /** Join two items with a line. Their layers MERGE into one: everything
   *  that lived under either now lives under the group's single owner, so
   *  descending from either end arrives at the same place. */
  connect(aId, bId) {
    if (!aId || !bId || aId === bId) return false;
    const a = this._get(aId);
    const b = this._get(bId);
    if (!a || !b) return false;
    if ((a.links || []).includes(bId)) return false; // already joined
    pushUndoSnapshot();
    a.links = [...(a.links || []), bId];
    b.links = [...(b.links || []), aId];
    // Merge: re-parent every member's children onto the new single owner.
    const comp = this._component(aId);
    const owner = this._layerOwner(aId);
    for (const memberId of comp) {
      if (memberId === owner) continue;
      for (const child of this._children(memberId)) child.parentId = owner;
    }
    save();
    for (const memberId of comp) {
      const it = this._get(memberId);
      if (it) this._updateBadge(it);
    }
    this._applyVisibility();
    return true;
  }

  /** Cut one line. The shared layer STAYS with the group's owner — the
   *  item that leaves keeps no copy of it, which is why this asks first. */
  disconnect(aId, bId) {
    const a = this._get(aId);
    const b = this._get(bId);
    if (!a || !b) return false;
    pushUndoSnapshot();
    a.links = (a.links || []).filter((x) => x !== bId);
    b.links = (b.links || []).filter((x) => x !== aId);
    if (!a.links.length) delete a.links;
    if (!b.links.length) delete b.links;
    save();
    for (const id of [...this._component(aId), ...this._component(bId)]) {
      const it = this._get(id);
      if (it) this._updateBadge(it);
    }
    this._applyVisibility();
    return true;
  }

  /** Every connection worth drawing right now: both ends present, and both
   *  actually on the layer you're looking at. Each pair once (a < b). */
  _visibleConnections() {
    const out = [];
    for (const it of items) {
      if (!this._visible(it)) continue;
      for (const otherId of it.links || []) {
        if (it.id >= otherId) continue; // one line per pair
        const other = this._get(otherId);
        if (other && this._visible(other)) out.push([it, other]);
      }
    }
    return out;
  }

  /** Repaint the lines. Rebuilt wholesale rather than diffed — there are a
   *  handful of these, and rebuilding keeps them honest after any move,
   *  resize, delete, or layer change without tracking which changed. */
  _renderConnections() {
    if (!this.connLayer) return;
    this.connLayer.innerHTML = "";
    for (const [a, b] of this._visibleConnections()) {
      const el = document.createElement("div");
      el.className = "conn";
      this._layoutConn(el, a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2);
      el.title = "Connected — they share one layer. Click to cut this line.";
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.locked) return; // view mode: lines are shown, not edited
        if (confirm("Cut this connection? Their shared layer stays with the first of them.")) {
          this.disconnect(a.id, b.id);
        }
      });
      this.connLayer.appendChild(el);
    }
    if (this._connLive) this.connLayer.appendChild(this._connLive);
  }

  _layoutConn(el, ax, ay, bx, by) {
    const len = Math.hypot(bx - ax, by - ay);
    el.style.left = ax + "px";
    el.style.top = ay + "px";
    el.style.width = len + "px";
    el.style.transform = `rotate(${Math.atan2(by - ay, bx - ax)}rad)`;
  }

  /** Arm "draw a line from here" — the next item you tap gets joined. */
  startConnect(fromId) {
    if (this.locked || !this._get(fromId)) return;
    this.connectFrom = fromId;
    this._connLive = document.createElement("div");
    this._connLive.className = "conn conn--live";
    this._renderConnections();
    this._reflectConnectState();
  }

  endConnect() {
    this.connectFrom = null;
    this._connLive = null;
    this._renderConnections();
    this._reflectConnectState();
  }

  _reflectConnectState() {
    const btn = this.bar?.querySelector('[data-act="connect"]');
    if (btn) btn.classList.toggle("is-on", !!this.connectFrom);
    this.vp.vp.classList.toggle("is-connecting", !!this.connectFrom);
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
    // A layer shows exactly its own contents: the top-level mosaic shows
    // root items, a descended layer shows only the focus item's direct
    // children — nothing above, nothing further below (that's the NEXT
    // layer, reached by descending again). This replaced an older
    // ancestor-expanded-chain walk that revealed nested notes in place
    // alongside everything else; a layer is a place you travel to now,
    // not a fold-out.
    return (item.parentId || null) === this.focusId;
  }

  // Public: does this item have attached notes?
  hasChildren(id) {
    return this._layerChildren(id).length > 0;
  }
  // Public: is this group "open" — expanded and itself visible? A grouped
  // background binds to / shows with an open group.
  isOpen(id) {
    return id === this.focusId;
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
  add(type, { src, w, h, text, parentId, near, nearCenter, pocketId, name, mime, location, videoId, title, thumbnailUrl, url, domain, faviconUrl, thumbnailImage, thumbnailText, shapeSrc } = {}) {
    pushUndoSnapshot();
    // Type-specific defaults must be resolved BEFORE the generic 160x160
    // fallback below, or `w || 160` there clobbers them and every text/file/
    // youtube/link item silently reverts to a square 160x160 (a real bug we hit).
    if (type === "text") {
      // Tall enough for the header plus a few lines of body; a shorter
      // default left the body a ~12px slit you couldn't read or type in.
      w = w || 200;
      h = h || 110;
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
    // Adding something while you're inside a layer puts it on THAT layer,
    // not back at the top level — you're standing there, so that's where
    // it lands. An explicit parentId (a duplicate, anything
    // that names its own parent) always wins over this default.
    if (parentId === undefined) parentId = this.focusId || undefined;
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
      ...(type === "text" ? { text: text ?? "", color: "#1a1a1a", bgColor: "#ffffff", fontSize: 16, ...(shapeSrc ? { shapeSrc } : {}) } : {}),
      ...(type === "file" ? { pocketId, name: name || "file", mime: mime || "" } : {}),
      ...(type === "youtube" ? { videoId, title: title || "", thumbnailUrl: thumbnailUrl || "" } : {}),
      ...(type === "link" ? { url, name: name || domain || "link", domain: domain || "", faviconUrl: faviconUrl || "" } : {}),
      ...(type === "youtube" || type === "link" ? { thumbnailImage: thumbnailImage || null, thumbnailText: thumbnailText || null } : {}),
      ...(parentId ? { parentId } : {}),
      ...(location ? { location } : {}),
    });
    const el = this._render(item);
    this._applyVisibility();
    // A new item's PARENT gains its halo the moment it gets its first
    // child — no matter how that child was created (typed, uploaded, a
    // link, drawn) or whether the parent is even on screen right now
    // (_updateBadge no-ops harmlessly if it isn't rendered).
    const parent = item.parentId && this._get(item.parentId);
    if (parent) this._updateBadge(parent);
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
      // __halo wraps __clip for one reason: CSS filter applies to an
      // element's WHOLE subtree, so a shape-hugging drop-shadow set on the
      // item itself would also outline the delete button and resize handle
      // (its own children). Putting the filter on a layer that contains
      // ONLY the picture keeps those controls clean — and it has to be a
      // separate element from __clip, since a filter is clipped away
      // entirely when clip-path sits on the same element.
      const halo = document.createElement("div");
      halo.className = "item--image__halo";
      const clip = document.createElement("div");
      clip.className = "item--image__clip";
      const img = document.createElement("img");
      img.src = item.src;
      img.alt = "";
      clip.appendChild(img);
      halo.appendChild(clip);
      el.appendChild(halo);
      this._styleImageContent(el, item);
      this._applyShapeClip(el, item);
      imageClip = clip;
    }
    let fileOpen = null;
    let textCard = null;
    if (item.type === "text") {
      // A simple note: one editable body, filling the box. It scrolls
      // rather than spilling text out past the edges — .text-card does the
      // clipping, kept off the item itself since that would also clip the
      // delete button, resize handle and note badge, which sit outside the
      // box by design (same reasoning as .item--image__clip).
      const halo = document.createElement("div");
      halo.className = "text-halo"; // see .item--image__halo — filter layer, controls stay outside it
      const card = document.createElement("div");
      card.className = "text-card";
      textCard = card;

      // A note can wear a photo's shape: the cutout becomes the note's own
      // outline (clip-path from its alpha, same tracer the canvas photos
      // use) with the words sitting inside it. The image AND the clip both
      // live on .text-card, not on the item itself — clip-path excludes
      // whatever it clips away from hit-testing too, and el still needs to
      // host the delete button, resize handle and note badge outside that
      // clipped area (their negative-offset positions put them outside the
      // shape, so a clip-path directly on el would silently swallow them —
      // a real bug this fixes, not a hypothetical one).
      if (item.shapeSrc) {
        el.classList.add("has-shape");
        const shapeImg = document.createElement("img");
        shapeImg.className = "text-shape";
        shapeImg.src = item.shapeSrc;
        shapeImg.alt = "";
        shapeImg.draggable = false;
        card.appendChild(shapeImg);
        this._applyNoteShapeClip(card, item);
      }

      const t = document.createElement("div");
      t.className = "text-body";
      t.textContent = item.text || "";
      card.append(t);
      halo.appendChild(card);
      el.appendChild(halo);
      this._applyTextStyle(el, item);
      // Every note gets a way to open and READ it — the words on the canvas
      // may be truncated, or squeezed inside a shape, or both. A note that
      // came from an uploaded file opens the whole document (with its margin
      // notes); any other note opens its own text.
      fileOpen = document.createElement("button");
      fileOpen.type = "button";
      fileOpen.className = "text-doc-open";
      fileOpen.textContent = item.pocketId ? "read full" : "read";
      fileOpen.title = item.pocketId
        ? "Open the whole document, with its margin notes"
        : "Open and read this note";
      el.appendChild(fileOpen);
    }
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
      ytCard.append(ytPoster, ytTitleEl(item), this._buildYtEditBtn(), this._buildYtNoteCount(item));
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
    this._wire(el, item, { svg, handle, del, badge, fileOpen, linkOpen, linkEdit, ytPoster, ytCard, embedOverlay, imageClip, textCard });
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

  // Traces a note's shape-photo silhouette into a clip-path on the note
  // itself, so the note really IS that shape — its edges, its hit area —
  // rather than a rectangle showing a picture. Shares the same per-src
  // cache as canvas photos, so the same cutout is only ever traced once.
  async _applyNoteShapeClip(clipEl, item) {
    const src = item.shapeSrc;
    if (!src) return;
    let clipPath = this._shapeClipCache.get(src);
    if (clipPath === undefined) {
      clipPath = await alphaClipPath(src).catch(() => null);
      this._shapeClipCache.set(src, clipPath);
    }
    // The node can be re-rendered or reused for another item while an async
    // trace is in flight — only apply if this element is still this item's.
    if (!clipPath || !this.world.contains(clipEl) || this._get(item.id)?.shapeSrc !== src) return;
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
      // A note wearing a photo's shape has no card of its own — the photo
      // IS the card, and opacity fades the photo rather than a fill. The
      // inline background is cleared so the stylesheet's transparent rule
      // for .item--text.has-shape can stand.
      if (item.shapeSrc) {
        el.style.backgroundColor = "";
        const shapeImg = el.querySelector(".text-shape");
        if (shapeImg) shapeImg.style.opacity = op;
        return;
      }
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

  /** The quiet "this video has N timed notes" badge on the poster. */
  _buildYtNoteCount(item) {
    const el = document.createElement("div");
    el.className = "yt-note-count";
    const n = (item.timeNotes || []).length;
    el.textContent = n ? `🕒 ${n}` : "";
    el.hidden = !n;
    el.title = "Notes pinned to moments in this video";
    return el;
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
      card.append(this._buildYtPoster(item), ytTitleEl(item), this._buildYtEditBtn(), this._buildYtNoteCount(item));
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
    const { iframe, close } = this._buildEmbedIframe(item.videoId, stop, { jsApi: true });
    iframe.className = "yt-card__iframe";
    close.className = "yt-card__shrink";
    close.title = "Stop (Esc also works)";
    close.textContent = "✕";
    card.append(iframe, close);
    this._attachTimedNotes(card, item);
    this._activeEmbed = { item, stop: () => { this._detachTimedNotes(); stop(); } };
  }

  // ---------- notes pinned to moments in a video ----------

  /** Live playback: surface notes as they come due, and offer to add one here. */
  _attachTimedNotes(card, item) {
    this._detachTimedNotes();
    const iframe = card.querySelector(".yt-card__iframe");
    if (!iframe) return;

    const toast = document.createElement("div");
    toast.className = "yt-note-toast";
    card.appendChild(toast);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "yt-note-add";
    addBtn.textContent = "＋ note here";
    addBtn.title = "Write a note pinned to this moment";
    addBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = this._ytPlayer?.currentTime();
      if (t == null) { alert("The player isn't reporting a position yet — give it a second."); return; }
      const text = prompt(`Note at ${formatTime(t)}`);
      if (text && text.trim()) this.addTimedNote(item, t, text.trim());
    });
    card.appendChild(addBtn);

    let prev = null;
    let toastTimer;
    this._ytPlayer = new YouTubePlayer(iframe, {
      onTick: (t) => {
        const due = fireCrossings(prev, t, item.timeNotes || []);
        prev = t;
        if (!due.length) return;
        // Several at once (a forward jump) read as one stacked note rather
        // than flickering through them in a few milliseconds.
        toast.textContent = due.map((n) => n.text).join("  •  ");
        toast.classList.add("is-on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove("is-on"), 5200);
      },
      onError: () => {
        addBtn.disabled = true;
        addBtn.textContent = "notes need youtube";
        addBtn.title = "Timed notes need YouTube's player, which couldn't be reached";
      },
    });
    this._ytPlayerItemId = item.id;
  }

  _detachTimedNotes() {
    this._ytPlayer?.destroy();
    this._ytPlayer = null;
    this._ytPlayerItemId = null;
  }

  /** Add a note pinned to `seconds` of this video, kept in time order. */
  addTimedNote(item, seconds, text) {
    pushUndoSnapshot();
    item.timeNotes = item.timeNotes || [];
    item.timeNotes.push({ id: newId(), t: Math.max(0, Math.round(seconds)), text });
    item.timeNotes.sort((a, b) => a.t - b.t);
    save();
    this._updateYtNoteCount(item);
  }

  removeTimedNote(item, noteId) {
    pushUndoSnapshot();
    item.timeNotes = (item.timeNotes || []).filter((n) => n.id !== noteId);
    save();
    this._updateYtNoteCount(item);
  }

  /** Jump the playing video to a note's moment (starting playback if needed). */
  seekToTimedNote(item, seconds) {
    if (this._ytPlayerItemId === item.id && this._ytPlayer) {
      this._ytPlayer.seekTo(seconds);
      return true;
    }
    // Not playing yet — start it, then seek once the player reports ready.
    const card = this.nodes.get(item.id)?.querySelector(".yt-card");
    if (!card) return false;
    this._setYtPlaying(card, item, true);
    const started = Date.now();
    const trySeek = () => {
      if (this._ytPlayerItemId !== item.id) return;
      if (this._ytPlayer?.currentTime() != null) this._ytPlayer.seekTo(seconds);
      else if (Date.now() - started < 8000) setTimeout(trySeek, 200);
    };
    setTimeout(trySeek, 400);
    return true;
  }

  /**
   * Every note for this video in one place, in time order. Each is a way
   * back to its own moment: click the timestamp and the video jumps there.
   * Notes can also be added here by hand, for when you know the moment but
   * aren't sitting through it.
   */
  openTimedNotes(item, anchorEl) {
    this.closeTimedNotes();
    const pop = document.createElement("div");
    pop.className = "yt-notes-pop";

    const render = () => {
      const notes = item.timeNotes || [];
      pop.innerHTML = `
        <div class="yt-notes-pop__head">
          <span>notes in this video</span>
          <button type="button" class="yt-notes-pop__close" aria-label="Close">×</button>
        </div>
        <div class="yt-notes-pop__list"></div>
        <form class="yt-notes-pop__add">
          <input class="yt-notes-pop__t" type="text" placeholder="2:14" aria-label="Timestamp" />
          <input class="yt-notes-pop__text" type="text" placeholder="a note at that moment…" aria-label="Note" />
          <button type="submit" class="yt-notes-pop__addbtn">add</button>
        </form>`;
      const list = pop.querySelector(".yt-notes-pop__list");
      if (!notes.length) {
        list.innerHTML = `<p class="yt-notes-pop__empty">Nothing yet. Play the video and use "＋ note here", or add one below.</p>`;
      }
      for (const n of notes) {
        const row = document.createElement("div");
        row.className = "yt-notes-pop__row";
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "yt-notes-pop__time";
        jump.textContent = formatTime(n.t);
        jump.title = "Jump to this moment";
        jump.addEventListener("click", () => this.seekToTimedNote(item, n.t));
        const body = document.createElement("span");
        body.className = "yt-notes-pop__body";
        body.textContent = n.text;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "yt-notes-pop__del";
        del.textContent = "×";
        del.title = "Remove this note";
        del.addEventListener("click", () => {
          this.removeTimedNote(item, n.id);
          render();
          this._showBar();
        });
        row.append(jump, body, del);
        list.appendChild(row);
      }
      pop.querySelector(".yt-notes-pop__close").addEventListener("click", () => this.closeTimedNotes());
      pop.querySelector(".yt-notes-pop__add").addEventListener("submit", (e) => {
        e.preventDefault();
        const tRaw = pop.querySelector(".yt-notes-pop__t").value;
        const text = pop.querySelector(".yt-notes-pop__text").value.trim();
        const t = parseTime(tRaw);
        if (t == null) { alert("Use a timestamp like 2:14."); return; }
        if (!text) return;
        this.addTimedNote(item, t, text);
        render();
        this._showBar();
      });
    };
    render();
    document.body.appendChild(pop);

    // Same flip-and-clamp placement the link popovers use, so it can't open
    // off-screen next to a toolbar or a screen edge.
    const r = anchorEl.getBoundingClientRect();
    const w = pop.offsetWidth || 300;
    const h = pop.offsetHeight || 240;
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = r.top - h - 8;
    pop.style.left = Math.min(Math.max(r.left, 8), window.innerWidth - w - 8) + "px";
    pop.style.top = Math.min(Math.max(top, 8), window.innerHeight - h - 8) + "px";

    const onOutside = (e) => {
      if (!pop.contains(e.target) && e.target !== anchorEl) this.closeTimedNotes();
    };
    setTimeout(() => document.addEventListener("pointerdown", onOutside), 0);
    this._timedNotesPop = { el: pop, cleanup: () => document.removeEventListener("pointerdown", onOutside) };
  }

  closeTimedNotes() {
    if (!this._timedNotesPop) return;
    this._timedNotesPop.cleanup();
    this._timedNotesPop.el.remove();
    this._timedNotesPop = null;
  }

  _updateYtNoteCount(item) {
    const badge = this.nodes.get(item.id)?.querySelector(".yt-note-count");
    if (!badge) return;
    const n = (item.timeNotes || []).length;
    badge.textContent = n ? `🕒 ${n}` : "";
    badge.hidden = !n;
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
  _buildEmbedIframe(videoId, onClose, { jsApi = false } = {}) {
    const iframe = document.createElement("iframe");
    iframe.src = youtubeEmbedUrl(videoId, { autoplay: true, jsApi });
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

  /** The halo (a warm glow) plus a small count is how an item shows it has
   *  a layer beneath it — double-click it to go there. */
  _updateBadge(item) {
    if (!item) return;
    const n = this._layerChildren(item.id).length;
    // Fans out across the whole connected group: every member opens the
    // SAME layer, so they gain and lose the halo together. Updating only
    // the item that happened to gain a child would leave its partners
    // looking empty while opening into a full layer.
    for (const id of this._component(item.id)) {
      const el = this.nodes.get(id);
      const badge = el?.querySelector(".badge");
      if (!badge) continue;
      badge.style.display = n ? "" : "none";
      badge.textContent = String(n);
      el.classList.toggle("has-layer", n > 0);
    }
  }

  // ---------- visibility (collapse/expand) ----------
  /** The layer directly above the one you're on — undefined at the top
   *  level, where there's nothing to show through. This is the "layer 1"
   *  in "let me still see layer 1 while I'm on layer 2": always exactly
   *  one step up, not every ancestor at once. */
  _parentLayerId() {
    if (!this.focusStack.length) return undefined;
    const focusItem = this._get(this.focusId);
    return focusItem ? focusItem.parentId || null : undefined;
  }

  _applyVisibility() {
    const parentLayer = this._parentLayerId();
    for (const it of items) {
      const el = this.nodes.get(it.id);
      if (!el) continue;
      const current = this._visible(it);
      // The layer you just came from shows through faintly — like tracing
      // paper over what's beneath it — rather than vanishing the instant
      // you descend. Purely visual: pointer-events stay off it below, so
      // it can't be dragged, selected, or mistaken for something on the
      // layer you're actually working on.
      const ghost = !current && parentLayer !== undefined && (it.parentId || null) === parentLayer;
      el.classList.toggle("is-hidden", !current && !ghost);
      el.classList.toggle("is-ghost", ghost);
    }
    if (this.selected && !this._visible(this._get(this.selected))) {
      this.select(null);
    }
    this._renderConnections();
    this.onVisibility?.(); // grouped backgrounds follow expand/collapse
  }

  /** How visible the layer above shows through while you're descended —
   *  0 (gone) to 1 (as solid as the layer you're actually on). A live CSS
   *  variable rather than a re-render, so dragging the slider is instant. */
  setGhostOpacity(v) {
    this.ghostOpacity = Math.min(1, Math.max(0, v));
    this.world.style.setProperty("--ghost-opacity", String(this.ghostOpacity));
  }

  // ---------- layers: descending into (and back out of) an item ----------
  /** A short, human label for the breadcrumb trail. */
  _oneLabel(item) {
    if (!item) return "mosaic";
    if (item.type === "text") return deriveTitle(item.text) || "note";
    return item.name || item.title || item.type;
  }

  /** A shared layer is named after everything that opens into it, so the
   *  breadcrumb says whose layer you're standing in. */
  _layerLabel(item) {
    if (!item) return "mosaic";
    const comp = this._component(item.id).map((id) => this._get(id)).filter(Boolean);
    if (comp.length <= 1) return this._oneLabel(item);
    const names = comp.slice(0, 2).map((it) => this._oneLabel(it));
    return names.join(" + ") + (comp.length > 2 ? ` +${comp.length - 2}` : "");
  }

  _notifyFocus() {
    const crumbs = this.focusStack.map((id) => ({ id, label: this._layerLabel(this._get(id)) }));
    this.onFocusChange?.(crumbs);
  }

  /** Bounding box of a set of items, in world space — used to travel the
   *  viewport to a layer's actual contents rather than just its origin. */
  _boundsOf(list) {
    if (!list.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of list) {
      minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + it.w); maxY = Math.max(maxY, it.y + it.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Travel into `item`'s layer. Callers decide WHEN that's meaningful —
   *  the double-click handler only offers it once the item already has a
   *  halo (real content below); "↳ enter layer" in the item bar calls this
   *  unconditionally, since going into a still-empty layer to start
   *  building it is exactly the point of that button. Navigation, not an
   *  edit: no undo snapshot. */
  descend(item) {
    if (!item) return false;
    this._activeEmbed?.stop(); // don't leave a video from this layer still playing behind you
    this.closeTimedNotes();
    this.select(null);
    this.viewStack.push(this.vp.snapshot());
    // Descending from EITHER end of a connection lands on the same layer.
    const owner = this._layerOwner(item.id);
    this.focusStack.push(owner);
    this._applyVisibility();
    const bounds = this._boundsOf(this._children(owner)) || { x: item.x, y: item.y, w: item.w, h: item.h };
    this.vp.travelTo(bounds);
    this.positionBar();
    this._notifyFocus();
    return true;
  }

  /** Step back up one layer, or jump straight to a specific depth (0 =
   *  the top-level mosaic) — the breadcrumb trail passes an index. */
  ascend(toIndex = this.focusStack.length - 1) {
    if (!this.focusStack.length) return;
    this._activeEmbed?.stop();
    this.closeTimedNotes();
    this.select(null);
    let snap;
    while (this.focusStack.length > Math.max(0, toIndex)) {
      this.focusStack.pop();
      snap = this.viewStack.pop();
    }
    this._applyVisibility();
    if (snap) this.vp.restore(snap);
    this.positionBar();
    this._notifyFocus();
  }

  // ---------- selection + contextual bar ----------
  select(id) {
    if (this.locked) id = null; // view mode has no selection — only deselection
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
    } else if (item?.type === "text" && !item.shapeSrc) {
      // A plain note's "fill" is just a faint wash behind the words — not
      // something worth a control of its own; font size covers what people
      // actually mean to adjust here. A note wearing a PHOTO's shape is a
      // different matter: there the slider fades the photo itself, which is
      // very much worth reaching for, so it stays available below.
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

    // Timed notes — YouTube items only, with a count once there are any.
    const tnBtn = this.bar.querySelector('[data-act="timednotes"]');
    tnBtn.style.display = item?.type === "youtube" ? "" : "none";
    if (item?.type === "youtube") {
      const n = (item.timeNotes || []).length;
      tnBtn.textContent = n ? `🕒 notes (${n})` : "🕒 notes";
    }

    // Shape-from-a-photo — text items only. "clear" only when there's a
    // shape to clear.
    const shapeBtn = this.bar.querySelector('[data-act="noteshape"]');
    const shapeClear = this.bar.querySelector('[data-act="noteshape-clear"]');
    const isText = item?.type === "text";
    shapeBtn.style.display = isText ? "" : "none";
    shapeClear.style.display = isText && item.shapeSrc ? "" : "none";
    shapeBtn.textContent = item?.shapeSrc ? "🖼 change shape" : "🖼 shape";

    // Same button opens the same popover either way, but its label should
    // say "edit" once there's something to edit (and remove) — "attach"
    // reads like a dead end once a link is already there.
    const embedBtn = this.bar.querySelector('[data-act="embed"]');
    embedBtn.classList.toggle("is-on", !!item?.embed);
    embedBtn.textContent = item?.embed ? "🔗 edit / remove link" : "🔗 attach link";
    this._reflectConnectState();
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
    this.bar.querySelector('[data-act="timednotes"]').addEventListener("click", (e) => {
      const item = this._get(this.selected);
      if (item?.type === "youtube") this.openTimedNotes(item, e.currentTarget);
    });
    this.bar.querySelector('[data-act="noteshape"]').addEventListener("click", () => {
      const item = this._get(this.selected);
      if (item?.type === "text") this.onPickNoteShape?.(item);
    });
    this.bar.querySelector('[data-act="noteshape-clear"]').addEventListener("click", () =>
      this.setNoteShapeImage(null)
    );
    this.bar.querySelector("#itemFontSize").addEventListener("input", (e) =>
      this.setFontSize(Number(e.target.value))
    );
    this.bar.querySelector('[data-act="draw"]').addEventListener("click", () => {
      this.drawMode = !this.drawMode;
      this._reflectDrawState();
    });
    this.bar.querySelector('[data-act="connect"]').addEventListener("click", () => {
      if (this.connectFrom) return this.endConnect(); // pressing it again disarms
      if (this.selected) this.startConnect(this.selected);
    });
    this.bar.querySelector('[data-act="enter-layer"]').addEventListener("click", () => {
      const item = this._get(this.selected);
      if (item) this.descend(item); // an empty item just gets an empty layer — the toolbar does the rest
    });
    this.bar.querySelector('[data-act="duplicate"]').addEventListener("click", () => {
      const item = this._get(this.selected);
      if (item) this.duplicate(item);
    });
    this.bar.querySelector('[data-act="embed"]').addEventListener("click", async (e) => {
      const anchorEl = e.currentTarget; // capture before the await — currentTarget goes null once dispatch ends
      const item = this._get(this.selected);
      if (!item) return;
      const { openEmbedPrompt } = await import("../links/links.js");
      // A host to preview against — only when this item actually has its
      // own picture to superimpose the new thumbnail over (a cut-out
      // photo, or a note wearing one). The clip-path is read straight off
      // the item's own already-rendered element rather than recomputed:
      // it's guaranteed to match exactly what's on screen right now, no
      // second silhouette trace needed.
      const hostSrc = item.type === "image" ? item.src : item.type === "text" ? item.shapeSrc : null;
      const hostEl = hostSrc && this.nodes.get(item.id)?.querySelector(".item--image__clip, .text-card");
      const host = hostSrc ? { src: hostSrc, w: item.w, h: item.h, clipPath: hostEl?.style.clipPath || null } : null;
      openEmbedPrompt(
        anchorEl,
        item.embed || null,
        (embed) => {
          pushUndoSnapshot();
          // The shape itself (including its own sensible default — "the
          // photo's own outline" for a fresh link on a photo) is entirely
          // links.js's call now; embed.clipShape arrives already decided.
          item.embed = embed;
          save();
          this._reRender(item);
        },
        () => {
          pushUndoSnapshot();
          delete item.embed;
          save();
          this._reRender(item);
        },
        host
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
      this._applyTextStyle(this.nodes.get(item.id), item);
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

  /** Colour and size for a note's body. */
  _applyTextStyle(el, item) {
    const body = el.querySelector(".text-body");
    if (!body) return;
    body.style.color = item.color || this.color;
    body.style.fontSize = (item.fontSize || 16) + "px";
  }

  /** Give a note a photo's shape (a cutout data URL), or clear it with null. */
  setNoteShapeImage(src) {
    const item = this._get(this.selected);
    if (!item || item.type !== "text") return;
    pushUndoSnapshot();
    if (src) item.shapeSrc = src;
    else delete item.shapeSrc;
    save();
    this._reRender(item); // the shape image and its clip-path are structural
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
    const el = this.nodes.get(item.id);
    if (el) this._applyTextStyle(el, item);
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
    // Different shapes need different mechanisms (a mask for an outline, a
    // clip-path for a circle, a radius for rounded), so clear all three
    // first — otherwise switching shapes would stack the old one under
    // the new one.
    el.style.maskImage = el.style.webkitMaskImage = "";
    el.style.clipPath = "";
    el.style.borderRadius = "";
    if (v.text) return; // a short text label has no shape to take
    const shape = embedClipShape(item.embed);
    if (shape === "box") return;
    if (shape === "circle") { el.style.clipPath = "circle(50% at 50% 50%)"; return; }
    if (shape === "rounded") { el.style.borderRadius = "18%"; return; }
    // "own" borrows the host's own alpha — the photo itself for an image
    // item, or its shape photo for a note wearing one; "photo" borrows a
    // cutout picked specifically for this preview. Either way it's an
    // image used as a mask, sized the same way the host is drawn (contain,
    // centred) so the two line up.
    const src =
      shape === "photo"
        ? item.embed?.clipShapeSrc
        : item.type === "image"
          ? item.src
          : item.type === "text"
            ? item.shapeSrc
            : null;
    if (!src) return;
    el.style.maskImage = el.style.webkitMaskImage = `url(${src})`;
    el.style.maskSize = el.style.webkitMaskSize = "contain";
    el.style.maskRepeat = el.style.webkitMaskRepeat = "no-repeat";
    el.style.maskPosition = el.style.webkitMaskPosition = "center";
  }

  // A buried link's preview shape is chosen entirely in links.js's add/
  // edit-link popover now, alongside the thumbnail photo itself — it only
  // ever mattered in that context, so it no longer needs its own separate
  // item-bar button and popover.

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
    delete clone.links; // a copy starts unconnected, same as it starts childless
    const added = addItem(clone);
    this._render(added);
    this._applyVisibility();
    this.select(added.id);
    return added;
  }

  // ---------- per-item interaction ----------
  _wire(el, item, { svg, handle, del, badge, fileOpen, linkOpen, linkEdit, ytPoster, ytCard, embedOverlay, imageClip, textCard }) {
    // For an image or a text item, the body select/move/tap gesture is
    // hosted on the (possibly shape-clipped) clip element instead of the
    // item itself — el is pointer-events:none for both (see styles/main.css)
    // precisely so a click on a transparent corner of a cutout, or of a
    // note wearing one, falls through to whatever's behind, and that only
    // works for the element clip-path is actually applied to. Every other
    // item type is unaffected: el IS the body target, exactly as before.
    const bodyTarget = imageClip || textCard || el;
    badge.style.pointerEvents = "none";

    // File cards (docs/videos placed from the pocket) open on their own
    // button — a readable document goes to the in-app viewer (where its
    // margin notes live); anything else still just opens in a new tab.
    if (fileOpen) {
      fileOpen.addEventListener("pointerdown", (e) => e.stopPropagation());
      fileOpen.addEventListener("click", async (e) => {
        e.stopPropagation();
        // A plain note has no file behind it — it just opens its own words.
        if (item.type === "text" && !item.pocketId) { this.onReadNote?.(item); return; }
        if (!item.pocketId) { alert("This file isn't available."); return; }
        if (this.onOpenDoc && (await this.onOpenDoc(item.pocketId))) return;
        if (!this.resolveFileUrl) { alert("This file isn't available."); return; }
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
      // "Connect" is armed: this tap is the far end of the line, not a
      // select or a drag. Checked first so nothing else claims it.
      if (this.connectFrom && this.connectFrom !== item.id) {
        e.stopPropagation();
        e.preventDefault();
        const from = this.connectFrom;
        this.endConnect();
        this.connect(from, item.id);
        this.select(item.id);
        return;
      }
      if (e.target === handle || e.target === del || e.target === fileOpen || e.target === linkOpen || e.target === linkEdit || e.target.closest?.(".yt-card__edit, .embed-badge")) return;
      if (e.target.isContentEditable) return; // editing text
      if (embedOverlay?.classList.contains("is-active") || e.target.closest?.(".yt-card__iframe, .embed-overlay__iframe, .yt-card__shrink, .embed-overlay__close")) return; // let the live embed / its controls handle their own input
      const tappedPoster = !!(ytPoster && (e.target === ytPoster || ytPoster.contains(e.target)));

      // View mode: nothing drags and nothing selects, but the board stays
      // alive — a TAP plays a video, opens a buried link, or reveals a
      // group's notes directly (no select-first step: with no selection to
      // disambiguate from, the first tap can just mean what it says). A
      // DRAG deliberately falls through to the viewport — not stopping
      // propagation is what lets a pan start anywhere, including on items,
      // so the whole mosaic handles like one fixed surface. The viewport
      // captures the pointer, so pointerup is watched on document (capture
      // retargets events to the capturer; they still bubble to document).
      if (this.locked) {
        const sx = e.clientX, sy = e.clientY;
        const onUp = (ev) => {
          document.removeEventListener("pointerup", onUp);
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > TAP_SLOP) return; // was a pan
          if (tappedPoster && item.type === "youtube") {
            this._setYtPlaying(el.querySelector(".yt-card"), item, true);
          } else if (item.embed && embedOverlay && !embedOverlay.classList.contains("is-active")) {
            this._activateEmbed(embedOverlay, item);
          }
          // A layer beneath is entered with a double-click (its own
          // listener, below) — a single tap no longer reveals it in place.
        };
        document.addEventListener("pointerup", onUp);
        return;
      }

      e.stopPropagation();
      const wasSelected = this.selected === item.id;
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
        this._renderConnections(); // lines follow their items while dragging
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
        // this" apart. Descending into a layer is a double-click, its own
        // listener below, so it isn't part of this single/second-tap chain.
        //
        // tappedPoster is checked BEFORE the embed-activation check on
        // purpose: a tap on the poster is a specific, unambiguous target, so
        // it should still play even once the item also has a note attached
        // — otherwise attaching a note to a video silently makes the video
        // untappable (a real bug this order fixes; a buried item.embed with
        // no poster of its own gets the same fix via its badge, below).
        if (moved) {
          save();
        } else if (wasSelected && tappedPoster && item.type === "youtube") {
          this._setYtPlaying(el.querySelector(".yt-card"), item, true);
        } else if (wasSelected && item.embed && embedOverlay && !embedOverlay.classList.contains("is-active")) {
          this._activateEmbed(embedOverlay, item);
        }
      };
      bodyTarget.addEventListener("pointermove", onMove);
      bodyTarget.addEventListener("pointerup", onUp);
    });

    // Double-click: descend into this item's layer if it has one — in
    // either view or edit mode, same as pan/zoom/tap-to-play, since
    // traveling through the mosaic isn't an edit. Only once there's
    // nowhere to go does double-click fall back to a type's own meaning
    // (today, just a text note's in-place editor) — so the SAME gesture
    // cleanly means two different things depending on whether this item
    // has a layer beneath it, never both at once.
    el.addEventListener("dblclick", (e) => {
      if (this._layerChildren(item.id).length) {
        e.stopPropagation();
        this.descend(item);
        return;
      }
      if (this.locked) {
        // View mode has no item bar to press "↳ enter layer" from, but
        // descend() is travel, not an edit (see its own comment) — so
        // starting a still-empty layer shouldn't need edit mode any more
        // than stepping into a full one does a few lines up. Text's own
        // dblclick-to-edit meaning below only ever applied once unlocked,
        // so there's nothing here for it to clash with.
        e.stopPropagation();
        this.descend(item);
        return;
      }
      if (item.type !== "text") return;
      e.stopPropagation();
      // The header and the body are edited separately — whichever you
      // actually double-clicked is the one that opens. e.target can't
      // answer that: the body pointerdown calls setPointerCapture on the
      // item, and a captured pointer retargets its click/dblclick to the
      // capturing element, so e.target is ALWAYS the item here. Hit-test
      // the coordinates instead, which is unaffected by capture.
      this._editText(item, el);
    });

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
        this._renderConnections(); // a resize moves the item's centre, so its lines move too
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
    // Caret to the END rather than selecting everything: on a note with
    // real text in it, select-all means the next keystroke wipes the lot.
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    body.scrollTop = body.scrollHeight;

    // Follow the words: keep whatever is being typed inside the box,
    // instead of letting it spill out past the edges.
    const onInput = () => scrollCaretIntoView(body);
    body.addEventListener("input", onInput);

    const finish = () => {
      body.contentEditable = "false";
      item.text = body.textContent.trim();
      body.removeEventListener("input", onInput);
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
    if (this.connectFrom === id) this.endConnect();

    // Cut this item out of any connected group FIRST. Two things depend on
    // it: the survivors' lines must not point at a ghost, and a shared
    // layer must not be deleted along with whichever member happened to
    // own it — the group's other members are still standing there with a
    // halo, so the layer is handed to the next owner instead.
    const item = this._get(id);
    const peers = (item?.links || []).map((p) => this._get(p)).filter(Boolean);
    for (const peer of peers) {
      peer.links = (peer.links || []).filter((x) => x !== id);
      if (!peer.links.length) delete peer.links;
    }
    if (item) delete item.links;
    if (peers.length) {
      const newOwner = this._layerOwner(peers[0].id);
      for (const child of this._children(id)) child.parentId = newOwner;
    }

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
    for (const peer of peers) this._updateBadge(peer); // they may have just gained/kept the layer
    // Deleting the item whose layer you're standing in (reachable via a
    // peer's shared layer) would otherwise strand focusId on nothing.
    while (this.focusStack.length && !this._get(this.focusId)) {
      this.focusStack.pop();
      this.viewStack.pop();
    }
    this._applyVisibility();
    this._notifyFocus();
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
