// Due service worker. Scope: the directory this file is served from (works under /<repo>/ on GitHub Pages).
//
// Shell updates reach installed copies without anyone bumping a number: shell files are served from the
// cache for an instant launch, then re-fetched in the background (stale-while-revalidate). When a re-fetched
// file differs from the cached copy, the cache is updated and open pages are told, so the app reloads the
// next time it comes to the foreground. VERSION only needs changing to force a full cache reset.
const VERSION = 3;
const SHELL = `due-shell-v${VERSION}`;
const DATA = 'due-data';
const SHELL_FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'time.js',
  'store.js',
  'ics.js',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/favicon-32.png',
];

const scoped = (p) => new URL(p, self.registration.scope).href;

self.addEventListener('install', (event) => {
  // A new worker waits; the page posts SKIP_WAITING when it is hidden, then reloads when it is shown again.
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((p) => new Request(scoped(p), { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('due-shell-') && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(self.registration.scope)) return;
  const path = url.href.slice(self.registration.scope.length).split(/[?#]/)[0];

  if (path === 'data.enc.json') { event.respondWith(dataNetworkFirst(event)); return; }
  if (path === 'data.json') return; // plaintext demo file: never cached

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const key = scoped('index.html');
      const cached = await caches.match(key, { cacheName: SHELL });
      if (cached) { revalidate(event, key); return cached; }
      return fetch(req);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { cacheName: SHELL, ignoreSearch: true });
    if (cached) { revalidate(event, url.origin + url.pathname); return cached; }
    return fetch(req);
  })());
});

/** Background re-fetch of one shell file; tells open pages when its bytes changed. */
function revalidate(event, href) {
  if (!SHELL_FILES.some((p) => scoped(p) === href)) return;
  event.waitUntil((async () => {
    try {
      const res = await fetch(href, { cache: 'no-cache', credentials: 'same-origin' });
      if (!res.ok || res.type !== 'basic') return;
      const cache = await caches.open(SHELL);
      const old = await cache.match(href);
      const fresh = new Uint8Array(await res.arrayBuffer());
      const prev = old ? new Uint8Array(await old.arrayBuffer()) : null;
      if (prev && prev.length === fresh.length && prev.every((b, i) => b === fresh[i])) return;
      const copy = () => new Response(fresh, { status: res.status, statusText: res.statusText, headers: res.headers });
      await cache.put(href, copy());
      if (href === scoped('index.html')) await cache.put(scoped('./'), copy());
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) c.postMessage({ type: 'SHELL_UPDATED' });
    } catch { /* offline: keep the cached copy */ }
  })());
}

async function dataNetworkFirst(event) {
  const req = event.request;
  const key = scoped('data.enc.json');
  try {
    const res = await fetch(req.url, { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok) {
      const copy = res.clone();
      // Keep the worker alive until the offline copy is written (iOS suspends idle workers quickly).
      event.waitUntil(caches.open(DATA).then((c) => c.put(key, copy)).catch(() => {}));
    }
    return res;
  } catch (err) {
    const cached = await caches.match(key, { cacheName: DATA });
    if (cached) {
      const body = await cached.blob();
      const headers = new Headers(cached.headers);
      headers.set('X-Due-Cache', '1');
      return new Response(body, { status: 200, headers });
    }
    return new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}
