// store.js — the courtyard's memory.
// Holds every item placed on the canvas and persists it to localStorage,
// so the space is still there when you wander back in.

const KEY = "digital-courtyard:v1";

/** @typedef {{
 *   id:string, type:'rect'|'circle'|'image'|'text',
 *   x:number, y:number, w:number, h:number,
 *   src?:string,                                  // image cut-out
 *   text?:string, color?:string,                  // text item
 *   strokes?:{color:string,points:[number,number][]}[], // ink drawn on the item
 *   parentId?:string, expanded?:boolean           // attached-note grouping
 * }} Item */

/** @type {Item[]} */
export const items = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

let saveTimer = null;
export function save() {
  // Debounced so dragging/resizing doesn't thrash storage.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch {
      /* storage full or unavailable — the canvas still works in-session */
    }
  }, 250);
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

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
