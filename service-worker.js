/**
 * service-worker.js
 * ------------------------------------------------------------
 * Flat-deployment version — this project has been consolidated
 * into 4 root-level files (index.html, app.bundle.js,
 * manifest.json, service-worker.js) specifically so it can be
 * uploaded to GitHub Pages via a single multi-file picker, with
 * no folders and no binary images to upload (icons are inlined
 * as base64 data URIs in index.html and manifest.json instead).
 *
 * Precaches the whole app shell on install so it works fully
 * offline after the first load. Only activates over HTTPS (or
 * http://localhost) — browsers refuse service workers on file://
 * pages by design.
 *
 * Bump CACHE_NAME whenever any of these files change, so
 * returning visitors get the new version instead of a stale cache.
 * ------------------------------------------------------------
 */

const CACHE_NAME = 'adaptive-os-v5';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './app.bundle.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        const isSameOrigin = new URL(event.request.url).origin === location.origin;
        if (isSameOrigin && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return undefined;
      });
    })
  );
});
