// links/links.js — "add a link": any URL, not just YouTube.
//
// A YouTube link gets the rich treatment (thumbnail, click-to-play embed —
// see youtube/youtube.js). Everything else becomes a plain link card:
// favicon + title + domain, opens in a new tab. That's a deliberate, honest
// choice — most sites send X-Frame-Options/CSP headers that block being
// embedded in an iframe at all, so a live "embed" of an arbitrary URL
// mostly wouldn't work; a bookmark-style card always does.

import { parseYouTubeId, youtubeThumbnail, youtubeWatchUrl, fetchYouTubeTitle } from "../youtube/youtube.js";
import { alphaClipPath } from "../scripts/silhouette.js";

export function normalizeUrl(input) {
  let s = (input || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s; // assume https with no scheme
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null; // only http(s) — no javascript:, data:, etc.
    if (!u.hostname.includes(".")) return null; // reject e.g. "https://asdf"
    return u.href;
  } catch {
    return null;
  }
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function faviconUrl(url) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domainOf(url))}&sz=64`;
}

/**
 * Classify a pasted link.
 * @returns {Promise<null | {kind:'youtube', videoId, title, thumbnailUrl, url} | {kind:'link', title, faviconUrl, domain, url}>}
 * null means the input isn't a usable link at all.
 */
export async function resolveLink(input) {
  const videoId = parseYouTubeId(input);
  if (videoId) {
    const title = await fetchYouTubeTitle(videoId); // best-effort, may come back null
    return { kind: "youtube", videoId, title: title || "", thumbnailUrl: youtubeThumbnail(videoId), url: youtubeWatchUrl(videoId) };
  }
  const url = normalizeUrl(input);
  if (!url) return null;
  return { kind: "link", title: "", faviconUrl: faviconUrl(url), domain: domainOf(url), url };
}

// ---------------- shared "custom thumbnail" control ----------------
// A generic link's preview is normally auto-detected (a YouTube frame's
// thumbnail, or the page's favicon) — but a favicon is often useless (e.g.
// the generic Web Archive icon), so both link popovers below offer a way to
// swap in a photo of your own, or just a short label, instead. Mutually
// exclusive: picking one clears the other. Neither is required — leaving
// both blank keeps the auto-detected preview.
const THUMB_MAX = 240; // px on the long edge — plenty for a card-sized preview, keeps the stored data URL small

// The main app wires this to the same cut-out studio used for every other
// photo upload (background removal, adjustable tolerance) — so a thumbnail
// photo gets edited the same familiar way instead of just being auto-resized
// with no say in it. (file) => Promise<dataURL|null>, null if canceled.
let editPhotoHook = null;
export function setPhotoEditor(fn) {
  editPhotoHook = fn;
}

/** The { aspect, clipPath } payload editPhotoHook expects, built from an
 *  openEmbedPrompt host — null when there's nothing to fit against (an
 *  item with no picture of its own), so an ordinary un-shaped crop stands. */
function hostPayload(host) {
  return host ? { aspect: { w: host.w, h: host.h }, clipPath: host.clipPath || null } : null;
}

function resizeImageSrc(src, maxSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("Couldn't read that image"));
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/png"));
    };
    img.src = src;
  });
}

function resizeImageFile(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(resizeImageSrc(reader.result, maxSize));
    reader.readAsDataURL(file);
  });
}

// What shape a buried link's preview takes — only ever meaningful in this
// popover (an item that isn't carrying a link has nothing to shape), so
// picking it lives entirely here rather than as a separate item-bar trip.
// "a photo" sits right after "outline": they're the two silhouette
// options, ahead of the geometric ones.
const CLIP_SHAPES = [
  ["own", "🍃", "outline"],
  ["photo", "🖼", "a photo"],
  ["circle", "◯", "circle"],
  ["rounded", "▢", "rounded"],
  ["box", "▭", "box"],
];

/** The shape stored on an embed, read the same way for a brand-new pick
 *  (defaults to "own" — the host's outline is the sensible starting point
 *  whenever there's a host to take it from) as for one already saved
 *  (older items only carry the clipToShape boolean). */
function initialClipShape(current) {
  if (!current) return "own";
  if (current.clipShape) return current.clipShape;
  return current.clipToShape === false ? "box" : "own";
}

function thumbControlsHTML(host) {
  // Attaching a link to an item that already has its own picture (a
  // cut-out photo, or a note wearing one): show the two composited at 50%
  // — the host's real shape as the base, the thumbnail you're picking laid
  // over it exactly how it will actually render (background-size: cover,
  // clipped to whatever shape you've chosen below) — so you can judge its
  // scale before saving instead of committing, checking on the canvas, and
  // reopening this to try again. Nothing to overlay against otherwise (a
  // rect, a plain note, brand-new links from the toolbar with no host at
  // all), so the small icon preview below is the whole story in that case
  // — and there's no shape to choose either, for the same reason.
  const overlay = host
    ? `<div class="link-pop__overlay" style="aspect-ratio:${host.w}/${host.h}">
         <div class="link-pop__overlay-host"></div>
         <div class="link-pop__overlay-thumb"></div>
         <p class="link-pop__overlay-hint">the item, and your picture over it at 50% — reopen "upload photo" to adjust its crop and zoom</p>
       </div>
       <div class="link-pop__shapes">
         <span class="link-pop__shapes-label">preview shape</span>
         <div class="link-pop__shapes-row">
           ${CLIP_SHAPES.map(([id, glyph, label]) =>
             `<button type="button" class="link-pop__shape-opt" data-shape="${id}" title="${label}"><span>${glyph}</span></button>`
           ).join("")}
         </div>
         <input type="file" accept="image/*" class="link-pop__shape-file" hidden />
       </div>`
    : "";
  return `
    ${overlay}
    <div class="link-pop__thumb">
      <div class="link-pop__thumb-preview"></div>
      <div class="link-pop__thumb-controls">
        <button type="button" class="link-pop__thumb-btn" data-act="thumb-upload">upload photo</button>
        <input type="file" accept="image/*" class="link-pop__thumb-file" hidden />
        <input type="text" class="link-pop__thumb-text" placeholder="or type a label" maxlength="40" />
        <button type="button" class="link-pop__thumb-btn link-pop__thumb-reset" data-act="thumb-reset" hidden>remove photo</button>
      </div>
    </div>`;
}

/**
 * Wires the "preview shape" row inside openEmbedPrompt's popover — only
 * called when there's a host to shape against. Returns a getter for the
 * chosen { clipShape, clipShapeSrc }.
 */
function wireShapeControls(pop, current, outsideGuard, host) {
  if (!host) return () => ({});
  const state = { shape: initialClipShape(current), src: current?.clipShapeSrc || null, clipPath: null };
  const overlayThumb = pop.querySelector(".link-pop__overlay-thumb");
  const opts = [...pop.querySelectorAll(".link-pop__shape-opt")];
  const fileInput = pop.querySelector(".link-pop__shape-file");

  const paint = () => {
    for (const b of opts) b.classList.toggle("is-on", b.dataset.shape === state.shape);
    overlayThumb.style.clipPath = "";
    overlayThumb.style.borderRadius = "";
    if (state.shape === "circle") overlayThumb.style.clipPath = "circle(50% at 50% 50%)";
    else if (state.shape === "rounded") overlayThumb.style.borderRadius = "18%";
    else if (state.shape === "own" && host.clipPath) overlayThumb.style.clipPath = host.clipPath;
    else if (state.shape === "photo" && state.clipPath) overlayThumb.style.clipPath = state.clipPath;
    // "box" (and "photo" before its own trace has resolved) leaves both
    // cleared — a plain rectangle, same as the real preview would show.
  };
  paint();

  for (const btn of opts) {
    btn.addEventListener("click", () => {
      if (btn.dataset.shape !== "photo") {
        state.shape = btn.dataset.shape;
        paint();
        return;
      }
      // "a photo" is an action, not a plain toggle — even re-clicking it
      // while already selected re-opens the picker, since the whole point
      // is choosing (or changing) WHICH photo.
      fileInput.value = "";
      fileInput.click();
    });
  }
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (outsideGuard) outsideGuard.suspended = true;
    try {
      const edited = editPhotoHook ? await editPhotoHook(file, hostPayload(host)) : null;
      if (editPhotoHook && !edited) return; // canceled out of the studio — leave the previous shape choice alone
      const src = edited || (await resizeImageFile(file, THUMB_MAX));
      state.shape = "photo";
      state.src = src;
      state.clipPath = null; // traced below — a plain rectangle is the honest interim, never a wrong-looking guess
      paint();
      // The overlay's own accuracy depends on the real silhouette, not
      // just the picked photo's bounding box — trace it the same way a
      // cut-out photo or a shaped note already does. Guard against a
      // stale trace landing after the picker moved on (another shape
      // picked meanwhile, or a different photo re-picked).
      const tracing = src;
      const clipPath = await alphaClipPath(src).catch(() => null);
      if (state.shape !== "photo" || state.src !== tracing) return;
      state.clipPath = clipPath;
      paint();
    } catch {
      alert("Couldn't use that image.");
    } finally {
      if (outsideGuard) outsideGuard.suspended = false;
    }
  });

  return () => ({
    clipShape: state.shape,
    ...(state.shape === "photo" && state.src ? { clipShapeSrc: state.src } : {}),
  });
}

/**
 * Wires up a popover's thumbControlsHTML() block; returns a getter for the
 * current override. `outsideGuard` (optional) — see openLinkPrompt/
 * openEmbedPrompt — is held suspended while the shared cut-out studio is
 * open, since its controls live outside `pop`'s own DOM and would otherwise
 * be read as "clicked outside the popover, close it."
 */
function wireThumbControls(pop, current, outsideGuard, host = null) {
  const state = { image: current?.thumbnailImage || null, text: current?.thumbnailText || null };
  const preview = pop.querySelector(".link-pop__thumb-preview");
  const overlayHost = pop.querySelector(".link-pop__overlay-host");
  const overlayThumb = pop.querySelector(".link-pop__overlay-thumb");
  if (host && overlayHost) {
    overlayHost.style.backgroundImage = `url(${host.src})`;
    if (host.clipPath) {
      overlayHost.style.clipPath = host.clipPath;
      overlayThumb.style.clipPath = host.clipPath; // same outline, so the overlay reads as "on the item," not "on its box"
    }
  }
  const uploadBtn = pop.querySelector('[data-act="thumb-upload"]');
  const fileInput = pop.querySelector(".link-pop__thumb-file");
  const textInput = pop.querySelector(".link-pop__thumb-text");
  const resetBtn = pop.querySelector('[data-act="thumb-reset"]');
  textInput.value = state.text || "";

  const render = () => {
    if (state.image) {
      preview.style.backgroundImage = `url(${state.image})`;
      preview.textContent = "";
    } else {
      preview.style.backgroundImage = "";
      preview.textContent = state.text || "auto";
    }
    preview.classList.toggle("link-pop__thumb-preview--empty", !state.image && !state.text);
    resetBtn.hidden = !state.image && !state.text;
    // Says exactly what it's about to do — a custom PHOTO is what people
    // actually go looking to remove; "use default" read as a vague reset
    // and didn't say the link itself survives untouched.
    resetBtn.textContent = state.image ? "remove photo" : state.text ? "remove label" : "remove photo";
    resetBtn.title = "Back to the link's own preview — the link itself stays";
    // A text label has no size to judge against the host, so the overlay
    // only shows for a picked photo — an empty overlay box would just be
    // confusing next to the small preview already saying "auto"/the label.
    if (overlayThumb) {
      overlayThumb.style.backgroundImage = state.image ? `url(${state.image})` : "";
      overlayThumb.classList.toggle("link-pop__overlay-thumb--empty", !state.image); // CSS holds the 50%; this only shows/hides it
    }
  };
  render();

  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (outsideGuard) outsideGuard.suspended = true;
    try {
      // Route through the same cut-out studio as any other photo upload —
      // background removal, adjustable tolerance, and (when there's a
      // host to fit against) a crop frame shaped like the item itself,
      // defaulting to showing the whole photo rather than cropping it —
      // when it's wired up; whatever comes back still gets capped down to
      // thumbnail size.
      const edited = editPhotoHook ? await editPhotoHook(file, hostPayload(host)) : null;
      if (editPhotoHook && !edited) return; // canceled out of the studio — leave the existing thumbnail alone
      state.image = edited ? await resizeImageSrc(edited, THUMB_MAX) : await resizeImageFile(file, THUMB_MAX);
      state.text = null;
      textInput.value = "";
      render();
    } catch {
      alert("Couldn't use that image.");
    } finally {
      if (outsideGuard) outsideGuard.suspended = false;
    }
  });
  textInput.addEventListener("input", () => {
    state.text = textInput.value.trim() || null;
    if (state.text) state.image = null;
    render();
  });
  resetBtn.addEventListener("click", () => {
    state.image = null;
    state.text = null;
    textInput.value = "";
    render();
  });

  return () => ({ thumbnailImage: state.image, thumbnailText: state.text });
}

// ---------------- "paste a link" popover ----------------
let openPop = null;

/**
 * @param {(link:object)=>void} onSubmit — called with a resolveLink() result
 *   (plus any custom thumbnail override)
 * @param {object|null} current — pass an existing link-shaped object to edit
 *   it in place instead of adding a new one
 */
export function openLinkPrompt(anchorEl, onSubmit, current = null) {
  closeLinkPrompt();
  const editing = !!current;
  const currentUrl = editing ? (current.kind === "link" ? current.url : youtubeWatchUrl(current.videoId)) : "";
  const pop = document.createElement("div");
  pop.className = "link-pop";
  pop.innerHTML = `
    <label class="link-pop__label">${editing ? "edit link" : "paste a link"}</label>
    <input type="text" class="link-pop__url" placeholder="https://… or a YouTube link" value="${currentUrl}" />
    <p class="link-pop__err" hidden>that doesn't look like a link</p>
    ${thumbControlsHTML(null)}
    <div class="link-pop__actions">
      <button type="button" class="link-pop__cancel" data-act="cancel">cancel</button>
      <button type="button" class="link-pop__add" data-act="add">${editing ? "save" : "add"}</button>
    </div>`;
  document.body.appendChild(pop);

  const r = anchorEl.getBoundingClientRect();
  const popW = pop.offsetWidth || 260;
  const popH = pop.offsetHeight || 150;
  // Prefer opening below the anchor; flip above it if there isn't room
  // (e.g. the bottom toolbar), then clamp fully on-screen either way.
  let top = r.bottom + 8;
  if (top + popH > window.innerHeight - 8) top = r.top - popH - 8;
  pop.style.left = Math.min(Math.max(r.left, 8), window.innerWidth - popW - 8) + "px";
  pop.style.top = Math.min(Math.max(top, 8), window.innerHeight - popH - 8) + "px";

  const input = pop.querySelector(".link-pop__url");
  const err = pop.querySelector(".link-pop__err");
  const addBtn = pop.querySelector('[data-act="add"]');
  // Suspended while the shared cut-out studio is open for the thumbnail
  // photo — its controls live outside this popover's own DOM and would
  // otherwise read as "clicked outside, close it" the moment they're touched.
  const outsideGuard = { suspended: false };
  const getThumbOverride = wireThumbControls(pop, current, outsideGuard);
  input.focus();

  const submit = async () => {
    err.hidden = true;
    addBtn.disabled = true;
    addBtn.textContent = editing ? "saving…" : "adding…";
    const link = await resolveLink(input.value).catch(() => null);
    if (!link) {
      err.hidden = false;
      addBtn.disabled = false;
      addBtn.textContent = editing ? "save" : "add";
      return;
    }
    onSubmit({ ...link, ...getThumbOverride() });
    closeLinkPrompt();
  };
  addBtn.addEventListener("click", submit);
  pop.querySelector('[data-act="cancel"]').addEventListener("click", closeLinkPrompt);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") closeLinkPrompt();
  });

  const onOutside = (e) => {
    if (outsideGuard.suspended) return;
    if (!pop.contains(e.target) && e.target !== anchorEl) closeLinkPrompt();
  };
  setTimeout(() => document.addEventListener("pointerdown", onOutside), 0);
  openPop = { el: pop, cleanup: () => document.removeEventListener("pointerdown", onOutside) };
}

export function closeLinkPrompt() {
  if (!openPop) return;
  openPop.cleanup();
  openPop.el.remove();
  openPop = null;
}

// ---------------- "attach a link to this item" popover ----------------
// Any link, same as the toolbar/pocket: a YouTube link plays inline right
// over the item on tap; any other link just opens in a new tab on tap (most
// sites block being framed at all — see the note at the top of this file).
// Its preview image (the video's thumbnail, or the page's favicon) starts
// hidden — the whole point is to "bury" it inside the item's own look — and
// is revealed afterward with the item bar's own opacity slider, which
// doubles as this control once an item has an embed. That single always-
// visible slider used to be a second, easy-to-miss one live only here.

/**
 * @param {{kind,videoId,url,title,thumbnailUrl,faviconUrl,domain,showThumbnail,thumbnailOpacity,thumbnailImage,thumbnailText}|null} current
 * @param {(embed:object)=>void} onSubmit — a full embed object, ready to store as item.embed
 * @param {()=>void} onRemove
 */
export function openEmbedPrompt(anchorEl, current, onSubmit, onRemove, host = null) {
  closeLinkPrompt();
  const hasExisting = !!current;
  const currentUrl = hasExisting ? (current.kind === "link" ? current.url : youtubeWatchUrl(current.videoId)) : "";
  const pop = document.createElement("div");
  pop.className = "link-pop";
  pop.innerHTML = `
    <label class="link-pop__label">${hasExisting ? "change the attached link" : "attach a link to this item"}</label>
    <input type="text" class="link-pop__url" placeholder="a YouTube link plays inline; any other link opens on tap" value="${currentUrl}" />
    <p class="link-pop__err" hidden>that doesn't look like a link</p>
    ${hasExisting ? '<p class="link-pop__hint">tip: this item\'s opacity slider now also reveals its preview</p>' : ""}
    ${thumbControlsHTML(host)}
    <div class="link-pop__actions" style="justify-content:space-between;">
      ${hasExisting ? '<button type="button" class="link-pop__remove" data-act="remove">remove</button>' : "<span></span>"}
      <span style="display:flex; gap:8px;">
        <button type="button" class="link-pop__cancel" data-act="cancel">cancel</button>
        <button type="button" class="link-pop__add" data-act="add">save</button>
      </span>
    </div>`;
  document.body.appendChild(pop);

  const r = anchorEl.getBoundingClientRect();
  const popW = pop.offsetWidth || 260;
  const popH = pop.offsetHeight || 150;
  let top = r.bottom + 8;
  if (top + popH > window.innerHeight - 8) top = r.top - popH - 8;
  pop.style.left = Math.min(Math.max(r.left, 8), window.innerWidth - popW - 8) + "px";
  pop.style.top = Math.min(Math.max(top, 8), window.innerHeight - popH - 8) + "px";

  const input = pop.querySelector(".link-pop__url");
  const err = pop.querySelector(".link-pop__err");
  const addBtn = pop.querySelector('[data-act="add"]');
  const outsideGuard = { suspended: false };
  const getThumbOverride = wireThumbControls(pop, current, outsideGuard, host);
  const getShapeOverride = wireShapeControls(pop, current, outsideGuard, host);
  input.focus();

  const submit = async () => {
    err.hidden = true;
    addBtn.disabled = true;
    addBtn.textContent = "saving…";
    const link = await resolveLink(input.value).catch(() => null);
    if (!link) {
      err.hidden = false;
      addBtn.disabled = false;
      addBtn.textContent = "save";
      return;
    }
    // Preserve an existing preview reveal/opacity when just changing the
    // link itself; otherwise start hidden, as a freshly-buried link should.
    const showThumbnail = hasExisting ? current.showThumbnail ?? false : false;
    const thumbnailOpacity = hasExisting ? current.thumbnailOpacity ?? 1 : 1;
    const thumbOverride = getThumbOverride();
    // clipShape is the picker's own call now, decided (with its sensible
    // default) inside wireShapeControls — this old boolean stays alongside
    // it, kept truthful, purely so anything that hasn't been touched since
    // before clipShape existed still reads correctly.
    const shapeOverride = getShapeOverride();
    const clipToShape = shapeOverride.clipShape ? shapeOverride.clipShape !== "box" : hasExisting ? !!current.clipToShape : false;
    const embed =
      link.kind === "youtube"
        ? { kind: "youtube", videoId: link.videoId, title: link.title, thumbnailUrl: link.thumbnailUrl, showThumbnail, thumbnailOpacity, clipToShape, ...thumbOverride, ...shapeOverride }
        : { kind: "link", url: link.url, title: link.title || link.domain, domain: link.domain, faviconUrl: link.faviconUrl, showThumbnail, thumbnailOpacity, clipToShape, ...thumbOverride, ...shapeOverride };
    onSubmit(embed);
    closeLinkPrompt();
  };
  addBtn.addEventListener("click", submit);
  pop.querySelector('[data-act="cancel"]').addEventListener("click", closeLinkPrompt);
  pop.querySelector('[data-act="remove"]')?.addEventListener("click", () => {
    onRemove();
    closeLinkPrompt();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") closeLinkPrompt();
  });

  const onOutside = (e) => {
    if (outsideGuard.suspended) return;
    if (!pop.contains(e.target) && e.target !== anchorEl) closeLinkPrompt();
  };
  setTimeout(() => document.addEventListener("pointerdown", onOutside), 0);
  openPop = { el: pop, cleanup: () => document.removeEventListener("pointerdown", onOutside) };
}
