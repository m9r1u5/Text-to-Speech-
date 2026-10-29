'use strict';
// Service worker: lets the web/iPhone version work offline.
// App files are cached per version. Voice models and libraries go in a separate
// cache that is kept across updates, so a new version never re-downloads 130 MB.
const VERSION = '__VERSION__';
const SHELL = 'offline-reader-shell-' + VERSION;
const ASSETS = 'offline-reader-assets-v1';
const SHELL_FILES = ['./', 'index.html', 'styles.css', 'config.js', 'app.js', 'tts-worker.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.indexOf('offline-reader-shell-') === 0 && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

function isBig(url) { return /\/(lib|models)\//.test(url.pathname); }
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (/(version|files)\.json$/.test(url.pathname)) return; // always go to the network
  if (isBig(url)) {
    // Serve saved voices/engine files when we have them. Otherwise do nothing, so the browser
    // downloads them itself (a service worker can be stopped mid-download on iPhone).
    e.respondWith(caches.open(ASSETS).then((c) => c.match(req, { ignoreSearch: true })).then((hit) => hit || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
