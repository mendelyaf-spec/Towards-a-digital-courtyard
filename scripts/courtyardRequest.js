// courtyardRequest.js — "propose a shared courtyard" popover, opened from a
// mosaic you're browsing in the feed (see main.js's proposeCourtyard button,
// shown only there — you can't propose a courtyard around your own canvas).
// Mirrors links.js's own popovers (anchored to the button, built on the fly,
// closes on outside click or Escape) with its own small stylesheet entry
// (styles/main.css's .courtyard-pop) — this isn't about links, so it gets
// its own class rather than reaching into links.css for one that happens to
// look right.

import { listCanvases, getCanvas } from "./store.js";
import { canvasCourtyard, createCourtyardRequest } from "../courtyardcreationlogic.js";

let openPop = null;

// Fixed presets rather than a free-form number: "how long" is a rule the
// other side has to read and agree to at a glance, not a field to fuss over.
const DURATIONS = [
  { label: "1 day", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
  { label: "1 month", hours: 24 * 30 },
  { label: "no end date", hours: null },
];

/**
 * @param {HTMLElement} anchorEl — the "🤝 propose courtyard" button
 * @param {string} toCanvasId — the published mosaic being browsed
 * @param {() => void} onSent — called once the request is actually created
 */
export function openProposeCourtyard(anchorEl, toCanvasId, onSent) {
  closeProposeCourtyard();
  const toCanvas = getCanvas(toCanvasId);
  if (!toCanvas) return;

  // Your own canvases, minus this one (proposing it to itself makes no
  // sense) and minus anything already spoken for by another courtyard —
  // see canvasCourtyard, and the two-member shape it's built around.
  const mine = listCanvases().filter((c) => c.id !== toCanvasId && !canvasCourtyard(c.id));
  if (!mine.length) {
    alert("Make another canvas first — a courtyard needs one of your own mosaics to bring into it.");
    return;
  }

  const pop = document.createElement("div");
  pop.className = "courtyard-pop";
  pop.innerHTML = `
    <label class="courtyard-pop__label">propose a shared courtyard with "${escapeHtml(toCanvas.name)}"</label>
    <label class="courtyard-pop__row">
      <span>bring in</span>
      <select class="courtyard-pop__canvas">
        ${mine.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
      </select>
    </label>
    <label class="courtyard-pop__row">
      <span>max members</span>
      <input type="number" class="courtyard-pop__max" min="2" max="20" value="2" />
    </label>
    <label class="courtyard-pop__row">
      <span>live for</span>
      <select class="courtyard-pop__duration">
        ${DURATIONS.map((d, i) => `<option value="${i}"${i === 1 ? " selected" : ""}>${d.label}</option>`).join("")}
      </select>
    </label>
    <p class="courtyard-pop__hint">If they accept, both mosaics open into a shared courtyard around a central void.</p>
    <div class="courtyard-pop__actions">
      <button type="button" class="courtyard-pop__cancel" data-act="cancel">cancel</button>
      <button type="button" class="courtyard-pop__send" data-act="send">send request</button>
    </div>`;
  document.body.appendChild(pop);

  const r = anchorEl.getBoundingClientRect();
  const popW = pop.offsetWidth || 260;
  const popH = pop.offsetHeight || 220;
  // Prefer opening below the anchor; flip above it if there isn't room,
  // then clamp fully on-screen either way — same as links.js's popovers.
  let top = r.bottom + 8;
  if (top + popH > window.innerHeight - 8) top = r.top - popH - 8;
  pop.style.left = Math.min(Math.max(r.left, 8), window.innerWidth - popW - 8) + "px";
  pop.style.top = Math.min(Math.max(top, 8), window.innerHeight - popH - 8) + "px";

  pop.querySelector('[data-act="cancel"]').addEventListener("click", closeProposeCourtyard);
  pop.querySelector('[data-act="send"]').addEventListener("click", () => {
    const fromCanvasId = pop.querySelector(".courtyard-pop__canvas").value;
    const fromCanvas = getCanvas(fromCanvasId);
    if (!fromCanvas) return closeProposeCourtyard();
    const maxMembers = Math.max(2, Number(pop.querySelector(".courtyard-pop__max").value) || 2);
    const durationHours = DURATIONS[Number(pop.querySelector(".courtyard-pop__duration").value)].hours;
    createCourtyardRequest(fromCanvasId, fromCanvas, toCanvasId, toCanvas, { maxMembers, durationHours });
    closeProposeCourtyard();
    onSent?.();
  });

  const onOutside = (e) => {
    if (!pop.contains(e.target) && e.target !== anchorEl) closeProposeCourtyard();
  };
  const onKey = (e) => { if (e.key === "Escape") closeProposeCourtyard(); };
  setTimeout(() => document.addEventListener("pointerdown", onOutside), 0);
  document.addEventListener("keydown", onKey);
  openPop = {
    el: pop,
    cleanup: () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("keydown", onKey);
    },
  };
}

export function closeProposeCourtyard() {
  if (!openPop) return;
  openPop.cleanup();
  openPop.el.remove();
  openPop = null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
