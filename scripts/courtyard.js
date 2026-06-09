// courtyard.js — renders a courtyard: two member halves around a shared void.
//
// Each member's icon opens their infinite canvas. The void in the middle holds
// the shared interactions (events / pending requests / rules) and accepts no
// personal content. Members can size their zone; arranging preview items is a
// first-pass placeholder.

import { getCourtyard, saveCourtyard } from "../courtyardcreationlogic.js";
import { getCanvas } from "./store.js";
import { go } from "./router.js";
import { renderEvents } from "../events/events.js";
import { renderPending } from "../pending-requests/pending-requests.js";
import { renderRules } from "../rules/rules.js";

export function renderCourtyard(container, id) {
  const ct = getCourtyard(id);
  container.replaceChildren();
  if (!ct) {
    container.append(msg("That courtyard doesn't exist."));
    addBack(container);
    return;
  }

  addBack(container);

  const title = document.createElement("h1");
  title.className = "courtyard-title";
  title.textContent = ct.name;
  title.title = "Rename courtyard";
  title.onclick = () => {
    const name = prompt("Rename courtyard", ct.name);
    if (name && name.trim()) { ct.name = name.trim(); saveCourtyard(ct); title.textContent = ct.name; }
  };
  container.append(title);

  const stage = div("courtyard-stage");
  stage.append(
    memberHalf(ct, ct.members[0], "left"),
    voidEl(ct),
    memberHalf(ct, ct.members[1], "right")
  );
  container.append(stage);
}

// One member's half: icon (opens their canvas) + zone-size control.
function memberHalf(ct, member, side) {
  const half = div(`half half--${side}`);
  if (!member) {
    half.append(msg("Waiting for a second member…"));
    return half;
  }

  const icon = document.createElement("button");
  icon.className = "half__icon";
  icon.textContent = member.icon || "🌿";
  icon.title = `Open ${member.name}'s canvas`;
  icon.onclick = () => {
    if (member.canvasId && getCanvas(member.canvasId)) go("canvas/" + member.canvasId);
    else alert(`${member.name}'s canvas isn't on this device yet.`);
  };

  const name = div("half__name");
  name.textContent = member.name;

  const size = document.createElement("input");
  size.type = "range";
  size.min = "60";
  size.max = "140";
  size.value = String(Math.round((member.zone?.size || 1) * 100));
  size.className = "half__size";
  size.title = "How much space your zone takes";
  const apply = () => { icon.style.fontSize = size.value / 100 * 56 + "px"; };
  size.oninput = apply;
  size.onchange = () => { member.zone = member.zone || {}; member.zone.size = size.value / 100; saveCourtyard(ct); };
  apply();

  const hint = div("half__hint");
  hint.textContent = "your preview items will arrange here";

  half.append(icon, name, size, hint);
  return half;
}

// The shared void: a default-shaped center holding the three placeholders.
function voidEl(ct) {
  const wrap = div("void");
  wrap.dataset.shape = ct.void?.shape || "circle";
  wrap.append(renderEvents(ct), renderPending(ct), renderRules(ct));
  return wrap;
}

function addBack(container) {
  const back = document.createElement("button");
  back.className = "back-btn";
  back.textContent = "‹ home";
  back.onclick = () => go("");
  container.append(back);
}
function div(cls) { const n = document.createElement("div"); n.className = cls; return n; }
function msg(text) { const n = div("courtyard-msg"); n.textContent = text; return n; }
