// courtyardcreationlogic.js
//
// Everything about CREATING a courtyard — the shared page where two people's
// canvases meet around a central void.
//
// A courtyard has:
//   - a void in the middle (default shape) that holds the shared interactions
//     (events / pending requests / rules) — neither member can place content there;
//   - two members, each with a chosen icon, the canvas their icon opens, an
//     overall zone size, and the preview items they arrange in their half.
//
// Invites: one member mints a private, one-time link. Consuming it brings both
// canvases together into a courtyard named "[A–B Courtyard]" by default.
//
// Storage is local for now (single device = working demo). The same shape is
// meant to move to a shared backend so the two members can be on two phones —
// only the read/write helpers here need to change for that.

import { newId, getMe } from "./scripts/store.js";

const COURTYARDS_KEY = "dc:courtyards";
const INVITES_KEY = "dc:invites";

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
    /* ignore */
  }
}

// ---------- courtyards ----------
export function listCourtyards() {
  return readJSON(COURTYARDS_KEY, []);
}
export function getCourtyard(id) {
  return listCourtyards().find((c) => c.id === id);
}
function saveCourtyards(list) {
  writeJSON(COURTYARDS_KEY, list);
}
export function saveCourtyard(courtyard) {
  const list = listCourtyards();
  const i = list.findIndex((c) => c.id === courtyard.id);
  if (i === -1) list.push(courtyard);
  else list[i] = courtyard;
  saveCourtyards(list);
  return courtyard;
}

export function defaultCourtyardName(nameA, nameB) {
  return `${nameA}–${nameB} Courtyard`;
}

// A member's half: their icon, the canvas it opens, how big their zone is,
// and the preview items they've arranged (placeholder list for now).
function memberZone(user, canvasId) {
  return {
    userId: user.id,
    name: user.name,
    icon: user.icon || "🌿",
    canvasId: canvasId || null,
    zone: { size: 1, items: [] },
  };
}

export function createCourtyard(userA, canvasA, userB, canvasB) {
  const courtyard = {
    id: newId(),
    name: defaultCourtyardName(userA.name, userB.name),
    createdAt: Date.now(),
    void: { shape: "circle" }, // default void shape
    members: [memberZone(userA, canvasA), memberZone(userB, canvasB)],
    // Shared, void-only interactions — placeholders, each handled in its folder.
    events: [],
    pending: [],
    rules: [],
  };
  return saveCourtyard(courtyard);
}

// ---------- invites (private, one-time link) ----------
export function createInvite(canvasId) {
  const me = getMe();
  const token = newId() + newId(); // hard to guess
  const invites = readJSON(INVITES_KEY, {});
  invites[token] = {
    token,
    from: { id: me.id, name: me.name, icon: me.icon },
    canvasId: canvasId || null,
    createdAt: Date.now(),
    used: false,
  };
  writeJSON(INVITES_KEY, invites);
  const base = location.origin + location.pathname;
  return { token, url: `${base}#/join/${token}` };
}

export function peekInvite(token) {
  return readJSON(INVITES_KEY, {})[token] || null;
}

// Consume a one-time invite: mark it used and build the courtyard joining the
// inviter (A) and the joiner — me — (B), each with their chosen canvas.
export function consumeInvite(token, joinerCanvasId) {
  const invites = readJSON(INVITES_KEY, {});
  const inv = invites[token];
  if (!inv) return { error: "This invite link is invalid." };
  if (inv.used) return { error: "This invite link has already been used." };

  const me = getMe();
  inv.used = true;
  writeJSON(INVITES_KEY, invites);

  const courtyard = createCourtyard(
    inv.from,
    inv.canvasId,
    { id: me.id, name: me.name, icon: me.icon },
    joinerCanvasId
  );
  return { courtyard };
}
