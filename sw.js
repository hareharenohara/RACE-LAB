const CACHE_NAME = "race-lab-shell-v1";
const SHELL = [
  "/index.html", "/styles.css", "/ui.css", "/analytics-core.js", "/app.js",
  "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png",
  "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/offline.html"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
