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

// ---------------- "attach a link to this item" popover ----------------
// Any link, same as the toolbar/pocket: a YouTube link plays inline right
// over the item on tap; any other link just opens in a new tab on tap (most
// sites block being framed at all — see the note at the top of this file).
// Either way, its preview image — the video's thumbnail, or the page's
// favicon — can optionally show as a translucent wash over the item; hidden
// by default, since the whole point is "bury" it inside the item's own look.

/**
 * @param {{kind,videoId,url,title,thumbnailUrl,faviconUrl,domain,showThumbnail,thumbnailOpacity}|null} current
 * @param {(embed:object)=>void} onSubmit — a full embed object, ready to store as item.embed
 * @param {()=>void} onRemove
 */
export function openEmbedPrompt(anchorEl, current, onSubmit, onRemove) {
  closeLinkPrompt();
  const hasExisting = !!current;
  const showThumbnail = current?.showThumbnail ?? false;
  const thumbnailOpacity = current?.thumbnailOpacity ?? 1;
  const currentUrl = hasExisting ? (current.kind === "link" ? current.url : youtubeWatchUrl(current.videoId)) : "";
  const pop = document.createElement("div");
  pop.className = "link-pop";
  pop.innerHTML = `
    <label class="link-pop__label">${hasExisting ? "change the attached link" : "attach a link to this item"}</label>
    <input type="text" class="link-pop__url" placeholder="a YouTube link plays inline; any other link opens on tap" value="${currentUrl}" />
    <p class="link-pop__err" hidden>that doesn't look like a link</p>
    ${hasExisting ? `
    <label class="link-pop__toggle">
      <input type="checkbox" class="link-pop__show" ${showThumbnail ? "checked" : ""} />
      show its ${current.kind === "link" ? "page icon" : "thumbnail"} over the item
    </label>
    <label class="link-pop__op" style="display:${showThumbnail ? "flex" : "none"};">
      <span>preview opacity</span>
      <input type="range" min="10" max="100" value="${Math.round(thumbnailOpacity * 100)}" class="link-pop__thumbop" />
    </label>` : ""}
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
  const showCheckbox = pop.querySelector(".link-pop__show");
  const opRow = pop.querySelector(".link-pop__op");
  const opInput = pop.querySelector(".link-pop__thumbop");
  input.focus();

  showCheckbox?.addEventListener("change", () => {
    if (opRow) opRow.style.display = showCheckbox.checked ? "flex" : "none";
  });

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
    const showThumb = showCheckbox ? showCheckbox.checked : false;
    const thumbOp = opInput ? Number(opInput.value) / 100 : 1;
    const embed =
      link.kind === "youtube"
        ? { kind: "youtube", videoId: link.videoId, title: link.title, thumbnailUrl: link.thumbnailUrl, showThumbnail: showThumb, thumbnailOpacity: thumbOp }
        : { kind: "link", url: link.url, title: link.title || link.domain, domain: link.domain, faviconUrl: link.faviconUrl, showThumbnail: showThumb, thumbnailOpacity: thumbOp };
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
