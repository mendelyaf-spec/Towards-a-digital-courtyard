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

// ---------------- "paste a link" popover ----------------
let openPop = null;

/** @param {(link:object)=>void} onSubmit — called with a resolveLink() result */
export function openLinkPrompt(anchorEl, onSubmit) {
  closeLinkPrompt();
  const pop = document.createElement("div");
  pop.className = "link-pop";
  pop.innerHTML = `
    <label class="link-pop__label">paste a link</label>
    <input type="text" class="link-pop__url" placeholder="https://… or a YouTube link" />
    <p class="link-pop__err" hidden>that doesn't look like a link</p>
    <div class="link-pop__actions">
      <button type="button" class="link-pop__cancel" data-act="cancel">cancel</button>
      <button type="button" class="link-pop__add" data-act="add">add</button>
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
  input.focus();

  const submit = async () => {
    err.hidden = true;
    addBtn.disabled = true;
    addBtn.textContent = "adding…";
    const link = await resolveLink(input.value).catch(() => null);
    if (!link) {
      err.hidden = false;
      addBtn.disabled = false;
      addBtn.textContent = "add";
      return;
    }
    onSubmit(link);
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

// ---------------- "bury a video in this item" popover ----------------
// Same visual language as the link popover, but YouTube-only (an item can
// only carry a playable embed, not a bookmark) and offers a "remove" action.

/** @param {boolean} hasExisting @param {(videoId:string,title:string)=>void} onSubmit @param {()=>void} onRemove */
export function openEmbedPrompt(anchorEl, hasExisting, onSubmit, onRemove) {
  closeLinkPrompt();
  const pop = document.createElement("div");
  pop.className = "link-pop";
  pop.innerHTML = `
    <label class="link-pop__label">${hasExisting ? "change the buried video" : "bury a YouTube video in this item"}</label>
    <input type="text" class="link-pop__url" placeholder="https://youtube.com/watch?v=…" />
    <p class="link-pop__err" hidden>only YouTube links can be buried in an item</p>
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
  input.focus();

  const submit = async () => {
    err.hidden = true;
    addBtn.disabled = true;
    addBtn.textContent = "saving…";
    const videoId = parseYouTubeId(input.value);
    if (!videoId) {
      err.hidden = false;
      addBtn.disabled = false;
      addBtn.textContent = "save";
      return;
    }
    const title = await fetchYouTubeTitle(videoId).catch(() => null);
    onSubmit(videoId, title || "");
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
