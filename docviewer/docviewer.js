// docviewer/docviewer.js — read a PDF or text file, and write in its margin.
//
// Select a passage → it stays highlighted in the document, and a card opens
// in the margin beside it where you write your own note about it. Both
// persist with the file (on its pocket record), so the next time you open
// it your marginalia is still there. Clicking a highlight focuses its note
// and vice versa; each note also carries a copy button for the passage it
// marks.
//
// Anchoring: a highlight is stored as character offsets into its page's own
// extracted plain text, NOT as anything about the DOM. That's what lets it
// be found again on a later open — a PDF's text layer is re-rendered from
// scratch every time and its element structure is not stable, but the text
// it extracts to is.
//
// PDFs render via the vendored PDF.js (see LICENSES.md): a canvas for the
// visible page plus PDF.js's own transparent, absolutely-positioned text
// layer over it, which is what makes real text selection possible. Plain
// text files skip all of that and just render their contents.

import { getDocAnnotations, setDocAnnotations } from "../pocket/pocket.js";

const DEFAULT_PDF_SCALE = 1.35; // PDF.js render scale shown to you as "100%"
const MIN_PDF_SCALE = 0.6;
const MAX_PDF_SCALE = 3.5;
const ZOOM_STEP = 1.2;

let pdfLoading = null;

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfLoading) return pdfLoading;
  pdfLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "docviewer/vendor/pdf.min.js";
    s.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) return reject(new Error("PDF.js failed to initialize"));
      lib.GlobalWorkerOptions.workerSrc = "docviewer/vendor/pdf.worker.min.js";
      resolve(lib);
    };
    s.onerror = () => reject(new Error("Couldn't load the PDF reader"));
    document.head.appendChild(s);
  });
  return pdfLoading;
}

export function isViewableDoc(mime, name = "") {
  const m = (mime || "").toLowerCase();
  const n = name.toLowerCase();
  return (
    m === "application/pdf" ||
    m.startsWith("text/") ||
    m === "application/json" ||
    /\.(pdf|txt|md|markdown|csv|log|json)$/.test(n)
  );
}

export function isPlainText(mime, name = "") {
  return isViewableDoc(mime, name) && !isPdf(mime, name);
}

function isPdf(mime, name = "") {
  return (mime || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(name);
}

// ---------- offset <-> DOM helpers ----------
// Everything below works on "the plain text of this page" as the single
// source of truth, so the same code serves both renderers.

function textNodesIn(root) {
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) out.push(n);
  return out;
}

/** Character offset of (node, offset) within root's concatenated text, or -1. */
function offsetIn(root, node, offset) {
  let total = 0;
  for (const t of textNodesIn(root)) {
    if (t === node) return total + offset;
    total += t.nodeValue.length;
  }
  return -1;
}

/**
 * Wrap [start, end) of root's concatenated text in fresh elements from
 * make(). Ranges are collected BEFORE any wrapping, since wrapping mutates
 * the tree the walker just read; and each range is confined to a single
 * text node, which is what makes surroundContents always legal here.
 */
function wrapRange(root, start, end, make) {
  const jobs = [];
  let pos = 0;
  for (const t of textNodesIn(root)) {
    const len = t.nodeValue.length;
    const s = Math.max(start, pos);
    const e = Math.min(end, pos + len);
    if (s < e) jobs.push({ node: t, from: s - pos, to: e - pos });
    pos += len;
    if (pos >= end) break;
  }
  const made = [];
  for (const j of jobs) {
    const range = document.createRange();
    range.setStart(j.node, j.from);
    range.setEnd(j.node, j.to);
    const el = make();
    try {
      range.surroundContents(el);
      made.push(el);
    } catch {
      /* a node shape we can't wrap — skip it rather than break the render */
    }
  }
  return made;
}

export class DocViewer {
  constructor() {
    this.el = document.getElementById("docViewer");
    this.titleEl = document.getElementById("docViewerTitle");
    this.pagesEl = document.getElementById("docViewerPages");
    this.marginEl = document.getElementById("docViewerMargin");
    this.bodyEl = document.querySelector(".docviewer__body");
    this.closeBtn = document.getElementById("docViewerClose");
    this.hintEl = document.getElementById("docViewerHint");
    this.addNoteBtn = document.getElementById("docViewerAddNote");
    this.zoomEl = document.getElementById("docViewerZoom");
    this.zoomOutBtn = document.getElementById("docViewerZoomOut");
    this.zoomInBtn = document.getElementById("docViewerZoomIn");
    this.zoomLabelEl = document.getElementById("docViewerZoomLabel");

    this.recordId = null;
    this.annotations = [];
    this.pages = []; // { el, textEl, text }
    this._token = 0; // bumped per open, so a slow render for a closed/replaced doc bails
    this._pdfDoc = null; // the loaded PDF.js document — kept around so zooming re-renders, not re-parses
    this._pdfjsLib = null;
    this.pdfScale = DEFAULT_PDF_SCALE;
    this._pending = null; // { page, start, end, text } — a selection waiting on "+ add note"

    this.closeBtn.addEventListener("click", () => this.close());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
      // Any press elsewhere — including starting a new selection — retires
      // an unclaimed one rather than leaving a stale button floating.
      if (e.target !== this.addNoteBtn) this._hideAddNote();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || this.el.hidden) return;
      if (this._pending) { this._hideAddNote(); return; }
      if (!this._editingNote()) this.close();
    });

    // Selecting inside a page offers to highlight it — offers, doesn't do
    // it: this only arms the "+ add note" button near the selection.
    this.pagesEl.addEventListener("mouseup", () => this._onSelection());
    this.pagesEl.addEventListener("touchend", () => setTimeout(() => this._onSelection(), 0));
    this.addNoteBtn.addEventListener("click", () => this._commitAddNote());

    this.zoomOutBtn.addEventListener("click", () => this._setZoom(1 / ZOOM_STEP));
    this.zoomInBtn.addEventListener("click", () => this._setZoom(ZOOM_STEP));

    // The button's position is a snapshot (position:fixed, captured once
    // from the selection's own rect) — scrolling would leave it floating
    // over the wrong passage, so it just retires instead of tracking.
    this.bodyEl.addEventListener("scroll", () => this._hideAddNote(), { passive: true });
  }

  _editingNote() {
    const a = document.activeElement;
    return !!(a && a.classList?.contains("docviewer__note-input"));
  }

  /**
   * Read a plain canvas note: its words, large and legible, the same way a
   * link opens to be read — and editable here, since a note squeezed into
   * a photo's shape can't practically be edited in place on the canvas.
   * No margin: marginalia belongs to a document, and a note IS the note.
   */
  openNote(item, onSave) {
    const token = ++this._token;
    this.recordId = null;
    this.annotations = [];
    this.pages = [];
    this._pdfDoc = null;
    this._hideAddNote();
    this.zoomEl.hidden = true;
    this.titleEl.textContent = "note";
    // No onSave = a pure reader (view mode): typing into a textarea whose
    // changes silently vanish would be worse than not letting you type.
    this.hintEl.textContent = onSave
      ? "Edit freely — changes save as you type."
      : "Reading — press edit on the canvas to change this note.";
    this.pagesEl.innerHTML = "";
    this.marginEl.innerHTML = "";
    this.el.hidden = false;
    this.el.classList.add("is-note");

    const page = document.createElement("div");
    page.className = "docviewer__page docviewer__page--text";
    const area = document.createElement("textarea");
    area.className = "docviewer__noteedit";
    area.value = item.text || "";
    area.placeholder = "…";
    area.readOnly = !onSave;
    page.appendChild(area);
    this.pagesEl.appendChild(page);
    area.focus();

    let timer;
    area.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (this._token === token) onSave?.(area.value);
      }, 300);
    });
    // Don't let a pending debounce drop the last keystrokes on close.
    this._flushNote = () => {
      clearTimeout(timer);
      if (area.value !== (item.text || "")) onSave?.(area.value);
    };
  }

  async open(record) {
    const token = ++this._token;
    this.recordId = record.id;
    this.titleEl.textContent = record.name || "document";
    this.pagesEl.innerHTML = "";
    this.marginEl.innerHTML = "";
    this.pages = [];
    this._pdfDoc = null;
    this.pdfScale = DEFAULT_PDF_SCALE;
    this.zoomLabelEl.textContent = "100%";
    this.zoomOutBtn.disabled = false;
    this.zoomInBtn.disabled = false;
    this._hideAddNote();
    this.zoomEl.hidden = true; // shown once _renderPdf confirms this is one
    this.el.hidden = false;
    this.el.classList.remove("is-note");
    this._flushNote = null;
    this.hintEl.textContent = "Loading…";

    try {
      this.annotations = await getDocAnnotations(record.id);
    } catch {
      this.annotations = [];
    }

    try {
      if (isPdf(record.mime, record.name)) await this._renderPdf(record, token);
      else await this._renderText(record, token);
    } catch (err) {
      console.error(err);
      if (this._token !== token) return;
      this.hintEl.textContent = "";
      this.pagesEl.innerHTML = `<p class="docviewer__error">Couldn't open this document. ${
        isPdf(record.mime, record.name) ? "The PDF reader may be unavailable offline the first time." : ""
      }</p>`;
      return;
    }
    if (this._token !== token) return;
    this.hintEl.textContent = "Select any passage to highlight it and write a note in the margin.";
    this._applyAllHighlights();
    this._renderMargin();
  }

  close() {
    this._flushNote?.();
    this._flushNote = null;
    this._hideAddNote();
    this.el.classList.remove("is-note");
    this._token++; // orphan any in-flight render
    this.el.hidden = true;
    this.pagesEl.innerHTML = "";
    this.marginEl.innerHTML = "";
    this.pages = [];
    this.recordId = null;
    this._pdfDoc = null;
  }

  async _renderText(record, token) {
    const text = await record.blob.text();
    if (this._token !== token) return;
    const page = document.createElement("div");
    page.className = "docviewer__page docviewer__page--text";
    const body = document.createElement("div");
    body.className = "docviewer__text";
    body.textContent = text;
    page.appendChild(body);
    this.pagesEl.appendChild(page);
    this.pages = [{ el: page, textEl: body, text }];
  }

  async _renderPdf(record, token) {
    const pdfjsLib = await loadPdfJs();
    if (this._token !== token) return;
    const buf = await record.blob.arrayBuffer();
    if (this._token !== token) return;
    this._pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    if (this._token !== token) return;
    this._pdfjsLib = pdfjsLib;
    this.zoomEl.hidden = false;
    await this._renderPdfPages(token);
  }

  /** (Re)draws every page of the already-loaded PDF at this.pdfScale — the
   *  part zooming redoes. Kept separate from _renderPdf so zooming doesn't
   *  re-fetch or re-parse the file, just re-rasterize it. */
  async _renderPdfPages(token) {
    const pdfjsLib = this._pdfjsLib;
    const pdf = this._pdfDoc;
    this.pagesEl.innerHTML = "";
    this.pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const pdfPage = await pdf.getPage(i);
      if (this._token !== token) return;
      const viewport = pdfPage.getViewport({ scale: this.pdfScale });

      const page = document.createElement("div");
      page.className = "docviewer__page";
      page.style.width = `${viewport.width}px`;
      page.style.height = `${viewport.height}px`;

      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className = "docviewer__canvas";
      page.appendChild(canvas);

      const textEl = document.createElement("div");
      textEl.className = "docviewer__textlayer";
      textEl.style.width = `${viewport.width}px`;
      textEl.style.height = `${viewport.height}px`;
      // PDF.js sizes its text-layer spans in --scale-factor units; without
      // this they land at the wrong size and the invisible text stops
      // lining up with the rendered page, which would make selecting a
      // passage select the wrong words.
      textEl.style.setProperty("--scale-factor", String(viewport.scale));
      page.appendChild(textEl);
      this.pagesEl.appendChild(page);

      await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      if (this._token !== token) return;

      const content = await pdfPage.getTextContent();
      if (this._token !== token) return;
      await pdfjsLib.renderTextLayer({ textContentSource: content, container: textEl, viewport, textDivs: [] }).promise;
      if (this._token !== token) return;

      this.pages.push({ el: page, textEl, text: textNodesIn(textEl).map((t) => t.nodeValue).join("") });
    }
  }

  // ---------- zoom ----------

  async _setZoom(factor) {
    if (!this._pdfDoc) return;
    const next = Math.min(MAX_PDF_SCALE, Math.max(MIN_PDF_SCALE, this.pdfScale * factor));
    if (next === this.pdfScale) return;
    this.pdfScale = next;
    const token = this._token;
    this._hideAddNote(); // its position was anchored to the old page layout

    // Re-rendering rebuilds every page element, which would otherwise
    // reset the scroll to the top — restore roughly the same spot instead.
    const maxScroll = this.bodyEl.scrollHeight - this.bodyEl.clientHeight;
    const frac = maxScroll > 0 ? this.bodyEl.scrollTop / maxScroll : 0;

    await this._renderPdfPages(token);
    if (this._token !== token) return;
    this._applyAllHighlights();
    this._renderMargin();

    const newMax = this.bodyEl.scrollHeight - this.bodyEl.clientHeight;
    if (newMax > 0) this.bodyEl.scrollTop = frac * newMax;

    this.zoomLabelEl.textContent = `${Math.round((this.pdfScale / DEFAULT_PDF_SCALE) * 100)}%`;
    this.zoomOutBtn.disabled = this.pdfScale <= MIN_PDF_SCALE;
    this.zoomInBtn.disabled = this.pdfScale >= MAX_PDF_SCALE;
  }

  // ---------- highlighting ----------

  _pageIndexOf(node) {
    for (let i = 0; i < this.pages.length; i++) {
      if (this.pages[i].textEl.contains(node)) return i;
    }
    return -1;
  }

  // Selecting text only ever ARMS the "+ add note" button next to it —
  // nothing is highlighted or saved, and no note opens, until you actually
  // press it. See _commitAddNote for the part that used to happen here.
  _onSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { this._hideAddNote(); return; }
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (!text) { this._hideAddNote(); return; }

    const pi = this._pageIndexOf(range.startContainer);
    // A selection spanning two pages has no single anchor page — ignore it
    // rather than silently anchoring it to the wrong one.
    if (pi < 0 || pi !== this._pageIndexOf(range.endContainer)) { this._hideAddNote(); return; }

    const root = this.pages[pi].textEl;
    const start = offsetIn(root, range.startContainer, range.startOffset);
    const end = offsetIn(root, range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) { this._hideAddNote(); return; }

    this._pending = { page: pi, start, end, text: sel.toString(), rect: range.getBoundingClientRect() };
    this._positionAddNote();
  }

  _positionAddNote() {
    const r = this._pending?.rect;
    if (!r) return;
    this.addNoteBtn.hidden = false;
    // Clamped off the edges — a selection right at the margin shouldn't
    // push the button half off-screen.
    this.addNoteBtn.style.left = `${Math.min(Math.max(r.left + r.width / 2, 60), window.innerWidth - 60)}px`;
    this.addNoteBtn.style.top = `${Math.max(r.top, 40)}px`;
  }

  _hideAddNote() {
    this._pending = null;
    this.addNoteBtn.hidden = true;
  }

  // The one thing that actually creates a highlight + note — pressing the
  // button _onSelection armed, never just selecting text.
  _commitAddNote() {
    const p = this._pending;
    if (!p) return;
    const ann = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, page: p.page, start: p.start, end: p.end, text: p.text, note: "" };
    this.annotations.push(ann);
    this._hideAddNote();
    window.getSelection()?.removeAllRanges();
    this._applyAllHighlights();
    this._renderMargin(ann.id); // NOW focus the note — you just asked for it
    this._persist();
  }

  _applyAllHighlights() {
    // Rebuild from the untouched text every time — unwrapping in place would
    // have to undo overlapping wraps in the right order; re-rendering the
    // page's text is simpler and always correct.
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      if (p.el.classList.contains("docviewer__page--text")) {
        p.textEl.textContent = p.text;
      } else {
        p.textEl.querySelectorAll(".docviewer__hl").forEach((m) => {
          const parent = m.parentNode;
          while (m.firstChild) parent.insertBefore(m.firstChild, m);
          m.remove();
          parent.normalize();
        });
      }
    }
    for (const ann of this.annotations) {
      const p = this.pages[ann.page];
      if (!p) continue;
      wrapRange(p.textEl, ann.start, ann.end, () => {
        const mark = document.createElement("mark");
        mark.className = "docviewer__hl";
        mark.dataset.ann = ann.id;
        mark.addEventListener("click", (e) => {
          e.stopPropagation();
          this._focusNote(ann.id);
        });
        return mark;
      });
    }
  }

  _firstMarkFor(id) {
    return this.pagesEl.querySelector(`.docviewer__hl[data-ann="${id}"]`);
  }

  _focusNote(id) {
    const card = this.marginEl.querySelector(`.docviewer__note[data-ann="${id}"]`);
    if (!card) return;
    this.marginEl.querySelectorAll(".docviewer__note").forEach((c) => c.classList.remove("is-active"));
    card.classList.add("is-active");
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card.querySelector(".docviewer__note-input")?.focus();
  }

  _renderMargin(focusId) {
    this.marginEl.innerHTML = "";
    if (!this.annotations.length) {
      const empty = document.createElement("p");
      empty.className = "docviewer__margin-empty";
      empty.textContent = "Your notes will appear here.";
      this.marginEl.appendChild(empty);
      return;
    }

    // Document order, then nudged toward their highlight's own vertical
    // position — pushed down when they'd collide, so a run of highlights
    // close together still reads top-to-bottom instead of overlapping.
    // Below the narrow breakpoint there IS no side margin (the CSS stacks
    // the notes under the document as a plain static list), so all of that
    // positioning is skipped rather than fighting the stylesheet.
    const aligned = !window.matchMedia("(max-width: 720px)").matches;
    const ordered = [...this.annotations].sort((a, b) => a.page - b.page || a.start - b.start);
    const marginTop = this.marginEl.getBoundingClientRect().top;
    let lowest = 0;

    for (const ann of ordered) {
      const card = document.createElement("div");
      card.className = "docviewer__note";
      card.dataset.ann = ann.id;

      const quote = document.createElement("blockquote");
      quote.className = "docviewer__note-quote";
      quote.textContent = ann.text.length > 180 ? ann.text.slice(0, 180) + "…" : ann.text;
      quote.title = "Jump to this passage";
      quote.addEventListener("click", () => {
        this._firstMarkFor(ann.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });

      const input = document.createElement("textarea");
      input.className = "docviewer__note-input";
      input.rows = 2;
      input.placeholder = "your note…";
      input.value = ann.note || "";
      input.addEventListener("input", () => {
        ann.note = input.value;
        this._persistSoon();
      });
      input.addEventListener("focus", () => {
        this.marginEl.querySelectorAll(".docviewer__note").forEach((c) => c.classList.remove("is-active"));
        card.classList.add("is-active");
      });

      const row = document.createElement("div");
      row.className = "docviewer__note-row";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "docviewer__note-btn";
      copyBtn.textContent = "copy";
      copyBtn.title = "Copy this passage";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(ann.text);
          copyBtn.textContent = "copied";
          setTimeout(() => (copyBtn.textContent = "copy"), 1200);
        } catch {
          copyBtn.textContent = "can't copy";
          setTimeout(() => (copyBtn.textContent = "copy"), 1600);
        }
      });
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "docviewer__note-btn docviewer__note-btn--del";
      delBtn.textContent = "remove";
      delBtn.addEventListener("click", () => {
        this.annotations = this.annotations.filter((a) => a.id !== ann.id);
        this._applyAllHighlights();
        this._renderMargin();
        this._persist();
      });
      row.append(copyBtn, delBtn);

      card.append(quote, input, row);
      this.marginEl.appendChild(card);

      if (!aligned) continue;
      const mark = this._firstMarkFor(ann.id);
      if (mark) {
        const want = mark.getBoundingClientRect().top - marginTop + this.marginEl.scrollTop;
        const top = Math.max(want, lowest);
        card.style.top = `${Math.max(0, top)}px`;
        lowest = top + card.offsetHeight + 10;
      } else {
        card.style.top = `${lowest}px`;
        lowest += card.offsetHeight + 10;
      }
    }
    this.marginEl.style.height = aligned ? `${lowest + 20}px` : "";
    if (focusId) this._focusNote(focusId);
  }

  // Typing in a note shouldn't hit IndexedDB on every keystroke.
  _persistSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._persist(), 400);
  }

  _persist() {
    clearTimeout(this._saveTimer);
    if (!this.recordId) return;
    setDocAnnotations(this.recordId, this.annotations).catch((err) =>
      console.warn("Couldn't save your margin notes.", err)
    );
  }
}
