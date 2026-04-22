// ─── Pattern Planner Service Worker ────────────────────────────────────────────
// Network-first for app shell (so deploys take effect on next load); cache only
// rescues offline. Pass-through for weather APIs and map tiles.

const CACHE_NAME = 'pp-shell-v2';

// App shell — everything needed to render offline (APIs still need network)
const SHELL = [
  './dz-pattern.html',
  './css/app.css',
  './js/config.js',
  './js/state.js',
  './js/storage.js',
  './js/geometry.js',
  './js/wind.js',
  './js/calculate.js',
  './js/draw.js',
  './js/ui-overlays.js',
  './js/ui-heading.js',
  './js/ui-canopy.js',
  './js/ui-legs.js',
  './js/ui-forecast.js',
  './js/search.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './manifest.json',
  // Leaflet (pinned version — safe to cache indefinitely)
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Install: precache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Precache failed:', err))
  );
});

// Activate: delete stale caches, claim all clients immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: decide strategy per request
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Pass-through: weather APIs, geocoding, map tiles
  // These are either time-sensitive or too large/numerous to cache here.
  if (
    url.hostname === 'api.open-meteo.com' ||
    url.hostname.endsWith('.open-meteo.com') ||
    url.hostname === 'nominatim.openstreetmap.org' ||
    url.hostname.match(/^mt\d?\.google\.com$/) ||
    url.hostname.endsWith('.arcgisonline.com') ||
    url.hostname.endsWith('.tile.openstreetmap.org') ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    return; // let the browser handle natively
  }

  const sameOrigin = url.origin === self.location.origin;
  const isUnpkg = url.hostname === 'unpkg.com';

  // Leaflet on unpkg is pinned — safe to serve cache-first.
  if (isUnpkg) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return resp;
      }))
    );
    return;
  }

  // Network-first for the app shell so deploys take effect immediately.
  // Falls back to cache only when offline.
  e.respondWith(
    fetch(e.request).then(resp => {
      if (resp.ok && sameOrigin) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return resp;
    }).catch(() => caches.match(e.request).then(cached => {
      if (cached) return cached;
      if (e.request.mode === 'navigate') return caches.match('./dz-pattern.html');
    }))
  );
});
