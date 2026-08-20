// youtube/youtube.js — parse a pasted link, fetch its title, embed it.
//
// No API key: the video id comes from the URL itself, the thumbnail is
// YouTube's public img.youtube.com endpoint, and the title (best-effort,
// works offline-safe by just failing quietly) comes from YouTube's public
// oEmbed endpoint. Used by both the pocket ("save a link for later") and
// direct canvas placement ("embed it now").

/** Pulls an 11-character video id out of any common YouTube URL shape, or a bare id. */
export function parseYouTubeId(input) {
  const s = (input || "").trim();
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtube\.com\/live\/|youtu\.be\/)([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  if (/^[\w-]{11}$/.test(s)) return s; // a bare id, typed directly
  return null;
}

export function youtubeThumbnail(videoId) {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}
export function youtubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
export function youtubeEmbedUrl(videoId, { autoplay = false } = {}) {
  return `https://www.youtube.com/embed/${videoId}?rel=0${autoplay ? "&autoplay=1" : ""}`;
}

/** Best-effort title lookup — returns null (never throws) if offline or blocked. */
export async function fetchYouTubeTitle(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeWatchUrl(videoId))}&format=json`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch {
    return null;
  }
}

// ---------------- "paste a link" popover ----------------
let openPop = null;

/** @param {(videoId:string, url:string)=>void} onSubmit */
export function openYoutubePrompt(anchorEl, onSubmit) {
  closeYoutubePrompt();
  const pop = document.createElement("div");
  pop.className = "yt-pop";
  pop.innerHTML = `
    <label class="yt-pop__label">paste a YouTube link</label>
    <input type="text" class="yt-pop__url" placeholder="https://youtube.com/watch?v=…" />
    <p class="yt-pop__err" hidden>that doesn't look like a YouTube link</p>
    <div class="yt-pop__actions">
      <button type="button" class="yt-pop__cancel" data-act="cancel">cancel</button>
      <button type="button" class="yt-pop__add" data-act="add">add</button>
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

  const input = pop.querySelector(".yt-pop__url");
  const err = pop.querySelector(".yt-pop__err");
  input.focus();

  const submit = () => {
    const id = parseYouTubeId(input.value);
    if (!id) { err.hidden = false; return; }
    onSubmit(id, input.value.trim());
    closeYoutubePrompt();
  };
  pop.querySelector('[data-act="add"]').addEventListener("click", submit);
  pop.querySelector('[data-act="cancel"]').addEventListener("click", closeYoutubePrompt);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") closeYoutubePrompt();
  });

  const onOutside = (e) => {
    if (!pop.contains(e.target) && e.target !== anchorEl) closeYoutubePrompt();
  };
  setTimeout(() => document.addEventListener("pointerdown", onOutside), 0);
  openPop = { el: pop, cleanup: () => document.removeEventListener("pointerdown", onOutside) };
}

export function closeYoutubePrompt() {
  if (!openPop) return;
  openPop.cleanup();
  openPop.el.remove();
  openPop = null;
}
