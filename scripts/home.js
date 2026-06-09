// home.js — your home page: your named canvases and your courtyards.

import {
  listCanvases, createCanvas, renameCanvas, deleteCanvas,
  getMe, setMe,
} from "./store.js";
import { listCourtyards, createInvite } from "../courtyardcreationlogic.js";
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
    tile.innerHTML = `<span class="tile__name">${escapeHtml(c.name)}</span>`;
    tile.onclick = () => go("canvas/" + c.id);

    const tools = el("div", "tile__tools");
    tools.append(
      iconBtn("✎", "Rename", (e) => {
        e.stopPropagation();
        const name = prompt("Rename canvas", c.name);
        if (name && name.trim()) { renameCanvas(c.id, name.trim()); renderHome(container); }
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
