// sw.js — service worker for the installed app.
// Network-first so you always get the latest when you have signal, with a
// cached copy as a fallback when you don't. Relative URLs keep it working
// whether the site is hosted at a domain root or a /repo/ subpath.

const CACHE = "courtyard-v52";
const ASSETS = [
  "./",
  "./index.html",
  "./styles/main.css",
  "./background/background.css",
  "./pocket/pocket.css",
  "./youtube/youtube.css",
  "./links/links.css",
  "./videoframe/videoframe.css",
  "./browser/browser.css",
  "./docviewer/docviewer.css",
  "./scripts/main.js",
  "./scripts/viewport.js",
  "./scripts/items.js",
  "./scripts/silhouette.js",
  "./scripts/store.js",
  "./scripts/undo.js",
  "./scripts/inlineedit.js",
  "./scripts/studio.js",
  "./scripts/extract.js",
  "./scripts/router.js",
  "./scripts/home.js",
  "./scripts/courtyard.js",
  "./courtyardcreationlogic.js",
  "./events/events.js",
  "./pending-requests/pending-requests.js",
  "./rules/rules.js",
  "./background/background.js",
  "./pocket/pocket.js",
  "./youtube/youtube.js",
  "./youtube/timednotes.js",
  "./links/links.js",
  "./videoframe/videoframe.js",
  "./browser/browser.js",
  // Same lazy split as magiccut: the small module is precached, the heavy
  // vendored PDF reader (~1.4MB) is fetched on first use and cached then.
  "./docviewer/docviewer.js",
  // magiccut's own module is tiny and statically imported, so precache it.
  // The heavy pieces (vendor runtime + model, ~16MB) deliberately are NOT:
  // they load lazily the first time a photo is opened and the fetch handler
  // below caches them at that point — offline works from then on, and the
  // classical extractor covers a first-ever visit that's already offline.
  "./magiccut/magiccut.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((c) => c || caches.match("./index.html")))
  );
});
