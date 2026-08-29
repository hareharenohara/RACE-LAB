const CACHE_NAME = "race-lab-shell-v46";
const SHELL = [
  "/index.html", "/styles.css", "/ui.css", "/analytics-core.js", "/app.js",
  "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png",
  "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/offline.html"
];

self.addEventListener("install", event => {
  event.waitUntil(Promise.all([
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)),
    self.skipWaiting()
  ]));
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

self.addEventListener("push", event => {
  const data = event.data?.json() ?? {};
  event.waitUntil(self.registration.showNotification(data.title || "RACE LAB 的中", {
    body: data.body || "的中結果が確定しました",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || "race-lab-hit",
    renotify: false,
    data: { url: data.url || "/" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
    const existing = windows[0];
    if (existing) return existing.navigate(target).then(client => client.focus());
    return clients.openWindow(target);
  }));
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
  event.respondWith(fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
    }
    return response;
  }).catch(() => caches.match(request)));
});
