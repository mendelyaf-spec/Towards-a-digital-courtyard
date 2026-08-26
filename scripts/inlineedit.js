// inlineedit.js — rename something by typing on it, not in a dialog.
//
// A browser prompt() yanks you out of the page to retype a name into a
// grey box that doesn't look like the thing you're renaming. This edits
// the words where they already are: the element becomes editable in
// place, its text is selected so typing replaces it, Enter commits,
// Escape puts it back, and clicking away commits.
//
// Deliberately conservative about what counts as a change: whitespace is
// collapsed, and an empty result (or one identical to what was there)
// restores the original rather than committing a blank name.

/**
 * @param {HTMLElement} el       the element whose text IS the name
 * @param {(name: string) => void} onCommit  called only on a real change
 */
export function editInline(el, onCommit) {
  if (!el || el.dataset.editing === "1") return; // already editing this one
  const original = el.textContent;
  el.dataset.editing = "1";
  el.contentEditable = "true";
  el.spellcheck = false;
  el.focus();

  // Select it all, so typing replaces the old name the way a prompt did.
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    el.contentEditable = "false";
    delete el.dataset.editing;
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("blur", onBlur);
    el.removeEventListener("pointerdown", swallow);
    el.removeEventListener("click", swallow);
    const typed = el.textContent.replace(/\s+/g, " ").trim();
    if (!commit || !typed || typed === original) {
      el.textContent = original; // cancelled, blanked, or unchanged
      return;
    }
    el.textContent = typed;
    onCommit?.(typed);
  };

  const onKey = (e) => {
    // A name is one line, and while you're typing one the app's own
    // shortcuts must stay out of it — Escape otherwise stops a playing
    // embed or cancels a connection, and the canvas listens on document.
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  // While editing, a click on the words is a text cursor — not "open this
  // canvas" (the home tile's own click handler sits on its parent).
  const swallow = (e) => e.stopPropagation();

  el.addEventListener("keydown", onKey);
  el.addEventListener("blur", onBlur);
  el.addEventListener("pointerdown", swallow);
  el.addEventListener("click", swallow);
}
