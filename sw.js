/* Service worker: offline app shell + Background Sync of the outbox. */
/* global Outbox */
importScripts('outbox.js');

const SHELL = 'spikeA-shell-v3';
const FILES = ['./', 'index.html', 'app.js', 'outbox.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Same-origin GET: cache first (app opens with no signal). Everything else: straight to network.
self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) { return hit || fetch(e.request); }));
});

// Chromium only. The browser fires this when connectivity returns, even if the tab is closed.
self.addEventListener('sync', function (e) {
  if (e.tag !== 'outbox-sync') return;
  e.waitUntil(Outbox.sync('background-sync').then(function (r) {
    return self.clients.matchAll().then(function (cs) { cs.forEach(function (c) { c.postMessage({ type: 'synced', result: r }); }); })
      .then(function () {
        // Throwing makes the browser retry later with backoff.
        if (r.state === 'network_error' || r.state === 'busy') throw new Error(r.state);
      });
  }));
});
