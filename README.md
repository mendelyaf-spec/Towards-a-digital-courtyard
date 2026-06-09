# The Digital Courtyard

An infinite canvas you can wander. Drop shapes, cut subjects out of photos and
place them, draw and write on anything, attach notes that expand and collapse
(to any depth), and lay translucent backgrounds behind your content.

It's plain HTML/CSS/JS with **no build step** — just static files using ES
modules. Because browsers block ES modules loaded over `file://`, you need to
serve the folder over HTTP (opening `index.html` directly will *not* work).

## Run it locally

From the project root, pick whichever you have:

**Python 3** (already on most machines):

```bash
python3 -m http.server 8000
```

**Node** (no install):

```bash
npx serve -l 8000
```

Then open <http://localhost:8000> in your browser.

To stop the server, press `Ctrl+C` in that terminal.

### Open it on your phone (same Wi-Fi)

1. Find your computer's LAN IP (`ipconfig` on Windows, `ipconfig getifaddr en0`
   on macOS, or `hostname -I` on Linux).
2. With the server running, visit `http://<that-ip>:8000` on your phone.
3. The "cut from photo" tool will offer your camera.

## What's where

| Area | Lives in |
|------|----------|
| Page shell (home / canvas / courtyard views) | `index.html` |
| Look & feel | `styles/main.css` |
| App shell + routing wiring | `scripts/main.js`, `scripts/router.js` |
| Home page (your named canvases + courtyards) | `scripts/home.js` |
| Multi-canvas storage + profile | `scripts/store.js` |
| Infinite canvas (pan / zoom / pinch) | `scripts/viewport.js` |
| Items: shapes, text, draw, attach/expand | `scripts/items.js` |
| Photo → cut-out shape extraction | `scripts/extract.js`, `scripts/studio.js` |
| Selective backgrounds (place, rotate, set behind content) | `background/` |
| Courtyard creation + invites | `courtyardcreationlogic.js` |
| Courtyard page (void + two halves) | `scripts/courtyard.js` |
| Shared void interactions (placeholders) | `events/`, `pending-requests/`, `rules/` |
| Installable app | `manifest.webmanifest`, `sw.js`, `icons/` |
