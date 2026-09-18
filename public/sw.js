/* PrintBridge service worker — caches the app shell so the UI opens instantly
 * and keeps working when the network hiccups.
 *
 * Update safety (this matters): navigations are NETWORK-first, so a redeployed
 * server can never keep serving a stale shell out of the cache. Only static
 * assets use stale-while-revalidate. Any cache from an older version is purged
 * on activate, and open tabs are told to reload once so a running app never
 * keeps mixing old HTML with new modules.
 *
 * API calls and preview images are never cached — they are live state. */

const VERSION = 'pb-v11';
/* Only the guest app is cached: a phone that scanned the QR keeps working on a
 * flaky connection. The admin app is deliberately never cached — it must always
 * be the current build, and it is useless offline anyway. */
const SHELL = [
  '/',
  '/index.html',
  '/assets/app.css',
  '/assets/icon.svg',
  '/assets/icon-192.png',
  '/app/main.js',
  '/app/api.js',
  '/app/store.js',
  '/app/device.js',
  '/app/ui.js',
  '/app/theme.js',
  '/app/prefs.js',
  '/app/views/print.js',
  '/app/views/job.js',
  '/app/views/history.js',
  '/app/views/code.js',
];

/* True when we are replacing an older PrintBridge cache — i.e. the user is
 * upgrading, so a page may be running modules from a previous build. */
let isUpgrade = false;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    isUpgrade = keys.some(k => k !== VERSION);
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL).catch(() => undefined);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
    if (!isUpgrade) return;
    // An older build may still be on screen. Ask it to reload — and for pages
    // too old to have a listener, navigate them from here so nobody is left
    // running stale markup against the new modules.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'printbridge:activated', version: VERSION });
      setTimeout(() => client.navigate(client.url).catch(() => undefined), 400);
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'printbridge:skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // Live state: always the network.
  if (url.pathname.startsWith('/api/')) return;

  // The admin app is never cached or served from cache — including the shared
  // /app/* modules it imports, which must never be a version behind the admin
  // code that is using them.
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;
  try {
    if (new URL(request.referrer).pathname.startsWith('/admin')) return;
  } catch { /* no referrer — treat as a guest request */ }

  // Documents: network first, cache only as an offline fallback.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(VERSION);
          cache.put('/', fresh.clone()).catch(() => undefined);
        }
        return fresh;
      } catch {
        const cache = await caches.open(VERSION);
        const cached = (await cache.match('/')) || (await cache.match('/index.html'));
        return cached || Response.error();
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate (fast, and self-correcting).
  if (/\.(js|css|png|svg|webmanifest)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone()).catch(() => undefined);
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })());
  }
});
