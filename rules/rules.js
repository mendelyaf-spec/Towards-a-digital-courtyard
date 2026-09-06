// rules/rules.js — shared "Courtyard rules" interaction inside the void: the
// terms both sides agreed to when the courtyard formed — either picked by
// whoever sent the courtyard request (scripts/courtyardRequest.js) or
// defaulted quietly when it came from an invite link instead (see
// courtyardcreationlogic.js's createCourtyard).

import { describeDuration } from "../courtyardcreationlogic.js";

export function renderRules(courtyard) {
  const el = document.createElement("div");
  el.className = "void-panel void-panel--rules";
  const joined = courtyard.members.filter(Boolean).length;
  const maxMembers = courtyard.maxMembers || 2;
  const ended = courtyard.expiresAt && Date.now() > courtyard.expiresAt;

  let durationLine;
  if (!courtyard.durationHours) {
    durationLine = "No end date";
  } else if (ended) {
    durationLine = `Ended ${new Date(courtyard.expiresAt).toLocaleDateString()} (was live for ${describeDuration(courtyard.durationHours)})`;
  } else {
    durationLine = `Live for ${describeDuration(courtyard.durationHours)} — ends ${new Date(courtyard.expiresAt).toLocaleDateString()}`;
  }

  el.innerHTML = `
    <h4>Rules</h4>
    <p>Up to ${maxMembers} member${maxMembers === 1 ? "" : "s"} (${joined} joined)</p>
    <p>${durationLine}</p>`;
  return el;
}
