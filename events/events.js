// events/events.js — shared "Events" interaction inside the void. Placeholder.
// Lives in the void; neither member places personal content here.

export function renderEvents(courtyard) {
  const el = document.createElement("div");
  el.className = "void-panel void-panel--events";
  el.innerHTML = `<h4>Events</h4><p>Shared events will live here.</p>`;
  return el;
}
