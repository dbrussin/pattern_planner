// ─── APP ───────────────────────────────────────────────────────────────────────
// Map initialization, target placement, waiver, and application bootstrap.
// This file is loaded last and wires everything together.
// Depends on: all other modules

// ── Leaflet map ───────────────────────────────────────────────────────────────

const map = L.map('map', {
  zoomControl: false,
  attributionControl: false,
  zoomSnap: 0.1,          // fractional zoom levels — key for smooth trackpad pinch
  wheelDebounceTime: 20,  // default 40ms; lower = more responsive to trackpad
}).setView([36.0, -86.5], 13);

const tileSources = [
  {url: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',                                              opts: {subdomains: '0123', maxZoom: 21, attribution: '© Google'}},
  {url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',      opts: {maxZoom: 20, attribution: '© Esri'}},
  {url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',                                                 opts: {maxZoom: 19, attribution: '© OpenStreetMap'}},
];
let tileIdx = 0, tileErrorCount = 0;
let tileLayer = L.tileLayer(tileSources[0].url, tileSources[0].opts).addTo(map);

function registerTileErrorHandler() {
  tileLayer.on('tileerror', () => {
    // Switch providers after 3 consecutive errors to avoid flipping on transient failures
    if (++tileErrorCount >= 3 && tileIdx + 1 < tileSources.length) {
      tileErrorCount = 0;
      map.removeLayer(tileLayer);
      tileIdx++;
      tileLayer = L.tileLayer(tileSources[tileIdx].url, tileSources[tileIdx].opts).addTo(map);
      registerTileErrorHandler();
    }
  });
}
registerTileErrorHandler();

L.control.zoom({position: 'bottomright'}).addTo(map);
navigator.geolocation?.getCurrentPosition(p => map.setView([p.coords.latitude, p.coords.longitude], 14), () => {});

let targetMarker = null, patternLayers = [];
map.on('click', e => placeTarget(e.latlng.lat, e.latlng.lng));

// ── Target placement ──────────────────────────────────────────────────────────

/**
 * Set a new landing target, fetch elevation and winds, then calculate the pattern.
 * Resets manual heading, jump run heading, and forecast offset when moved more than 1 mile.
 * @param {number} lat - Target latitude (decimal degrees)
 * @param {number} lng - Target longitude (decimal degrees)
 */
async function placeTarget(lat, lng) {
  // Reset manual settings if moving more than 1 mile from current target
  if (state.target && distMiles(state.target, {lat, lng}) > 1.0) {
    state.manualHeading  = false;
    state.manualJumpRun  = false;
    state.jumpRunHdgDeg  = null;
    state.manualJrOffset = false;
    state.forecastOffset = 0;
    const fo = document.getElementById('forecast-offset');
    if (fo) fo.value = 0;
    const fl = document.getElementById('forecast-offset-label');
    if (fl) fl.textContent = 'Now';
  }

  // Unlock DZ zero when moving to a different grid cell (non-nearby target)
  if (state.target && cacheKey(state.target.lat, state.target.lng) !== cacheKey(lat, lng)) {
    state.manualDzZero = false;
  }

  // Update DZ zero point if not manually set, and new position is in a different grid cell
  if (!state.manualDzZero) {
    const zLatEl = document.getElementById('dz-zero-lat');
    const zLngEl = document.getElementById('dz-zero-lng');
    const curZeroKey = (zLatEl && zLngEl && zLatEl.value !== '' && zLngEl.value !== '')
      ? cacheKey(parseFloat(zLatEl.value), parseFloat(zLngEl.value))
      : null;
    if (curZeroKey === null || curZeroKey !== cacheKey(lat, lng)) {
      if (zLatEl) zLatEl.value = lat.toFixed(6);
      if (zLngEl) zLngEl.value = lng.toFixed(6);
      if (typeof updateMagDeclination === 'function') updateMagDeclination();
    }
  }

  // Update landing spot lat/lon display
  const latEl = document.getElementById('landing-lat');
  const lngEl = document.getElementById('landing-lng');
  if (latEl) latEl.value = lat.toFixed(6);
  if (lngEl) lngEl.value = lng.toFixed(6);

  state.target  = {lat, lng};
  state.pattern = null;
  state.fitDone = false;
  clearPattern();
  if (targetMarker) map.removeLayer(targetMarker);
  targetMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      html: `<div class="target-marker-dot"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9], className: '',
    }), zIndexOffset: 1000,
  }).addTo(map);
  document.getElementById('map-hint').style.display = 'none';
  document.getElementById('fetch-btn').disabled     = false;
  showLegend();
  collapseSearch();
  setStatus('Fetching elevation & winds…', true);
  await fetchElevation(lat, lng);
  await fetchWinds();
  calculate();
}

// ── Invite code gate ──────────────────────────────────────────────────────────

function checkInviteCode() {
  try { if (localStorage.getItem('pp_invite_verified') === '1') return; } catch(e) {}
  document.getElementById('invite-modal').style.display = 'flex';
}

function verifyInviteCode() {
  const inp = document.getElementById('invite-input');
  const err = document.getElementById('invite-error');
  if (!inp) return;
  if (inp.value.trim().toUpperCase() === _IC) {
    try { localStorage.setItem('pp_invite_verified', '1'); } catch(e) {}
    document.getElementById('invite-modal').style.display = 'none';
    checkWaiver();
  } else {
    if (err) { err.textContent = 'Invalid invite code.'; err.style.display = 'block'; }
    inp.value = '';
    inp.focus();
  }
}

// ── Waiver ────────────────────────────────────────────────────────────────────

function checkWaiver() {
  try { if (localStorage.getItem('pp_invite_verified') !== '1') return; } catch(e) {}
  try { if (localStorage.getItem('pp_waiver_version') === WAIVER_VERSION) return; } catch(e) {}
  document.getElementById('waiver-modal').style.display = 'flex';
}

function agreeToWaiver() {
  try { localStorage.setItem('pp_waiver_version', WAIVER_VERSION); } catch(e) {}
  document.getElementById('waiver-modal').style.display = 'none';
}

function declineWaiver() {
  const modal = document.getElementById('waiver-modal');
  modal.innerHTML = '<div class="waiver-decline-message">You must agree to the terms to use Pattern Planner.</div>';
}

// ── Init sequence ─────────────────────────────────────────────────────────────

initStorage();       // version-check and wipe stale data first
loadWindCache();     // restore wind cache from localStorage into memory
checkInviteCode();   // invite gate — must verify before waiver
checkWaiver();
loadSettings();
updateCanopyCalc();

// Persist on any input/change — debounce keystroke events to avoid saving on every character
const _debouncedSave = debounce(saveSettings, 300);
document.querySelectorAll('input').forEach(el => {
  el.addEventListener('change', saveSettings);    // change fires on commit — save immediately
  el.addEventListener('input',  _debouncedSave);  // input fires on every keystroke — debounce
});

// ── Pull-to-refresh — pull down on the header bar ────────────────────────────

(function() {
  const PULL_THRESHOLD = 70; // px needed to trigger refresh
  let startY = 0, pulling = false;
  const indicator = document.getElementById('pull-indicator');
  const header    = document.getElementById('header');

  document.addEventListener('touchstart', e => {
    if (header && header.contains(e.target)) {
      startY  = e.touches[0].clientY;
      pulling = true;
    }
  }, {passive: true});

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 10) indicator.classList.add('visible');
    else indicator.classList.remove('visible');
  }, {passive: true});

  document.addEventListener('touchend', e => {
    if (!pulling) return;
    pulling = false;
    const dy = (e.changedTouches[0]?.clientY ?? 0) - startY;
    indicator.classList.remove('visible');
    if (dy >= PULL_THRESHOLD && state.target) {
      indicator.textContent = '⟳ Refreshing winds…';
      indicator.classList.add('visible');
      fetchWinds(true)
        .then(calculate)
        .catch(e => console.error('Pull-to-refresh failed:', e))
        .finally(() => {
          setTimeout(() => {
            indicator.textContent = '↓ Release to refresh winds';
            indicator.classList.remove('visible');
          }, 1200);
        });
    }
  }, {passive: true});
})();

// ── Restore previous value when text/number input is cleared then blurred/Enter ──

document.addEventListener('focusin', e => {
  const el = e.target;
  if (el.tagName !== 'INPUT' || el.type === 'checkbox' || el.type === 'range') return;
  el.dataset.prefocus = el.value;
});

document.addEventListener('focusout', e => {
  const el = e.target;
  if (el.tagName !== 'INPUT' || el.type === 'checkbox' || el.type === 'range') return;
  if (el.value !== '' || el.dataset.allowEmpty === 'true') return;
  const prev = el.dataset.prefocus;
  if (prev === undefined || prev === '') return;
  el.value = prev;
  el.dispatchEvent(new Event('input', {bubbles: true}));
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const el = e.target;
  if (el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'range') el.blur();
});

window.addEventListener('resize', () => { if (state.surfaceWind) updateWindPyramid(); updateJrPyramid(); });
setTimeout(() => map.invalidateSize(), 300);

// Immediately check wind freshness when tab becomes visible (e.g. after sleep or switching tabs)
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.target) return;
  const cached = findCachedWinds(state.target.lat, state.target.lng);
  if (cached) updateWindStatusAge(cached.ts);
  else fetchWinds().then(calculate);
});

// ── PWA: service worker + persistent storage ──────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.info('[PWA] Service worker registration failed:', err);
    });
    // Reload once when a new SW takes control so users pick up fresh code
    // without having to manually hard-refresh.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}

// Request persistent storage so iOS doesn't purge localStorage on inactivity.
// navigator.storage.persist() is available in iOS 15.4+ for installed PWAs.
if (navigator.storage?.persist) {
  navigator.storage.persist().then(granted => {
    if (!granted) console.info('[PWA] Persistent storage not granted — data may be evicted after ~7 days of inactivity on iOS');
  });
}

// ── Android/Chrome install prompt ─────────────────────────────────────────────

let _installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  // Don't show the banner if already running as installed PWA
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.remove('is-hidden');
});

function pwaInstall() {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  _installPrompt.userChoice.then(() => { _installPrompt = null; });
  pwaDismiss();
}

function pwaDismiss() {
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('is-hidden');
}
