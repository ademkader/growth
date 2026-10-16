// Offline support: the app's own files are cached; sync requests to Google are never cached.
const VERSION = "growth-v1";
const SHELL = [
  "./", "./index.html", "./app.js", "./who-data.js", "./chart.umd.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-192.png", "./icons/maskable-512.png",
  "./fonts/atkinson-hyperlegible-latin-400-normal.woff2", "./fonts/atkinson-hyperlegible-latin-700-normal.woff2",
  "./fonts/bricolage-grotesque-latin-500-normal.woff2", "./fonts/bricolage-grotesque-latin-700-normal.woff2"
];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Serve from cache straight away (works offline), refresh the cache in the background for next launch.
  e.respondWith(caches.open(VERSION).then(async cache => {
    const key = req.mode === "navigate" ? "./index.html" : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(req).then(res => { if (res && res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    const res = await network;
    return res || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }));
});
