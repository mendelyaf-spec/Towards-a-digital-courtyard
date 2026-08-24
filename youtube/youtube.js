// youtube/youtube.js — YouTube-specific helpers: recognize a link, get its
// thumbnail/title, build an embeddable URL. No API key needed.
//
// This module only handles YouTube. The generic "paste any link" flow (the
// pocket's + add link, and the toolbar's link button) lives in links/ and
// hands off to these helpers when it recognizes a YouTube URL — everything
// else becomes a plain link card, since most other sites block being
// embedded in an iframe at all.

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
export function youtubeEmbedUrl(videoId, { autoplay = false, jsApi = false } = {}) {
  // enablejsapi=1 is what lets the IFrame Player API attach to this frame
  // and report playback position — the basis of timed notes. origin= is
  // required alongside it, and harmless otherwise.
  const params = [
    "rel=0",
    autoplay ? "autoplay=1" : "",
    jsApi ? `enablejsapi=1&origin=${encodeURIComponent(location.origin)}` : "",
  ].filter(Boolean);
  return `https://www.youtube.com/embed/${videoId}?${params.join("&")}`;
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
