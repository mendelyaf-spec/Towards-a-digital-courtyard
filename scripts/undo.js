// undo.js — a simple whole-canvas undo stack.
//
// Deliberately coarse rather than a fine-grained command pattern: before any
// discrete edit (a move, a delete, a color change...), snapshot the entire
// item list; undo restores the most recent snapshot. This is simpler and far
// more robust than hand-writing an inverse for every kind of edit — every
// existing and future mutation is covered automatically, since undo only
// ever asks "what did the canvas look like a moment ago," not "how do I
// reverse THIS specific operation."

import { items, save } from "./store.js";

const MAX_DEPTH = 50;
let stack = [];

/** hook: () -> void, fired whenever the stack changes — lets the undo button's disabled state stay in sync without threading a callback through every call site. */
export let onChange = null;
export function setUndoChangeListener(fn) {
  onChange = fn;
}

/** Call once when switching to a different canvas — undo history doesn't cross canvases. */
export function resetUndo() {
  stack = [];
  onChange?.();
}

/** Call once at the START of a discrete edit gesture (a drag, a slider drag, a click action). */
export function pushUndoSnapshot() {
  stack.push(JSON.stringify(items));
  if (stack.length > MAX_DEPTH) stack.shift();
  onChange?.();
}

export function canUndo() {
  return stack.length > 0;
}

/** Restores the most recent snapshot into the live `items` array (same object — the binding stays intact) and saves. */
export function popUndoSnapshot() {
  if (!stack.length) return false;
  const snap = JSON.parse(stack.pop());
  items.length = 0;
  items.push(...snap);
  save();
  onChange?.();
  return true;
}
