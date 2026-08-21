// links/links.js — "add a link": any URL, not just YouTube.
//
// A YouTube link gets the rich treatment (thumbnail, click-to-play embed —
// see youtube/youtube.js). Everything else becomes a plain link card:
// favicon + title + domain, opens in a new tab. That's a deliberate, honest
// choice — most sites send X-Frame-Options/CSP headers that block being
// embedded in an iframe at all, so a live "embed" of an arbitrary URL
// mostly wouldn't work; a bookmark-style card always does.

import { parseYouTubeId, youtubeThumbnail, youtubeWatchUrl, fetchYouTubeTitle } from "../youtube/youtube.js";

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

function resizeImageFile(file, maxSize) {
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
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => { img.src = reader.result; };
    reader.readAsDataURL(file);
  });
}

function thumbControlsHTML() {
  return `
    <div class="link-pop__thumb">
      <div class="link-pop__thumb-preview"></div>
      <div class="link-pop__thumb-controls">
        <button type="button" class="link-pop__thumb-btn" data-act="thumb-upload">upload photo</button>
        <input type="file" accept="image/*" class="link-pop__thumb-file" hidden />
        <input type="text" class="link-pop__thumb-text" placeholder="or type a label" maxlength="40" />
        <button type="button" class="link-pop__thumb-btn link-pop__thumb-reset" data-act="thumb-reset" hidden>use default</button>
      </div>
    </div>`;
}

/** Wires up a popover's thumbControlsHTML() block; returns a getter for the current override. */
function wireThumbControls(pop, current) {
  const state = { image: current?.thumbnailImage || null, text: current?.thumbnailText || null };
  const preview = pop.querySelector(".link-pop__thumb-preview");
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
  };
  render();

  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      state.image = await resizeImageFile(file, THUMB_MAX);
      state.text = null;
      textInput.value = "";
      render();
    } catch {
      alert("Couldn't use that image.");
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
    ${thumbControlsHTML()}
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
  const getThumbOverride = wireThumbControls(pop, current);
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
export function openEmbedPrompt(anchorEl, current, onSubmit, onRemove) {
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
    ${thumbControlsHTML()}
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
  const getThumbOverride = wireThumbControls(pop, current);
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
    const embed =
      link.kind === "youtube"
        ? { kind: "youtube", videoId: link.videoId, title: link.title, thumbnailUrl: link.thumbnailUrl, showThumbnail, thumbnailOpacity, ...thumbOverride }
        : { kind: "link", url: link.url, title: link.title || link.domain, domain: link.domain, faviconUrl: link.faviconUrl, showThumbnail, thumbnailOpacity, ...thumbOverride };
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
    if (!pop.contains(e.target) && e.target !== anchorEl) closeLinkPrompt();
  };
  setTimeout(() => document.addEventListener("pointerdown", onOutside), 0);
  openPop = { el: pop, cleanup: () => document.removeEventListener("pointerdown", onOutside) };
}
