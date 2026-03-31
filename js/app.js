// ─── APP ───────────────────────────────────────────────────────────────────────
// Map initialization, target placement, waiver, and application bootstrap.
// This file is loaded last and wires everything together.
// Depends on: all other modules

// ── Leaflet map ───────────────────────────────────────────────────────────────

const map = L.map('map', {zoomControl: false, attributionControl: false}).setView([36.0, -86.5], 13);

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
  // Reset manual heading if moving more than 1 mile from current target
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
  state.target  = {lat, lng};
  state.pattern = null;
  state.fitDone = false;
  clearPattern();
  if (targetMarker) map.removeLayer(targetMarker);
  targetMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      html: `<div style="width:18px;height:18px;background:var(--accent);border-radius:50%;border:3px solid #fff;box-shadow:0 0 8px rgba(232,244,77,0.6);"></div>`,
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

// ── Waiver ────────────────────────────────────────────────────────────────────

function checkWaiver() {
  try {
    if (localStorage.getItem('pp_waiver_version') === WAIVER_VERSION) return;
  } catch(e) {}
  document.getElementById('waiver-modal').style.display = 'flex';
}

function agreeToWaiver() {
  try { localStorage.setItem('pp_waiver_version', WAIVER_VERSION); } catch(e) {}
  document.getElementById('waiver-modal').style.display = 'none';
}

function declineWaiver() {
  const modal = document.getElementById('waiver-modal');
  modal.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-family:sans-serif;font-size:14px;text-align:center;padding:20px;">You must agree to the terms to use Pattern Planner.</div>';
}

// ── Init sequence ─────────────────────────────────────────────────────────────

initStorage();   // version-check and wipe stale data first
loadWindCache(); // restore wind cache from localStorage into memory
checkWaiver();
loadSettings();
updateCanopyCalc();

// Persist on any input/change
document.querySelectorAll('input').forEach(el => {
  el.addEventListener('change', saveSettings);
  el.addEventListener('input',  saveSettings);
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
      fetchWinds(true).then(calculate).finally(() => {
        setTimeout(() => {
          indicator.textContent = '↓ Release to refresh winds';
          indicator.classList.remove('visible');
        }, 1200);
      });
    }
  }, {passive: true});
})();

window.addEventListener('resize', () => { if (state.surfaceWind) updateWindPyramid(); updateJrPyramid(); });
setTimeout(() => map.invalidateSize(), 300);

// Immediately check wind freshness when tab becomes visible (e.g. after sleep or switching tabs)
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.target) return;
  const cached = findCachedWinds(state.target.lat, state.target.lng);
  if (cached) updateWindStatusAge(cached.ts);
  else fetchWinds().then(calculate);
});
