// focus/focus.js — session planning: how long you're limited to your
// homepage, how long you'll have in the courtyard, how long in the feed —
// declared ahead of time, for right now or for a session scheduled later.
//
// IMPORTANT SCOPE NOTE, up front: this can only govern navigation inside
// THIS app (between its own home / courtyard / feed). A web page cannot
// block other browser tabs, other apps, or anything at the OS level the
// way a dedicated blocker (e.g. Freedom) can — there is no such API to
// call. What's built here is the in-app half of that idea: the courtyard
// and feed simply don't open (routes bounce back to home) while they're
// outside your declared window.
//
// The three phases run back to back from a plan's start time: home-only
// first (courtyard/feed both closed), then a courtyard window (home stays
// open throughout — see zoneAllowed below), then a feed window (fully
// open — "when in the feed, you can always go back to a courtyard or home
// page"). Once every phase of every declared plan has elapsed, the
// resting state is home-only again, same as a fresh home phase, until the
// next session is declared or its start time arrives. A device that has
// never declared a single plan is left fully open — this only starts
// restricting anything once you actually opt in by planning a session.
//
// Paths (see getPath/setPath) are the alternative to blocking: a
// configured walk between two areas replaces the lock check for that pair
// entirely — see main.js's use of both together.

const PLANS_KEY = "dc:session-plans";
const PATHS_KEY = "dc:paths";

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full/unavailable — still works in-session */
  }
}

// ---------- session plans ----------
export function listPlans() {
  return readJSON(PLANS_KEY, []).slice().sort((a, b) => a.startAt - b.startAt);
}

/** Declare a session: three durations (minutes; 0 skips that phase
 *  entirely) run back to back starting at `startAt` (default: now). */
export function addPlan({ startAt = Date.now(), homeMinutes = 0, courtyardMinutes = 0, feedMinutes = 0 }) {
  const list = readJSON(PLANS_KEY, []);
  const plan = {
    id: newId(),
    startAt,
    homeMinutes: Math.max(0, homeMinutes),
    courtyardMinutes: Math.max(0, courtyardMinutes),
    feedMinutes: Math.max(0, feedMinutes),
  };
  list.push(plan);
  writeJSON(PLANS_KEY, list);
  return plan;
}

export function removePlan(id) {
  writeJSON(PLANS_KEY, readJSON(PLANS_KEY, []).filter((p) => p.id !== id));
}

function phaseEnds(p) {
  const homeEnd = p.startAt + p.homeMinutes * 60000;
  const courtyardEnd = homeEnd + p.courtyardMinutes * 60000;
  const feedEnd = courtyardEnd + p.feedMinutes * 60000;
  return { homeEnd, courtyardEnd, feedEnd };
}

/** The plan actually governing right now, if any: already started, and
 *  not fully elapsed yet. A future plan whose startAt hasn't arrived
 *  doesn't apply yet — the resting state (see zoneAllowed) covers the gap. */
export function activePlan(now = Date.now()) {
  let best = null;
  for (const p of readJSON(PLANS_KEY, [])) {
    if (p.startAt > now) continue;
    if (now >= phaseEnds(p).feedEnd) continue;
    if (!best || p.startAt > best.startAt) best = p;
  }
  return best;
}

/** Which phase of `plan` `now` falls in — 'home' | 'courtyard' | 'feed' —
 *  or null once every phase of it has elapsed (or it hasn't started). */
export function currentPhase(plan, now = Date.now()) {
  if (!plan || now < plan.startAt) return null;
  const { homeEnd, courtyardEnd, feedEnd } = phaseEnds(plan);
  if (now < homeEnd) return "home";
  if (now < courtyardEnd) return "courtyard";
  if (now < feedEnd) return "feed";
  return null;
}

/** Has a session ever been declared at all? Until it has, nothing here
 *  restricts anything — see the module doc comment. */
export function everPlanned() {
  return readJSON(PLANS_KEY, []).length > 0;
}

/** Is `zone` ("home" | "courtyard" | "feed") reachable right now, ignoring
 *  any configured path (see getPath) — main.js checks paths first, since
 *  a path REPLACES this check for that pair, it doesn't add to it. */
export function zoneAllowed(zone, now = Date.now()) {
  if (!everPlanned()) return true;
  const phase = currentPhase(activePlan(now), now);
  if (!phase || phase === "home") return zone === "home";
  if (phase === "courtyard") return zone === "home" || zone === "courtyard";
  return true; // feed phase: fully open
}

/** Milliseconds until `zone` opens up on its own (no path involved), or 0
 *  if it's already open. Null if there's nothing scheduled to count down
 *  to — the resting state just waits on the next declared plan. */
export function timeUntilZone(zone, now = Date.now()) {
  if (zoneAllowed(zone, now)) return 0;
  const plan = activePlan(now);
  if (!plan) return null;
  const { homeEnd, courtyardEnd } = phaseEnds(plan);
  if (zone === "courtyard") return Math.max(0, homeEnd - now);
  if (zone === "feed") return Math.max(0, courtyardEnd - now);
  return 0;
}

/** A short status for the persistent banner — null while nothing's ever
 *  been declared, so the banner stays out of the way until you opt in. */
export function focusStatus(now = Date.now()) {
  if (!everPlanned()) return null;
  const plan = activePlan(now);
  const phase = currentPhase(plan, now);
  if (!phase) return { phase: "resting" };
  const { homeEnd, courtyardEnd, feedEnd } = phaseEnds(plan);
  const endsAt = phase === "home" ? homeEnd : phase === "courtyard" ? courtyardEnd : feedEnd;
  return { phase, remainingMs: Math.max(0, endsAt - now) };
}

export function describeCountdown(ms) {
  if (ms == null) return "";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// ---------- paths: the alternative to blocking ----------
// One shared duration + scenery per unordered pair of areas — the
// distance between two places doesn't depend on which way you're walking
// it. main.js only ever consults these for a trip whose DESTINATION isn't
// home: home stays instantly reachable no matter what, same as it's never
// blocked above.
export function pairKey(a, b) {
  return [a, b].sort().join("-");
}

export function getPath(a, b) {
  return readJSON(PATHS_KEY, {})[pairKey(a, b)] || null;
}

export function setPath(a, b, { minutes, scenery, videoOverride }) {
  const all = readJSON(PATHS_KEY, {});
  all[pairKey(a, b)] = {
    minutes: Math.max(0, minutes || 0),
    scenery: scenery || null,
    // A specific video source to play directly instead of the page above
    // (see classifyVideoUrl / focusUI.js's openPathForm) — set only when
    // the page itself isn't already one (resolveLink's own YouTube
    // detection covers that case with no override needed at all).
    videoOverride: videoOverride || null,
  };
  writeJSON(PATHS_KEY, all);
}

export function clearPath(a, b) {
  const all = readJSON(PATHS_KEY, {});
  delete all[pairKey(a, b)];
  writeJSON(PATHS_KEY, all);
}

export function listPaths() {
  const all = readJSON(PATHS_KEY, {});
  return Object.entries(all).map(([key, v]) => ({ key, ...v }));
}

// ---------- "pull just the video out" ----------
// A cross-origin page's DOM is invisible to our own JS (same-origin
// policy) — there's no such thing as an element selector reaching into
// someone else's site, however precise. The one thing that DOES survive
// that wall is loading a plain URL fresh: a direct video file, or a
// platform's own embed URL (YouTube — resolveLink already special-cases
// that one — or Vimeo). Kept separate from resolveLink (links.js), not
// merged into it, so recognizing a Vimeo/video-file link only changes
// what a WALK does with it — item embeds, hint photos, and the Pocket's
// own "add link" all keep behaving exactly as they already do.
const VIMEO_RE = /vimeo\.com\/(?:video\/)?(\d+)/i;
const VIDEO_FILE_RE = /\.(mp4|webm|ogg|ogv|mov|m4v)(?:[?#]|$)/i;

/** @returns {{kind:'vimeo', videoId, url} | {kind:'video', url} | null} */
export function classifyVideoUrl(url) {
  if (!url) return null;
  const vimeo = url.match(VIMEO_RE);
  if (vimeo) return { kind: "vimeo", videoId: vimeo[1], url };
  if (VIDEO_FILE_RE.test(url)) return { kind: "video", url };
  return null;
}
