// Service worker for Double Twenty Starter.
// Bump VERSION whenever you change this file. The app page itself is always
// fetched fresh when online (network first), so normal app updates show up
// straight away; the saved copy is only used when you're offline.
const VERSION = 'dt-starter-v1';
const PAGE = '/son';
const CORE = [PAGE, '/son.webmanifest', '/son-icon-192.png', '/son-icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(CORE.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The app page: network first, fall back to the saved copy when offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected) {
          const cache = await caches.open(VERSION);
          cache.put(PAGE, res.clone());
        }
        return res;
      } catch (err) {
        return (await caches.match(PAGE)) || Response.error();
      }
    })());
    return;
  }

  // Icons, manifest and Google Fonts: use the saved copy, refresh it in the background.
  const sameOriginAsset = url.origin === self.location.origin && CORE.includes(url.pathname);
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (sameOriginAsset || font) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
