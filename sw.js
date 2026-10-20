// Opens the app instantly: the page, fonts and icons come from this device first and are refreshed
// in the background, so a new version shows up on the next open. Stats requests to Supabase are never
// touched here (they're on another site); the page keeps its own saved copy of those.
const CACHE = "brawl-stats-v1";
const SHELL = ["./", "manifest.webmanifest", "icon-192.png", "favicon-32.png",
  "fonts/chakra-petch-latin-500-normal.woff2", "fonts/chakra-petch-latin-600-normal.woff2", "fonts/chakra-petch-latin-700-normal.woff2",
  "fonts/jetbrains-mono-latin-500-normal.woff2", "fonts/jetbrains-mono-latin-700-normal.woff2"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // Every visit to the app (with or without ?query) uses the one saved copy of the page.
  const key = req.mode === "navigate" ? new URL("./", self.registration.scope).href : url.origin + url.pathname;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(key);
    const fresh = fetch(req).then((res) => {
      if (res.ok && res.type === "basic") cache.put(key, res.clone()).catch(() => {});
      return res;
    });
    if (saved) {
      event.waitUntil(fresh.catch(() => {}));
      return saved;
    }
    return fresh;
  })());
});
