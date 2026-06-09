// pending-requests/pending-requests.js — shared "Pending member requests"
// interaction inside the void. Placeholder.

export function renderPending(courtyard) {
  const el = document.createElement("div");
  el.className = "void-panel void-panel--pending";
  el.innerHTML = `<h4>Pending requests</h4><p>New member requests will appear here.</p>`;
  return el;
}
