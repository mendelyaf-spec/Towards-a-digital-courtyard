// feed.js — every published mosaic, browsable read-only. Publishing lives on
// the canvas toolbar (see main.js's publishToggle); what shows up here is
// exactly what listPublishedCanvases() says is published, most recent first.
// Single-device for now, same as everything else that assumes "everyone" but
// only has local storage to work with (see store.js's own note on this) —
// this lists only YOUR published canvases until there's a backend to widen it.

import { listPublishedCanvases } from "./store.js";
import { go } from "./router.js";

export function renderFeed(container) {
  container.replaceChildren();

  const head = el("header", "home__head");
  head.innerHTML = `
    <h1 class="home__title">the feed</h1>
    <button class="home__me" type="button" title="Back to your canvases">‹ home</button>`;
  head.querySelector(".home__me").onclick = () => go("");
  container.append(head);

  const published = listPublishedCanvases();
  if (!published.length) {
    const empty = el("p", "feed__empty");
    empty.textContent = "Nothing published yet — open one of your canvases, then use \"📰 publish\" on its toolbar when it's ready.";
    container.append(empty);
    return;
  }

  const grid = el("div", "home__grid");
  for (const c of published) {
    const tile = el("div", "tile tile--feed");
    tile.innerHTML = `<span class="tile__name">${escapeHtml(c.name)}</span>`;
    tile.onclick = () => go("feed/" + c.id);
    grid.append(tile);
  }
  container.append(grid);
}

function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
