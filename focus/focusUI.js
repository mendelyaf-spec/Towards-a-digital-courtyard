// focus/focusUI.js — the visible half of focus.js: the persistent status
// banner (every view), the "plan your session" panel on the home page, and
// the full-screen walk interstitial for a configured path.

import {
  listPlans, addPlan, removePlan, currentPhase, focusStatus, describeCountdown,
  getPath, setPath, clearPath,
} from "./focus.js";
import { resolveLink } from "../links/links.js";

const ZONE_LABEL = { home: "home", courtyard: "courtyard", feed: "feed" };
const PAIRS = [["home", "courtyard"], ["home", "feed"], ["courtyard", "feed"]];

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- persistent status banner ----------
/**
 * @param {HTMLElement} el
 * @param {{ onPhaseChange?: (status) => void }} opts — fired whenever the
 *   phase actually changes (including the first tick), so main.js can
 *   refresh whatever's currently showing (e.g. re-render home so a tile
 *   that just unlocked stops looking locked).
 * @returns {() => void} stop the ticker
 */
export function mountFocusBanner(el, { onPhaseChange } = {}) {
  let lastPhase;
  function tick() {
    const status = focusStatus();
    if (!status) {
      el.hidden = true;
      lastPhase = undefined;
      return;
    }
    el.hidden = false;
    el.innerHTML = bannerHTML(status);
    if (status.phase !== lastPhase) {
      lastPhase = status.phase;
      onPhaseChange?.(status);
    }
  }
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

function bannerHTML(status) {
  if (status.phase === "resting") {
    return `⏳ no session running — <a href="#/">plan your next one</a>`;
  }
  const icon = status.phase === "home" ? "🏠" : status.phase === "courtyard" ? "🏛" : "📰";
  const next = status.phase === "home" ? "courtyard opens" : status.phase === "courtyard" ? "feed opens" : "session ends";
  return `${icon} ${ZONE_LABEL[status.phase]} phase — ${next} in ${describeCountdown(status.remainingMs)}`;
}

/** A brief toast when a route bounces you back — e.g. tapping the feed
 *  link while you're still in a home-only phase. */
export function showBlockedToast(zone, waitMs) {
  const el = document.createElement("div");
  el.className = "focus-toast";
  const eta = waitMs == null ? "" : ` — opens in ${describeCountdown(waitMs)}`;
  el.textContent = `🔒 ${ZONE_LABEL[zone]} isn't open right now${eta}.`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add("is-shown"));
  setTimeout(() => {
    el.classList.remove("is-shown");
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ---------- the "plan your session" panel (mounted on the home page) ----------
/**
 * @param {HTMLElement} container
 * @param {() => void} [onChange] — called after a plan or path is added,
 *   removed, or changed, so the caller can refresh anything elsewhere on
 *   the page that depends on it (home.js re-renders the whole page, which
 *   is what actually updates the locked/unlocked look of the feed link
 *   and the courtyard tiles — this panel only redraws its own list).
 */
export function renderPlanner(container, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "focus-planner";
  wrap.innerHTML = `
    <div class="focus-planner__form">
      <label class="focus-planner__field">
        <span>🏠 home only</span>
        <input type="number" min="0" class="fp-home" value="0" />
      </label>
      <label class="focus-planner__field">
        <span>🏛 courtyard</span>
        <input type="number" min="0" class="fp-courtyard" value="0" />
      </label>
      <label class="focus-planner__field">
        <span>📰 feed</span>
        <input type="number" min="0" class="fp-feed" value="0" />
      </label>
      <label class="focus-planner__field focus-planner__field--when">
        <span>starts</span>
        <input type="datetime-local" class="fp-start" />
      </label>
      <button type="button" class="focus-planner__add">+ declare this session</button>
    </div>
    <p class="focus-planner__hint">Minutes, back to back from the start time (blank = right away): home-only first, then the courtyard opens (home stays reachable), then the feed opens (everything does). Leave "starts" blank to begin now, or pick a time to schedule it ahead — add as many of these as you like.</p>
    <div class="focus-planner__list"></div>`;
  container.append(wrap);

  const list = wrap.querySelector(".focus-planner__list");
  function renderList() {
    list.replaceChildren();
    const now = Date.now();
    const plans = listPlans();
    for (const p of plans) {
      const row = document.createElement("div");
      row.className = "focus-plan-row";
      const phase = currentPhase(p, now);
      const status = p.startAt > now
        ? `starts ${new Date(p.startAt).toLocaleString()}`
        : phase
          ? `active — ${phase} phase`
          : "finished";
      row.innerHTML = `
        <span class="focus-plan-row__text">🏠${p.homeMinutes} · 🏛${p.courtyardMinutes} · 📰${p.feedMinutes} min <em>(${escapeHtml(status)})</em></span>
        <button type="button" class="focus-plan-row__remove" title="Cancel this session">✕</button>`;
      row.querySelector(".focus-plan-row__remove").addEventListener("click", () => {
        removePlan(p.id);
        renderList();
        onChange?.();
      });
      list.append(row);
    }
    if (!plans.length) {
      const empty = document.createElement("p");
      empty.className = "focus-planner__empty";
      empty.textContent = "Nothing declared yet — the courtyard and feed are wide open until you plan a session.";
      list.append(empty);
    }
  }
  renderList();

  wrap.querySelector(".focus-planner__add").addEventListener("click", () => {
    const homeMinutes = Number(wrap.querySelector(".fp-home").value) || 0;
    const courtyardMinutes = Number(wrap.querySelector(".fp-courtyard").value) || 0;
    const feedMinutes = Number(wrap.querySelector(".fp-feed").value) || 0;
    if (!homeMinutes && !courtyardMinutes && !feedMinutes) {
      alert("Declare at least one duration.");
      return;
    }
    const whenVal = wrap.querySelector(".fp-start").value;
    const startAt = whenVal ? new Date(whenVal).getTime() : Date.now();
    addPlan({ startAt, homeMinutes, courtyardMinutes, feedMinutes });
    wrap.querySelector(".fp-home").value = "0";
    wrap.querySelector(".fp-courtyard").value = "0";
    wrap.querySelector(".fp-feed").value = "0";
    wrap.querySelector(".fp-start").value = "";
    renderList();
    onChange?.();
  });

  // ---------- paths: the alternative to blocking ----------
  const pathsWrap = document.createElement("div");
  pathsWrap.className = "focus-paths";
  pathsWrap.innerHTML = `<h3 class="focus-paths__title">walking paths <span class="focus-paths__hint">— set one and getting there takes this long, with this scenery, instead of a hard wait</span></h3>`;
  for (const [a, b] of PAIRS) pathsWrap.append(renderPathRow(a, b));
  container.append(pathsWrap);
}

function renderPathRow(a, b) {
  const row = document.createElement("div");
  row.className = "focus-path-row";
  const refresh = () => {
    const path = getPath(a, b);
    row.replaceChildren();
    const label = document.createElement("span");
    label.className = "focus-path-row__label";
    label.textContent = `${ZONE_LABEL[a]} ↔ ${ZONE_LABEL[b]}`;
    row.append(label);
    if (path) {
      const info = document.createElement("span");
      info.className = "focus-path-row__info";
      const sceneryLabel = path.scenery?.title || path.scenery?.domain || path.scenery?.url || "no scenery set";
      info.textContent = `${path.minutes} min · ${sceneryLabel}`;
      const clear = document.createElement("button");
      clear.type = "button"; clear.className = "focus-path-row__clear"; clear.textContent = "✕ clear";
      clear.addEventListener("click", () => { clearPath(a, b); refresh(); });
      row.append(info, clear);
    } else {
      const setBtn = document.createElement("button");
      setBtn.type = "button"; setBtn.className = "focus-path-row__set"; setBtn.textContent = "+ set a path";
      setBtn.addEventListener("click", () => openPathForm(row, a, b, refresh));
      row.append(setBtn);
    }
  };
  refresh();
  return row;
}

function openPathForm(row, a, b, onDone) {
  const form = document.createElement("div");
  form.className = "focus-path-form";
  form.innerHTML = `
    <input type="number" min="1" class="focus-path-form__minutes" placeholder="minutes" value="7" />
    <input type="text" class="focus-path-form__url" placeholder="paste a video or PDF link — the scenery for this walk" />
    <button type="button" class="focus-path-form__save">save</button>
    <button type="button" class="focus-path-form__cancel">cancel</button>
    <p class="focus-path-form__err" hidden>that doesn't look like a link</p>`;
  row.replaceChildren(form);
  form.querySelector(".focus-path-form__cancel").addEventListener("click", onDone);
  form.querySelector(".focus-path-form__save").addEventListener("click", async () => {
    const minutes = Math.max(1, Number(form.querySelector(".focus-path-form__minutes").value) || 7);
    const scenery = await resolveLink(form.querySelector(".focus-path-form__url").value);
    if (!scenery) {
      form.querySelector(".focus-path-form__err").hidden = false;
      return;
    }
    setPath(a, b, { minutes, scenery });
    onDone();
  });
}

// ---------- the walk itself: a full-screen interstitial ----------
let walkTimer = null;

/**
 * @param {"home"|"courtyard"|"feed"} fromZone
 * @param {"home"|"courtyard"|"feed"} toZone
 * @param {{minutes:number, scenery:object|null}} path
 * @param {{onComplete:()=>void, onCancel:()=>void}} handlers
 */
export function openWalk(fromZone, toZone, path, { onComplete, onCancel }) {
  const el = document.getElementById("focusWalk");
  const label = document.getElementById("focusWalkLabel");
  const scenery = document.getElementById("focusWalkScenery");
  const countdown = document.getElementById("focusWalkCountdown");
  const cancelBtn = document.getElementById("focusWalkCancel");
  if (!el) { onComplete?.(); return; } // defensive: never strand a navigation on a missing overlay

  label.textContent = `walking from ${ZONE_LABEL[fromZone]} to ${ZONE_LABEL[toZone]} — ${path.minutes} min`;
  scenery.innerHTML = sceneryHTML(path.scenery);

  const totalMs = Math.max(0, path.minutes) * 60000;
  const startedAt = Date.now();
  el.hidden = false;

  const stop = () => {
    clearInterval(walkTimer);
    walkTimer = null;
    el.hidden = true;
    cancelBtn.onclick = null;
    scenery.innerHTML = "";
  };
  cancelBtn.onclick = () => { stop(); onCancel?.(); };

  const tick = () => {
    const left = totalMs - (Date.now() - startedAt);
    if (left <= 0) { stop(); onComplete?.(); return; }
    countdown.textContent = describeCountdown(left) + " left";
  };
  tick();
  walkTimer = setInterval(tick, 250);
}

// Scenery is contained the same way every other embed in this app is (see
// browser/browser.js's own note on this): sandboxed with no allow-popups
// and no allow-top-navigation, so nothing on the framed page can pop a
// real tab or hijack this one out from under a walk — you can only ever
// end up back here, at your actual destination, once the clock runs out.
const SCENERY_SANDBOX = "allow-scripts allow-same-origin allow-forms";

function sceneryHTML(scenery) {
  if (!scenery) return `<p class="focus-walk__none">(no scenery set for this path — see the planner on your home page)</p>`;
  if (scenery.kind === "youtube") {
    return `<iframe class="focus-walk__frame" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(scenery.videoId)}?autoplay=1" allow="autoplay; encrypted-media" allowfullscreen title="scenery" sandbox="allow-scripts allow-same-origin"></iframe>`;
  }
  // Any other link (a PDF included): most whole websites refuse to be
  // framed at all (see links.js's own note on this), so a way to just
  // open it stays right below the attempt rather than leaving a blank
  // frame as the only option — the one deliberate, visible way out,
  // same as the in-app browser's own "open in new tab". Scenery is
  // passing-by, not something to browse — the shield (same idea as the
  // in-app browser's own, see browser/browser.js) keeps it look-only, so
  // nothing on the page can be clicked or typed into during the walk.
  return `
    <div class="focus-walk__frame-wrap">
      <iframe class="focus-walk__frame" src="${scenery.url}" title="scenery" tabindex="-1" sandbox="${SCENERY_SANDBOX}"></iframe>
      <div class="focus-walk__shield" aria-hidden="true"></div>
    </div>
    <a class="focus-walk__openlink" href="${scenery.url}" target="_blank" rel="noopener">↗ open "${escapeHtml(scenery.title || scenery.domain || scenery.url)}" in a new tab, if it didn't load above</a>`;
}
