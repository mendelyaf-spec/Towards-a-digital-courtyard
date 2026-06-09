// router.js — tiny hash router. URLs look like #/canvas/<id>, #/courtyard/<id>,
// #/join/<token>, or #/ (home). Routes are keyed by the first path segment.

export function go(path) {
  location.hash = "#/" + path;
}

export function startRouter(routes) {
  function handle() {
    const path = location.hash.replace(/^#\/?/, "");
    const [name, arg] = path.split("/");
    (routes[name] || routes[""])(arg);
  }
  window.addEventListener("hashchange", handle);
  handle();
}
