// home.js — your home page: your named canvases and your courtyards.

import {
  listCanvases, createCanvas, renameCanvas, deleteCanvas, reorderCanvases,
  getMe, setMe,
} from "./store.js";
import { listCourtyards, createInvite } from "../courtyardcreationlogic.js";
import { editInline } from "./inlineedit.js";
import { go } from "./router.js";

export function renderHome(container) {
  const me = getMe();
  container.replaceChildren();

  // Header with editable profile (name + icon).
  const head = el("header", "home__head");
  head.innerHTML = `
    <h1 class="home__title">the courtyard</h1>
    <button class="home__me" title="Edit your profile">
      <span class="home__me-icon">${me.icon}</span>
      <span class="home__me-name">${escapeHtml(me.name)}</span>
    </button>`;
  head.querySelector(".home__me").onclick = () => {
    const name = prompt("Your name", me.name);
    if (name === null) return;
    const icon = prompt("Your icon (an emoji)", me.icon) || me.icon;
    setMe({ ...me, name: name.trim() || me.name, icon: icon.trim() || me.icon });
    renderHome(container);
  };
  container.append(head);

  // Your canvases.
  container.append(sectionTitle("Your canvases"));
  const grid = el("div", "home__grid");
  for (const c of listCanvases()) {
    const tile = el("div", "tile");
    tile.dataset.id = c.id; // read back on drop, to save the new order
    tile.innerHTML = `<span class="tile__name">${escapeHtml(c.name)}</span>`;
    tile.onclick = () => go("canvas/" + c.id);

    const tools = el("div", "tile__tools");
    const drag = el("button", "tile__tool tile__tool--drag");
    drag.type = "button"; drag.title = "Drag to reorder"; drag.textContent = "⠿";
    drag.addEventListener("pointerdown", (e) => startDrag(e, tile, grid));
    drag.addEventListener("click", (e) => e.stopPropagation()); // a plain tap shouldn't open the canvas
    tools.append(
      drag,
      iconBtn("✎", "Rename", (e) => {
        e.stopPropagation();
        // Type on the tile's own name rather than in a dialog. No re-render
        // afterward — the element already shows the new name, and rebuilding
        // the grid here would destroy the element mid-commit.
        editInline(tile.querySelector(".tile__name"), (name) => renameCanvas(c.id, name));
      }),
      iconBtn("🗑", "Delete", (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${c.name}"? This can't be undone.`)) {
          deleteCanvas(c.id); renderHome(container);
        }
      })
    );
    tile.append(tools);
    grid.append(tile);
  }
  const add = el("button", "tile tile--add");
  add.textContent = "+ new canvas";
  add.onclick = () => { const c = createCanvas(); go("canvas/" + c.id); };
  grid.append(add);
  container.append(grid);

  // Your courtyards.
  container.append(sectionTitle("Courtyards"));
  const cyGrid = el("div", "home__grid");
  for (const ct of listCourtyards()) {
    const tile = el("div", "tile tile--courtyard");
    tile.innerHTML = `<span class="tile__name">${escapeHtml(ct.name)}</span>`;
    tile.onclick = () => go("courtyard/" + ct.id);
    cyGrid.append(tile);
  }
  const invite = el("button", "tile tile--add");
  invite.textContent = "+ invite to a courtyard";
  invite.onclick = () => startInvite();
  cyGrid.append(invite);
  container.append(cyGrid);
}

// Mint a one-time invite link tied to one of your canvases.
function startInvite() {
  const canvases = listCanvases();
  if (!canvases.length) { alert("Make a canvas first."); return; }
  const pick = canvases[0]; // first canvas for now; a picker can come later
  const { url } = createInvite(pick.id);
  // Try to copy; always show it so it can be shared by text/email.
  navigator.clipboard?.writeText(url).catch(() => {});
  prompt(
    "Share this one-time link with the other person.\n" +
      "(On this device, opening it yourself will create the courtyard as a demo.)",
    url
  );
}

// Drag a canvas tile to a new spot in the grid via its ⠿ handle. Recomputes
// the dragged tile's target slot from scratch on every move — from the
// OTHER tiles' current rects, not from "whatever's under the pointer" —
// rather than nudging it one step at a time. An incremental hop needs a
// pointermove for every tile boundary it crosses, and a real cursor (or a
// coalesced batch of events) can easily jump two tiles in one move; the
// fresh-each-time version lands in the right slot regardless of how far
// the pointer moved since the last event. Works the same whether the grid
// is one row or several. The order only commits to storage on release;
// nothing is saved mid-drag.
//
// Tracked via document listeners rather than setPointerCapture on the
// handle: capture is implicitly released the moment its element (or an
// ancestor — here, the tile itself, moving on every reorder) is detached
// and reattached, which a DOM move does even when the visual position
// ends up unchanged. That silently ended the drag after the first move.
// The handle never leaves the tile's bounds during a real drag anyway, so
// nothing here depended on capture actually widening the hit area.
function startDrag(e, tile, grid) {
  e.stopPropagation(); // not "open this canvas"
  e.preventDefault();
  tile.classList.add("tile--dragging");
  const addTile = grid.querySelector(".tile--add");

  const onMove = (ev) => {
    // The first tile (in visual order) whose row starts below the pointer,
    // or that shares the pointer's row but starts to its right, is where
    // the dragged tile belongs — insert before it. Past every tile, it
    // goes at the end (still ahead of the ever-last "+ new canvas" tile).
    let target = addTile;
    for (const t of grid.querySelectorAll(".tile:not(.tile--add)")) {
      if (t === tile) continue;
      const r = t.getBoundingClientRect();
      const sameRow = ev.clientY >= r.top && ev.clientY < r.bottom;
      if (ev.clientY < r.top || (sameRow && ev.clientX < r.left + r.width / 2)) { target = t; break; }
    }
    if (target !== tile) target.before(tile);
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    tile.classList.remove("tile--dragging");
    const order = [...grid.querySelectorAll(".tile:not(.tile--add)")].map((t) => t.dataset.id);
    reorderCanvases(order);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

// ---- tiny DOM helpers ----
function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function sectionTitle(t) { const h = el("h2", "home__section"); h.textContent = t; return h; }
function iconBtn(label, title, onclick) {
  const b = el("button", "tile__tool");
  b.type = "button"; b.title = title; b.textContent = label; b.onclick = onclick;
  return b;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
