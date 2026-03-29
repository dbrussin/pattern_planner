// ─── STORAGE ───────────────────────────────────────────────────────────────────
// localStorage persistence for settings and wind cache.
// Depends on: state, config (CACHE_MS, STORAGE_VERSION, WAIVER_VERSION, PERSIST_INPUTS)

function storageKey(k) { return `pp_${k}`; }

// ── Settings save / load ──────────────────────────────────────────────────────

// Flag prevents saveSettings from firing during the loadSettings restore loop
let _loadingSettings = false;

function saveSettings() {
  if (_loadingSettings) return;
  try {
    PERSIST_INPUTS.forEach(id => {
      const el = document.getElementById(id);
      if (el && el.value !== '') localStorage.setItem(storageKey(id), el.value);
    });
    localStorage.setItem(storageKey('hand'),       state.hand);
    localStorage.setItem(storageKey('layers'),     JSON.stringify(state.layers));
    localStorage.setItem(storageKey('leg_modes'),  JSON.stringify(state.legModes));
    localStorage.setItem(storageKey('leg_custom'), JSON.stringify(state.legCustomPerf));
    localStorage.setItem(storageKey('z_pattern'),  String(state.zPattern));
    // Per-leg perf inputs
    ['dw', 'b', 'f'].forEach(leg => {
      ['glide', 'speed', 'sink'].forEach(field => {
        const el = document.getElementById(`${leg}-${field}`);
        if (el && el.value !== '') localStorage.setItem(storageKey(`${leg}_${field}`), el.value);
      });
    });
  } catch(e) { console.warn('saveSettings error:', e); }
}

function resetAllSettings() {
  if (!confirm('Reset all settings and clear saved data? You will need to agree to the terms again.')) return;
  try {
    Object.keys(localStorage).filter(k => k.startsWith('pp_')).forEach(k => localStorage.removeItem(k));
    // Explicitly remove waiver in case prefix filter missed it
    localStorage.removeItem('pp_waiver_version');
  } catch(e) {}
  location.reload();
}

function initStorage() {
  try {
    if (localStorage.getItem(storageKey('storage_version')) !== STORAGE_VERSION) {
      // Preserve waiver agreement across storage version changes
      const waiverAgreed = localStorage.getItem('pp_waiver_version');
      Object.keys(localStorage).filter(k => k.startsWith('pp_')).forEach(k => localStorage.removeItem(k));
      localStorage.setItem(storageKey('storage_version'), STORAGE_VERSION);
      if (waiverAgreed) localStorage.setItem('pp_waiver_version', waiverAgreed);
    }
  } catch(e) {}
}

function loadSettings() {
  _loadingSettings = true;
  try {
    // Numeric inputs
    PERSIST_INPUTS.forEach(id => {
      const val = localStorage.getItem(storageKey(id));
      const el  = document.getElementById(id);
      if (val !== null && el) { el.value = val; el.style.color = 'var(--text)'; }
    });

    // Hand
    const hand = localStorage.getItem(storageKey('hand'));
    if (hand === 'left' || hand === 'right') setHand(hand);

    // Leg modes
    const legModesStr = localStorage.getItem(storageKey('leg_modes'));
    if (legModesStr) {
      const saved = JSON.parse(legModesStr);
      ['dw', 'b', 'f'].forEach(leg => {
        if (['crab', 'drift'].includes(saved[leg])) setLegMode(leg, saved[leg]);
      });
    }

    // Z pattern
    const zp = localStorage.getItem(storageKey('z_pattern'));
    if (zp === 'true') {
      state.zPattern = true;
      const cb = document.getElementById('dw-z-check');
      if (cb) cb.checked = true;
    }

    // Per-leg custom perf flags and values
    const legCustomStr = localStorage.getItem(storageKey('leg_custom'));
    if (legCustomStr) {
      const saved = JSON.parse(legCustomStr);
      ['dw', 'b', 'f'].forEach(leg => {
        if (saved[leg]) {
          const cb = document.getElementById(`${leg}-custom-perf`);
          if (cb) cb.checked = true;
          state.legCustomPerf[leg] = true;
          const section = document.getElementById(`${leg}-perf`);
          if (section) section.style.display = 'block';
        }
        ['glide', 'speed', 'sink'].forEach(field => {
          const val = localStorage.getItem(storageKey(`${leg}_${field}`));
          const el  = document.getElementById(`${leg}-${field}`);
          if (val !== null && el) { el.value = val; el.style.color = 'var(--text)'; }
        });
      });
    }

    // Sync state.driftThresh from persisted input value
    const dtEl = document.getElementById('drift-thresh');
    if (dtEl && dtEl.value !== '') state.driftThresh = parseInt(dtEl.value) || 5;

    // Layer visibility — done last so setHand/setLegMode don't clobber pp_layers
    const layersStr = localStorage.getItem(storageKey('layers'));
    if (layersStr) {
      const saved = JSON.parse(layersStr);
      Object.keys(state.layers).forEach(name => {
        if (name in saved) {
          state.layers[name] = !!saved[name];
          const btn = document.getElementById(`layer-${name}`);
          if (btn) {
            btn.classList.toggle('active', state.layers[name]);
            btn.textContent = state.layers[name] ? 'On' : 'Off';
          }
        }
      });
    }
  } catch(e) { console.warn('loadSettings error:', e); }
  _loadingSettings = false;
}

// ── Wind cache (in-memory + localStorage-backed) ──────────────────────────────
// Key = toFixed(2) lat/lng grid (~1.1km cells). Entries expire after CACHE_MS.

const windCache = {};

function cacheKey(lat, lng) { return `${lat.toFixed(2)},${lng.toFixed(2)}`; }

function findCachedWinds(lat, lng) {
  const key = cacheKey(lat, lng);
  const c = windCache[key];
  if (!c) return null;
  if (Date.now() - c.ts > CACHE_MS) { delete windCache[key]; return null; }
  return c;
}

function saveWindCache(lat, lng, entry) {
  const key = cacheKey(lat, lng);
  windCache[key] = entry;
  try {
    localStorage.setItem(storageKey('wind_cache'), JSON.stringify(windCache));
  } catch(e) { /* localStorage full or unavailable */ }
}

function loadWindCache() {
  try {
    const raw = localStorage.getItem(storageKey('wind_cache'));
    if (!raw) return;
    const stored = JSON.parse(raw);
    const now = Date.now();
    // Load non-expired entries into in-memory cache
    Object.entries(stored).forEach(([key, entry]) => {
      if (now - entry.ts <= CACHE_MS) windCache[key] = entry;
    });
  } catch(e) {}
}
