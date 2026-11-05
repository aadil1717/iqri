/*! Isolation response wrapping adapted from coi-serviceworker v0.1.7 (MIT).
 * Copyright (c) 2021 Guido Zuidhof.
 * Source: gzuidhof/coi-serviceworker@7b1d2a092d0d2dd2b7270b6f12f13605de26f214
 * Full notice: /licenses/coi-serviceworker-LICENSE.txt
 */
const CACHE = 'iqri-shell-v4';
const SHELL = ['/', '/index.html', '/styles.css', '/words.css', '/app.js', '/icon.svg', '/manifest.webmanifest', '/mic-worklet.js', '/data/catalog.json', '/data/quran.json', '/data/en-itani-allah.json'];
// Cache public application assets only. Recognition requests, authentication
// routes and local evaluation recordings never belong in the offline shell.
const cacheablePath = pathname => SHELL.includes(pathname) ||
  ['/privacy.html', '/terms.html', '/recognition-worker.js'].includes(pathname) ||
  /^\/(?:data|ort|fonts|licenses)\//u.test(pathname);

function isolated(response) {
  if (!response || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('iqri-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('message', event => {
  if (event.data?.type === 'iqri-capabilities') event.ports[0]?.postMessage({ version: 4, isolation: true });
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/models/') || url.pathname.startsWith('/fixtures/')) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok && cacheablePath(url.pathname)) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {}));
    }
    return isolated(response);
  }).catch(async () => isolated(await caches.match(request) || new Response('Offline resource unavailable', { status: 503 }))));
});
