// rules/rules.js — shared "Courtyard rules" interaction inside the void.
// Placeholder.

export function renderRules(courtyard) {
  const el = document.createElement("div");
  el.className = "void-panel void-panel--rules";
  el.innerHTML = `<h4>Rules</h4><p>The courtyard's shared rules will live here.</p>`;
  return el;
}
