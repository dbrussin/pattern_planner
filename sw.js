// ─── Pattern Planner Service Worker ────────────────────────────────────────────
// Cache-first for app shell; pass-through for weather APIs and map tiles.
// Bump CACHE_NAME when deploying updated app files.

const CACHE_NAME = 'pp-shell-v1';

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

  // Cache-first for everything else (app shell + CDN assets)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request).then(resp => {
        // Only cache successful responses from known-safe origins
        if (resp.ok && (url.origin === self.location.origin || url.hostname === 'unpkg.com')) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return resp;
      });
    }).catch(() => {
      // Offline fallback: serve the app shell HTML for navigation requests
      if (e.request.mode === 'navigate') {
        return caches.match('./dz-pattern.html');
      }
    })
  );
});
