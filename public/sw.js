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

const VERSION = 'pb-v19';
/* Only the walk-up print site is cached: a phone that scanned the QR keeps
 * working on a flaky connection. The marketing site is not cached: it is not
 * what anyone needs when the network is down. The console is not cached either
 * because it is not served from here at all — it lives in the desktop app. */
const SHELL = [
  '/print/',
  '/print/index.html',
  '/print/print.css',
  '/print/print.js',
  '/assets/icon.svg',
  '/assets/icon-192.png',
];
const SHELL_DOCUMENT = '/print/index.html';

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

  /* The machine console used to be served from /admin and had to be kept out of
   * every cache. It is not served here at all any more — it lives in the desktop
   * app — so this worker only ever deals with the guest surfaces below. */

  // Documents: network first, cache only as an offline fallback. Only the
  // print site may be answered offline — anything else (the marketing site)
  // just fails like it normally would rather than serving the wrong page.
  if (request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    if (!url.pathname.startsWith('/print')) return;
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok && url.pathname.startsWith('/print')) {
          const cache = await caches.open(VERSION);
          cache.put(SHELL_DOCUMENT, fresh.clone()).catch(() => undefined);
        }
        return fresh;
      } catch {
        const cache = await caches.open(VERSION);
        const cached = (await cache.match('/print/')) || (await cache.match(SHELL_DOCUMENT));
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
