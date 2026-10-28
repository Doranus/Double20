// Service worker for Double Twenty (the main app at /).
// It only looks after the main app's own page and files, so the Starter
// app at /son keeps using its own service worker.
// The page is fetched fresh whenever you're online (network first),
// and the saved copy is used when you're offline.
const VERSION = 'double-twenty-v3-3';
const PAGE = '/';
const CORE = [PAGE, '/manifest.webmanifest', '/dt-icon-192.png', '/dt-icon-512.png', '/dt-apple-icon.png'];

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
    await Promise.all(keys.filter((k) => k.startsWith('double-twenty') && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isMainPage = url.origin === self.location.origin && (url.pathname === '/' || url.pathname === '/index.html');

  if (req.mode === 'navigate') {
    if (!isMainPage) return; // leave /son and anything else alone
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected) (await caches.open(VERSION)).put(PAGE, res.clone());
        return res;
      } catch (err) {
        return (await caches.match(PAGE)) || Response.error();
      }
    })());
    return;
  }

  const ownAsset = url.origin === self.location.origin && CORE.includes(url.pathname);
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (ownAsset || font) {
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
