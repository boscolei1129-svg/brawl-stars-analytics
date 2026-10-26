// Opens the app instantly from an installed release of its page, script, fonts and icons.
// Bump CACHE whenever a shell file changes. The next release installs in full and activates
// after the app's existing tabs close, so old HTML never receives a new app.js. Game pictures (brawlers, profile icons,
// modes, maps) are kept on the device after their first download. Stats requests to Supabase are never
// touched here; the page keeps its own saved copy of those.
const CACHE = "brawl-stats-v3";
const ART_CACHE = "brawl-art-v1";
const ART_HOSTS = ["cdn.brawlify.com", "media.brawltime.ninja"];
const ART_MAX = 800;
const SHELL = ["./", "app.js", "manifest.webmanifest", "icon-192.png", "favicon-32.png",
  "fonts/chakra-petch-latin-500-normal.woff2", "fonts/chakra-petch-latin-600-normal.woff2", "fonts/chakra-petch-latin-700-normal.woff2",
  "fonts/jetbrains-mono-latin-500-normal.woff2", "fonts/jetbrains-mono-latin-700-normal.woff2"];

self.addEventListener("install", (event) => {
  // A failed download must fail installation, leaving the working release active.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((path) =>
    new Request(new URL(path, self.registration.scope).href, { cache: "reload" })))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("brawl-stats-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Game pictures don't change, so a saved copy is used without asking the network again.
async function artResponse(event) {
  const req = event.request;
  const cache = await caches.open(ART_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  let res;
  try { res = await fetch(req.url, { mode: "cors", credentials: "omit" }); } catch (e) { return fetch(req); }
  if (res.ok) event.waitUntil(cache.put(req.url, res.clone()).then(() => trimArt(cache)).catch(() => {}));
  return res;
}
async function trimArt(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - ART_MAX; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === "GET" && ART_HOSTS.includes(url.hostname)) { event.respondWith(artResponse(event)); return; }
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // Every visit to the app (with or without ?query) uses the one saved copy of the page.
  const key = req.mode === "navigate" ? new URL("./", self.registration.scope).href : url.origin + url.pathname;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(key);
    // Shell files stay together for this worker's lifetime. Revalidating them
    // separately can pair new markup with an older script (or the reverse).
    if (saved) return saved;
    return fetch(req);
  })());
});

// Notifications sent by the server (goals, milestones, members, nightly recap).
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "Brawl Stats", {
    body: d.body || "", tag: d.tag, icon: "icon-192.png", badge: "icon-192.png", data: { url: d.url || "./" },
  }));
});

// Tapping a notification opens the app on the matching tab (or brings it forward if it's already open).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if ("navigate" in w) await w.navigate(url).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
