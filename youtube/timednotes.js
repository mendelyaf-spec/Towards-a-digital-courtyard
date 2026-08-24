// youtube/timednotes.js — notes pinned to moments in a video.
//
// Write a note at 2:14 and it surfaces when playback reaches 2:14, in this
// app rather than on youtube.com — so the thought stays with your mosaic
// instead of going off to live in someone else's comment section. Every
// note for a video is also listable in one place, each one a way back to
// its own moment.
//
// Two halves, deliberately separated so the thinking part is testable
// without a network:
//   - fireCrossings() is pure: given where playback was, where it is now,
//     and the notes, it says which notes just came due. All the awkward
//     cases (seeking backward, jumping forward past several notes, a note
//     exactly on the boundary) are decided here.
//   - YouTubePlayer wraps YouTube's IFrame Player API, which is the only
//     way to know a video's current time from outside it. That half needs
//     youtube.com reachable, which is no extra requirement — without it
//     there is no video to annotate in the first place.

const API_SRC = "https://www.youtube.com/iframe_api";
let apiLoading = null;

/** Load YouTube's IFrame Player API once; resolves with window.YT. */
function loadPlayerApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiLoading) return apiLoading;
  apiLoading = new Promise((resolve, reject) => {
    // The API calls this global when it's ready — chain rather than
    // clobber, in case anything else ever wants the same hook.
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    const s = document.createElement("script");
    s.src = API_SRC;
    s.onerror = () => reject(new Error("Couldn't reach YouTube's player"));
    document.head.appendChild(s);
    // Don't hang forever if the script loads but never calls back.
    setTimeout(() => (window.YT?.Player ? resolve(window.YT) : reject(new Error("YouTube's player didn't start"))), 12000);
  });
  return apiLoading;
}

/**
 * Which notes fall due moving from `prev` to `now` (seconds).
 *
 * Forward: every note in (prev, now] — so jumping forward over several
 * still surfaces all of them rather than silently skipping.
 * Backward (a seek): nothing fires; the caller just resyncs, which is what
 * re-arms those notes for the next pass.
 * A first tick (prev == null) fires nothing — starting a video shouldn't
 * dump every note at 0s on you.
 */
export function fireCrossings(prev, now, notes) {
  if (prev == null || now < prev) return [];
  return notes.filter((n) => n.t > prev && n.t <= now).sort((a, b) => a.t - b.t);
}

/** 137.4 -> "2:17"; 3742 -> "1:02:22" */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

/** "2:17" / "1:02:22" / "137" -> seconds, or null if it isn't a time. */
export function parseTime(str) {
  const parts = String(str).trim().split(":");
  if (!parts.length || parts.some((p) => p === "" || !/^\d+$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

const TICK_MS = 250; // fine enough that a note lands on its moment, cheap enough to ignore

/**
 * Wraps one playing video. `onTick(seconds)` fires while it plays.
 * Every method is safe to call before the player is ready or after
 * destroy(), so callers never have to track that themselves.
 */
export class YouTubePlayer {
  constructor(iframe, { onTick, onReady, onError } = {}) {
    this.iframe = iframe;
    this.onTick = onTick;
    this.player = null;
    this.dead = false;
    this._timer = null;

    loadPlayerApi()
      .then((YT) => {
        if (this.dead) return;
        this.player = new YT.Player(iframe, {
          events: {
            onReady: () => {
              if (this.dead) return;
              this._start();
              onReady?.();
            },
          },
        });
      })
      .catch((err) => {
        // No player API — the video still plays in its plain iframe, it
        // just can't report where it is, so timed notes stay dormant
        // rather than the whole card breaking.
        console.warn("Timed notes unavailable for this video.", err);
        onError?.(err);
      });
  }

  _start() {
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (this.dead || !this.player?.getCurrentTime) return;
      let t;
      try {
        t = this.player.getCurrentTime();
      } catch {
        return; // player torn down mid-tick
      }
      if (typeof t === "number" && !Number.isNaN(t)) this.onTick?.(t);
    }, TICK_MS);
  }

  currentTime() {
    try {
      const t = this.player?.getCurrentTime?.();
      return typeof t === "number" && !Number.isNaN(t) ? t : null;
    } catch {
      return null;
    }
  }

  seekTo(seconds) {
    try {
      this.player?.seekTo?.(seconds, true);
      this.player?.playVideo?.();
    } catch {
      /* not ready yet — the caller's UI already reflects the intent */
    }
  }

  destroy() {
    this.dead = true;
    clearInterval(this._timer);
    this._timer = null;
    try {
      this.player?.destroy?.();
    } catch {
      /* already gone */
    }
    this.player = null;
  }
}
