# The Digital Courtyard — Integration Handoff

This document exists so you can pull individual features out of this codebase
and drop them into another app, without needing the full history of how it
was built. Every section names its files, its public API, its data shape,
and what it depends on.

**Stack**: zero-build vanilla JS (ES modules), no framework, no bundler,
no npm dependencies. Everything runs by serving the folder over HTTP.
Persistence is `localStorage` (single device/browser — see the note at the
end on what's needed to make it multi-device).

---

## 1. Architecture at a glance

```
index.html          — shell: three <div class="view"> sections (home / canvas / courtyard)
scripts/main.js      — bootstraps the canvas subsystem once, wires the router
scripts/router.js    — tiny hash router (#/, #/canvas/<id>, #/courtyard/<id>, #/join/<token>)
scripts/store.js     — localStorage-backed data layer (canvases, items, profile)
scripts/viewport.js  — pan/zoom engine for the infinite canvas
scripts/items.js     — ItemLayer: shapes/text/photos on the canvas (draw, attach, resize…)
scripts/extract.js   — offline background removal (photo → cut-out shape)
scripts/studio.js    — modal UI wrapping extract.js
scripts/home.js      — home page (your canvases + your courtyards)
scripts/courtyard.js — courtyard page (two-person shared space)
background/          — selective/whole-screen backgrounds behind canvas content
courtyardcreationlogic.js — courtyard data model + invite links
events/, pending-requests/, rules/ — placeholder modules for the courtyard's shared "void"
```

Each feature below is **independently extractable** — the dependency notes
tell you exactly what else you need to bring along.

---

## 2. Infinite pan/zoom canvas

**File**: `scripts/viewport.js` — class `Viewport`

```js
new Viewport(viewportEl, worldEl, { onChange(scale) {} })
```

- `viewportEl`: the fixed, full-size container that captures pointer/wheel events.
- `worldEl`: the child element that actually gets `transform: translate() scale()`'d. Put your canvas content inside this element.
- Desktop: drag to pan, wheel to zoom (anchored at the cursor). Mobile: one-finger pan, two-finger pinch-zoom (anchored at the pinch midpoint).
- `onChange(scale)` fires on every pan/zoom tick — use it to update a zoom readout or reposition floating UI (see §4/§5, both do this).

**Public API**:
| Method | Purpose |
|---|---|
| `screenToWorld(sx, sy)` | Convert a screen (client) coordinate to world-space coordinate |
| `centerWorld()` | World-space point currently at the center of the screen — used to spawn new items in view |
| `zoomAt(sx, sy, factor)` | Zoom by `factor`, anchored at a screen point |
| `reset()` | Snap back to translate (0,0), scale 1 |
| `.x`, `.y`, `.scale` | Current transform state (read freely) |

**Dependencies**: none. This is the one file every other canvas feature builds on. `--inv-scale` CSS custom property is set on `worldEl` (`1/scale`) so overlay controls (resize handles, badges) can counter-scale and stay a constant screen size regardless of zoom — see `.handle`, `.badge` etc. in `styles/main.css` for the pattern (`transform: scale(var(--inv-scale))`).

**Gotcha to know before you reuse it**: `Viewport`'s constructor calls `apply()` once immediately, which invokes `onChange`. If your `onChange` closure references variables declared *after* the `new Viewport(...)` call, you'll hit a temporal-dead-zone `ReferenceError` that can silently abort your whole script (this bit us once — see `scripts/main.js`'s two-stage `onChange` assignment for the pattern that avoids it: pass a trivial `onChange` at construction, upgrade it to the full version afterward).

---

## 3. Canvas items (shapes, text, photos, drawing, nested notes)

**File**: `scripts/items.js` — class `ItemLayer`

```js
new ItemLayer(worldEl, viewport)
```

Depends on `scripts/store.js` for persistence (`items`, `addItem`, `removeItem`, `save`, `openCanvas`) — either bring `store.js` as-is or swap in your own item array + save function matching that shape.

### Data model (per item)
```js
{
  id, type,              // type: 'rect' | 'circle' | 'image' | 'text'
  x, y, w, h,             // world-space position/size
  src,                    // image: data URL
  text, color,            // text items: content + text color
  opacity,                // fill/wash opacity 0-1 (see §3.4)
  strokes: [{ color, points: [[nx,ny], ...] }], // freehand ink, points normalized 0-1 within the item's box
  parentId, expanded,     // attach/expand nesting (see §3.3)
}
```

### 3.1 Shapes + move/resize/delete
- Toolbar buttons call `layer.add('rect')` / `layer.add('circle')` / `layer.add('text')` — spawns at the current view center.
- Every item gets a drag-to-move body, a resize handle (bottom-right corner; circles resize keeping 1:1 aspect), and a delete button, wired in `_wire()`.
- `MIN_SIZE = 24` (px, world units) is the resize floor.

### 3.2 Freehand drawing on an item
- Toggle `layer.drawMode = true` (or click the "✎ draw" button in the item bar), then pointer-drag on a selected item to ink an SVG path onto it.
- Strokes are stored as **normalized points** (0-1 relative to the item's box), so they scale correctly when the item is resized. See `_startStroke`, `strokeD`, `strokePath`.
- Ink renders in a per-item `<svg class="ink">` overlay, layered above the fill but below the text/badge/handles.

### 3.3 Recursive attach/expand ("notes on notes, ad infinitum")
- `layer.attachNote()` creates a child text item (`parentId` = the selected item's id) positioned beside it, and marks the parent `expanded = true`.
- Any item — including a note — can have notes attached to it. Nesting depth is unbounded.
- Tapping an item with children toggles `expanded`, which cascades visibility down through `_applyVisibility()` / `_visible()` (an item is only visible if **every** ancestor up the chain is expanded).
- Dragging a parent drags its full descendant subtree (`_descendants()` computes this on pointerdown so the drag stays O(1) per move-tick).
- Deleting a parent deletes its full subtree (`remove()`).
- `layer.onVisibility` and `layer.onRemove` are hooks other systems can subscribe to (used by the background layer, §4, to keep grouped backgrounds in sync — this is the extension point to copy if you want another system to "ride along" with expand/collapse or delete).

### 3.4 Per-item fill opacity
- The item bar's **opacity** slider fades only the item's *fill* (rect/circle background color, text's background wash, or the `<img>` itself for photos) — never its content (text, ink, badges, handles stay fully visible). This is deliberate: the point is letting text/ink read clearly against a lightened shape.
- Implementation: `_applyFill(el, item)` sets `backgroundColor` as an `rgba(...)` string (base color per type is hardcoded in `FILL_RGB`) rather than setting CSS `opacity` on the whole element (which would fade children too).
- Defaults: rect/circle = 1 (opaque), text = 0.82, image = 1. See `DEFAULT_OPACITY`.

### 3.5 Selection + contextual bar
- `layer.select(id | null)` — selecting brings the item to front (DOM reorder) and shows `#itemBar` (color / opacity / draw / note controls), positioned above the item via `positionBar()`.
- `positionBar()` **clamps to stay on-screen** — worth keeping if you reuse this, since an item that's large or panned partway off-screen would otherwise push its own toolbar out of reach.
- `layer.onSelect(id)` hook fires on every selection change — used to cross-deselect with the background layer (see §4).

**Multi-canvas note**: `loadCanvas(id)` tears down all rendered nodes and re-renders from a different canvas's item list (via `store.js`'s `openCanvas(id)`). If you don't need multiple canvases, ignore this and just construct once against a single item array.

---

## 4. Selective / whole-screen backgrounds

**Folder**: `background/` (`background.js` — class `BackgroundLayer`, `background.css`)

```js
new BackgroundLayer(worldEl, viewport)
```

This is the most self-contained feature — one JS file, one CSS file, one import from `store.js` (`canvasBgKey`, to namespace storage per-canvas; trivial to remove if you don't have multi-canvas).

### Concept: two-phase placement
A background region is either **placing** (diaphanous, floating *above* all canvas content, with move/resize/rotate handles so you can see what it'll cover while positioning it) or **committed** ("set" — sitting *behind* all content at its real opacity). Two separate DOM layers make this work: `this.placeWorld` (appended to `worldEl`, always kept last/topmost via `_toFront()`) and `this.bgWorld` (inserted as `worldEl`'s *first* child, so it's always behind items rendered by `ItemLayer`).

### Data model (per region)
```js
{
  id, shape,              // shape: 'rect' | 'circle' | 'image'
  x, y, w, h, rotation,   // world-space transform (rotation in degrees)
  opacity,                // final opacity once committed
  color,                  // rect/circle fill (image shapes use `src` instead)
  src,                    // image shape: data URL
  placing,                // true while in the diaphanous preview phase
  parentId,               // optional: binds this region to an item-group (§4 "grouped backgrounds")
}
```

### Public API
| Method | Purpose |
|---|---|
| `toggleMode()` | Flips `this.mode` — while true, shape/photo toolbar actions create backgrounds instead of items (that routing lives in the *caller*, e.g. `main.js`, not in this class) |
| `add(shape, { src, parentId })` | Create a new region, centered on the current view, in placing phase |
| `commit(id)` | Placing → committed: drops behind content at its stored opacity |
| `edit(id)` | Committed → placing: brings back to the diaphanous preview for further adjustment |
| `fillScreen(id)` | Resize + reposition to cover the *current* viewport (+15% slack each side) — a one-time snap-to-view, not a persistent "always follow the camera" wallpaper mode |
| `select(id \| null)`, `positionBar()` | Same pattern as `ItemLayer` — the bar clamps on-screen for the same reason (a fill-screen region's bounds extend far past the viewport) |

### Move/resize/rotate math worth reusing
- **Move**: plain delta drag.
- **Resize**: the drag delta is **un-rotated** into the item's local axes before being applied (`lx = dx·cos θ + dy·sin θ`, `ly = -dx·sin θ + dy·cos θ`), and the resize keeps the *center* fixed rather than the corner — this is what makes resize behave correctly on a rotated shape. See the `handle` pointerdown handler.
- **Rotate**: angle is `atan2` of the pointer relative to the item's screen-space center, tracked as a delta from a "rotation at drag start" baseline.

### Grouped backgrounds (binding to an item's expand/collapse)
If you create a background while an `ItemLayer` item-group is **open** (expanded + itself visible), it's tagged with `parentId`. From then on:
- `refreshGroupedVisibility()` hides/shows it in lockstep with the group's expand state (call this from your `ItemLayer.onVisibility` hook).
- `beginGroupDrag(ids)` / `groupDragTo(dx, dy)` / `endGroupDrag()` move it with the group during a drag (call from `ItemLayer`'s move handler — see `scripts/items.js`'s `groupBg?.beginGroupDrag(...)` calls for the wiring pattern).
- `removeGroupedUnder(ids)` deletes any regions bound to a deleted subtree (call from `ItemLayer.onRemove`).

If you don't need this cross-feature binding, you can drop all four methods and the `parentId`/`isOpen` plumbing — the placement/commit/resize/rotate/opacity core works standalone.

---

## 5. Photo → shape cut-out (offline background removal)

**Files**: `scripts/extract.js` (the algorithm), `scripts/studio.js` (modal UI wrapper)

No ML model, no network call — pure canvas pixel manipulation, works offline.

```js
import { fileToCanvas, removeBackground } from "./extract.js";
const canvas = await fileToCanvas(file);       // File/Blob -> downscaled <canvas> (max 1024px side)
const cutout = removeBackground(canvas, tolerance); // -> new, auto-cropped <canvas> with background transparent
```

**Algorithm** (`removeBackground`):
1. Sample the average color of the image's border ring as the background estimate.
2. Flood-fill inward from every border pixel, clearing any pixel within `tolerance` (Euclidean RGB distance) of that estimate. This means colors that also appear *inside* the subject are preserved (flood-fill is connectivity-based, not global color matching).
3. **Despeckle pass**: label the surviving (kept) pixels into connected components; drop any component smaller than 2% of the largest one. This removes the scattered "static" specks that JPEG noise/compression otherwise leaves floating near the subject (this was a real bug we hit and fixed — don't skip this step if you reuse the algorithm, or you'll see stray pixels above the cut-out).
4. Auto-crop to the surviving subject's bounding box (+2px pad).

`Studio` (in `studio.js`) is a thin modal wrapper: shows a live preview canvas, a sensitivity slider (re-runs `removeBackground` on `input`), and a "place on canvas" button that hands back a `dataURL` + final width/height via a callback:
```js
studio.open(file, (dataURL, w, h) => { /* place it */ });
```

**Integration note**: the caller decides what "place it" means — in this app it's either `layer.add('image', { src: dataURL, w, h })` (normal item) or `bg.add('image', { src: dataURL })` (background region), selected by whether background-mode is toggled. See `scripts/main.js`'s `handlePhotoFile`.

**Take-photo-or-upload menu**: `index.html` has two separate `<input type="file">` elements — one with `capture="environment"` (opens the rear camera directly on mobile) and one without (opens the file/photo picker) — behind a small popup menu (`#photoMenu` in `main.js`). Camera capture **requires HTTPS** (or `localhost`) — it's silently unavailable over plain HTTP on a LAN IP.

---

## 6. Multi-canvas storage + home page

**Files**: `scripts/store.js` (data layer), `scripts/home.js` (UI)

`store.js` keeps a **registry** of canvases (`dc:canvases` → `[{id, name, createdAt}]`) plus one `localStorage` entry per canvas per data-kind:
```
dc:canvas:<id>:items   — that canvas's items (ItemLayer's data)
dc:canvas:<id>:bg      — that canvas's background regions (BackgroundLayer's data)
dc:me                  — { id, name, icon } profile, shared across canvases
```
`items` is a **live, mutable, exported binding** (`export let items = []`) that `openCanvas(id)` reassigns wholesale — `ItemLayer` reads/writes through this binding rather than owning its own array. If you integrate `ItemLayer` without this module, you need something structurally equivalent (a live reference plus a `save()` you control the debounce/backing-store of).

`home.js`'s `renderHome(container)` is a full imperative re-render (no diffing) — call it again after any mutation. It covers: profile editing, canvas tiles (create/rename/delete/open), and courtyard tiles + "invite" entry point (§7).

**One-time migration**: `migrate()` moves the old single-canvas app's data (`digital-courtyard:v1` / `digital-courtyard:bg:v1` keys, pre-dating the multi-canvas refactor) into a canvas named "My canvas" the first time it runs. Irrelevant if you're integrating fresh — only matters for *this* app's own upgrade path.

---

## 7. Courtyard (two-person shared space) — ⚠️ partially stubbed

**Files**: `courtyardcreationlogic.js` (model + invites), `scripts/courtyard.js` (UI), plus `events/`, `pending-requests/`, `rules/` (placeholders).

**Read this before integrating**: everything here is **local-only** (`localStorage`). The invite-link flow (`#/join/<token>`) works end-to-end *within one browser* as a structural demo, but does **not** sync across two different devices/browsers — there's no backend. If you want real two-person courtyards, you need to swap the `localStorage` read/writes in `courtyardcreationlogic.js` for a shared store (Firestore, Supabase, etc.); the function signatures were deliberately kept small and pure (`listCourtyards() / getCourtyard(id) / saveCourtyard(c) / createInvite(canvasId) / consumeInvite(token, canvasId)`) so that swap is mechanical.

### Data model
```js
// a courtyard
{
  id, name, createdAt,
  void: { shape: 'circle' },              // default shape of the shared center
  members: [
    { userId, name, icon, canvasId, zone: { size: 1, items: [] } },  // member A
    { userId, name, icon, canvasId, zone: { size: 1, items: [] } },  // member B
  ],
  events: [], pending: [], rules: [],      // shared, void-only — currently unused placeholders
}

// an invite (one-time link)
{ token, from: {id, name, icon}, canvasId, createdAt, used }
```

### API
| Function | Purpose |
|---|---|
| `createCourtyard(userA, canvasA, userB, canvasB)` | Build the model above |
| `createInvite(canvasId)` → `{ token, url }` | Mint a private link (`#/join/<token>`), tied to one of your canvases |
| `consumeInvite(token, joinerCanvasId)` | One-time use — marks it used, builds the courtyard pairing inviter + joiner |
| `saveCourtyard(c)` | Upsert |

### UI (`courtyard.js`)
- Renders a `.courtyard-stage` grid: member A's half — void — member B's half.
- Each half: a big icon button (click → `go('canvas/' + member.canvasId)`, routes into that member's actual `ItemLayer` canvas) + a zone-size range slider (`member.zone.size`, 0.6–1.4) that currently only scales the icon's font-size — **the "arrange preview items around your icon, closer-to-icon vs. closer-to-void" interaction described in planning was never built**; `zone.items` exists in the data model as a placeholder array but nothing populates or renders it yet. That's the biggest gap if you're picking this feature up.
- The void (`.void`) renders the three placeholder panels by calling `renderEvents(courtyard)`, `renderPending(courtyard)`, `renderRules(courtyard)` — each currently returns a static "coming soon"-style `<div>`. They're separated into their own folders specifically so each can be built out independently without touching the others.

**If you only want the "two canvases + shared void" shell without the invite-link machinery**: you can call `createCourtyard(...)` directly (skip `createInvite`/`consumeInvite`) and route straight to `#/courtyard/<id>`.

---

## 8. Routing

**File**: `scripts/router.js` — ~15 lines, no dependencies.

```js
startRouter({
  "": showHome,
  canvas: showCanvas,       // called with the id segment: #/canvas/<id>
  courtyard: showCourtyard,
  join: showJoin,
});
go("canvas/" + id); // navigate — just sets location.hash
```
First path segment picks the handler; everything after the first `/` is passed as a single string argument (no nested route params beyond that). Trivial to lift wholesale or replace with a real router (React Router, etc.) if your host app already has one — the handlers here are the integration seam (`showHome`/`showCanvas`/`showCourtyard`/`showJoin` in `main.js`).

---

## 9. PWA / installability

**Files**: `manifest.webmanifest`, `sw.js`, `icons/*.png`

Standard installable-web-app setup: manifest (name/icons/theme color/`display: standalone`), a service worker (network-first fetch with cache fallback, so it still opens with no signal), and iOS-specific `<meta>` tags in `index.html`'s `<head>` (`apple-touch-icon`, `apple-mobile-web-app-capable`, etc. — iOS Safari ignores most of the manifest, these fill the gap). **Requires HTTPS** to install and for camera access (`localhost` is exempt for local dev).

`sw.js`'s `ASSETS` array is a hardcoded list of every file to precache — **you must update it whenever you add/remove a source file**, or the cached offline copy will miss (or 404 on) new files. Bump `CACHE` (currently `courtyard-v2`) on any asset-list change so returning visitors actually pick up the new cache instead of serving stale content indefinitely.

---

## 10. Quick reference — what to copy for what

| I want... | Copy these files | Also needs |
|---|---|---|
| Just the infinite pan/zoom canvas | `scripts/viewport.js` | nothing |
| Shapes/text/drawing/nested-notes on a canvas | `viewport.js` + `scripts/items.js` | a `store.js`-shaped data layer (or adapt one) |
| The photo-cutout algorithm only | `scripts/extract.js` | nothing (pure canvas API) |
| The full cutout UI (slider + preview) | `extract.js` + `scripts/studio.js` | a modal container in your HTML matching `studio.js`'s `#studio*` element ids |
| Selective/whole-screen backgrounds | `background/background.js` + `.css` | `viewport.js`; drop the `parentId`/grouped-background methods if you don't have an `ItemLayer` to bind to |
| Per-item fill opacity | (already inside `items.js`) `_applyFill`/`setOpacity`/`FILL_RGB`/`DEFAULT_OPACITY` | — |
| Multi-canvas home page | `store.js` + `home.js` + `router.js` | — |
| The courtyard shell (no real backend) | `courtyardcreationlogic.js` + `courtyard.js` | swap its `localStorage` calls for a real backend before relying on cross-device sync |
| PWA installability | `manifest.webmanifest`, `sw.js`, `icons/`, the `<head>` meta tags | HTTPS hosting |

---

## Known gaps (don't assume these are done)

1. **Courtyard preview-items arranging** — described in planning, never implemented (see §7).
2. **Events / Pending requests / Rules** — placeholder render functions only, no real data/interaction.
3. **No cross-device sync anywhere** — the entire app is `localStorage`. Invite links, courtyards, canvases: all single-browser.
4. **Invite flow picks your *first* canvas automatically** — `home.js`'s `startInvite()` doesn't let you choose which canvas to share; flagged in a code comment, not fixed.
