// sw.js — service worker so app updates propagate automatically (no cache
// clearing) while keeping the app fast and usable offline.
//
// Strategy:
//   * app code (HTML / JS / CSS) -> NETWORK-FIRST: always the latest version
//     when online; falls back to the cached copy only when offline.
//   * big vendored libraries (/vendor/) -> STALE-WHILE-REVALIDATE: served from
//     cache instantly (no re-downloading Plotly every load) and refreshed in
//     the background, so a bumped library still updates on the next visit.
//
// To DISABLE the service worker later: replace this file's contents with
//   self.addEventListener('install', () => self.skipWaiting());
//   self.addEventListener('activate', async () => {
//     for (const k of await caches.keys()) await caches.delete(k);
//     await self.registration.unregister();
//     for (const c of await self.clients.matchAll()) c.navigate(c.url);
//   });
// push it, and every client will unregister on its next load.

const CACHE = "ncx-cache-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // vendored -> all same-origin

  if (url.pathname.includes("/vendor/")) {
    // stale-while-revalidate
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const fetching = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await fetching) || new Response("", { status: 504 });
    })());
  } else {
    // network-first (app shell): fresh when online, cache when offline
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        return (await cache.match(req)) || Response.error();
      }
    })());
  }
});
