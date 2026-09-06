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
const REQUESTS_KEY = "dc:courtyard-requests";

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

/** Every canvas the two of them will need to keep agreeing on, going
 *  forward — for now, how many members it can ever hold and how long it
 *  stays live before it's considered ended. Set once, at creation (either
 *  from an invite, with the defaults below, or from an accepted
 *  courtyard request, which lets both sides propose their own values —
 *  see createCourtyardRequest/acceptCourtyardRequest). durationHours null
 *  means no end date. */
export function createCourtyard(userA, canvasA, userB, canvasB, rules = {}) {
  const maxMembers = rules.maxMembers || 2;
  const durationHours = rules.durationHours || null;
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
    maxMembers,
    durationHours,
    expiresAt: durationHours ? Date.now() + durationHours * 60 * 60 * 1000 : null,
  };
  return saveCourtyard(courtyard);
}

/** A human read of the agreed duration — shared by the propose-courtyard
 *  popover, the pending-requests list on home, and the courtyard's own
 *  rules panel, so all three describe the same hours the same way. */
export function describeDuration(hours) {
  if (!hours) return "no end date";
  if (hours % (24 * 30) === 0) { const n = hours / (24 * 30); return `${n} month${n === 1 ? "" : "s"}`; }
  if (hours % (24 * 7) === 0) { const n = hours / (24 * 7); return `${n} week${n === 1 ? "" : "s"}`; }
  if (hours % 24 === 0) { const n = hours / 24; return `${n} day${n === 1 ? "" : "s"}`; }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The courtyard a canvas is already one half of, if any — a canvas can
 *  only ever be in one at a time, given the two-member shape above. Used
 *  to keep a mosaic from being proposed (or offered) into a second one. */
export function canvasCourtyard(canvasId) {
  return listCourtyards().find((c) => c.members.some((m) => m.canvasId === canvasId)) || null;
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

// ---------- courtyard requests (born from the feed) ----------
// The other way two mosaics become a courtyard: you're browsing someone
// else's published mosaic in the feed, it overlaps with one of yours, and
// rather than trading a link out of band you send a request straight from
// there — see scripts/courtyardRequest.js's popover. Accepting builds the
// courtyard exactly like consumeInvite does above, just with the rules
// whoever proposed it picked, and no link ever changes hands.
//
// Single device, same simplification as invites: there's one profile
// here, so accepting your own outgoing request is how you see what it
// creates, same as opening your own invite link does above.
function readRequests() {
  return readJSON(REQUESTS_KEY, []);
}
function writeRequests(list) {
  writeJSON(REQUESTS_KEY, list);
}

/** Every request still waiting on a decision — home.js lists these with
 *  accept/decline either way (see the note above on single-device). */
export function listCourtyardRequests() {
  return readRequests().filter((r) => r.status === "pending");
}

/** Propose merging `fromCanvasId` (one of your own) with `toCanvasId`
 *  (whatever published mosaic you were browsing) into a shared courtyard.
 *  Names are captured now rather than looked up later, so a rename or a
 *  deleted canvas doesn't leave the request unreadable in the meantime. */
export function createCourtyardRequest(fromCanvasId, fromCanvas, toCanvasId, toCanvas, rules) {
  const me = getMe();
  const list = readRequests();
  const req = {
    id: newId(),
    fromCanvasId, fromCanvasName: fromCanvas.name,
    toCanvasId, toCanvasName: toCanvas.name,
    from: { id: me.id, name: me.name, icon: me.icon },
    rules: { maxMembers: rules.maxMembers || 2, durationHours: rules.durationHours || null },
    status: "pending",
    createdAt: Date.now(),
  };
  list.push(req);
  writeRequests(list);
  return req;
}

/** Accept: build the courtyard from both canvases with the proposed
 *  rules, then the request's job is done. */
export function acceptCourtyardRequest(id) {
  const list = readRequests();
  const req = list.find((r) => r.id === id);
  if (!req) return { error: "That request no longer exists." };
  const me = getMe();
  const courtyard = createCourtyard(req.from, req.fromCanvasId, me, req.toCanvasId, req.rules);
  writeRequests(list.filter((r) => r.id !== id));
  return { courtyard };
}

/** Decline (by the recipient) or cancel (by whoever sent it) — same
 *  operation either way, since there's nothing left to keep once a
 *  request isn't going anywhere. */
export function removeCourtyardRequest(id) {
  writeRequests(readRequests().filter((r) => r.id !== id));
}

/** Deleting a canvas shouldn't leave a request for it stranded on the
 *  home page forever — called from home.js's own delete handler. */
export function purgeCourtyardRequestsForCanvas(canvasId) {
  writeRequests(readRequests().filter((r) => r.fromCanvasId !== canvasId && r.toCanvasId !== canvasId));
}
