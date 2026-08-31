// store.js — the courtyard's memory.
//
// Multi-canvas: you can have many named canvases. A registry lists them;
// each canvas keeps its items (and, separately, its backgrounds) under its
// own key. One canvas is "active" at a time — the item layer reads/writes
// the active canvas through the live `items` binding below.

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const CANVASES_KEY = "dc:canvases";
const ME_KEY = "dc:me";
const itemsKey = (id) => `dc:canvas:${id}:items`;
export const canvasBgKey = (id) => `dc:canvas:${id}:bg`;

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

// ---------- canvas registry ----------
export function listCanvases() {
  return readJSON(CANVASES_KEY, []);
}
export function getCanvas(id) {
  return listCanvases().find((c) => c.id === id);
}
export function createCanvas(name) {
  const reg = listCanvases();
  const c = { id: newId(), name: name || `Canvas ${reg.length + 1}`, createdAt: Date.now() };
  reg.push(c);
  writeJSON(CANVASES_KEY, reg);
  writeJSON(itemsKey(c.id), []);
  return c;
}
export function renameCanvas(id, name) {
  const reg = listCanvases();
  const c = reg.find((x) => x.id === id);
  if (c) {
    c.name = name;
    writeJSON(CANVASES_KEY, reg);
  }
}
export function deleteCanvas(id) {
  writeJSON(CANVASES_KEY, listCanvases().filter((c) => c.id !== id));
  localStorage.removeItem(itemsKey(id));
  localStorage.removeItem(canvasBgKey(id));
}
/** Rewrite the registry to match `orderedIds` (as dragged on the home
 *  page). Anything missing from the list — shouldn't happen, but a stale
 *  id from a concurrent tab is cheap to guard against — keeps its old
 *  relative place at the end rather than silently disappearing. */
export function reorderCanvases(orderedIds) {
  const reg = listCanvases();
  const byId = new Map(reg.map((c) => [c.id, c]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  for (const c of reg) if (!orderedIds.includes(c.id)) ordered.push(c);
  writeJSON(CANVASES_KEY, ordered);
}

// ---------- active canvas (items) ----------
/** @type {any[]} live binding the item layer reads from */
export let items = [];
let activeId = null;

export function openCanvas(id) {
  activeId = id;
  items = readJSON(itemsKey(id), []);
  return items;
}
export function activeCanvasId() {
  return activeId;
}

let saveTimer = null;
export function save() {
  if (activeId == null) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJSON(itemsKey(activeId), items), 250);
}
export function addItem(item) {
  items.push(item);
  save();
  return item;
}
export function removeItem(id) {
  const i = items.findIndex((it) => it.id === id);
  if (i !== -1) {
    items.splice(i, 1);
    save();
  }
}

// ---------- profile ----------
export function getMe() {
  let me = readJSON(ME_KEY, null);
  if (!me) {
    me = { id: newId(), name: "You", icon: "🌿" };
    writeJSON(ME_KEY, me);
  }
  return me;
}
export function setMe(profile) {
  writeJSON(ME_KEY, profile);
  return profile;
}

// ---------- one-time migration from the old single-canvas app ----------
export function migrate() {
  if (listCanvases().length) return;
  const oldItems = readJSON("digital-courtyard:v1", null);
  const oldBg = readJSON("digital-courtyard:bg:v1", null);
  const c = createCanvas("My canvas");
  if (oldItems) writeJSON(itemsKey(c.id), oldItems);
  if (oldBg) writeJSON(canvasBgKey(c.id), oldBg);
}
