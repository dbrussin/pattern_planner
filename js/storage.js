// ─── STORAGE ───────────────────────────────────────────────────────────────────
// localStorage persistence for settings and wind cache.
// Depends on: state, config (CACHE_MS, STORAGE_VERSION, WAIVER_VERSION, PERSIST_INPUTS)

function storageKey(k) { return `pp_${k}`; }

// ── Settings save / load ──────────────────────────────────────────────────────

// Flag prevents saveSettings from firing during the loadSettings restore loop
let _loadingSettings = false;

/**
 * Persist all current settings to localStorage.
 * No-op during loadSettings() restore loop (guarded by _loadingSettings flag).
 * Saves: PERSIST_INPUTS values, hand, leg modes, canopy perf flags and values,
 * extra legs metadata, heading overrides, and layer visibility.
 */
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
    // Extra legs — save metadata + current altitude values
    const xlData = state.extraLegs.map(xl => ({
      id:    xl.id,
      color: xl.color,
      alt:   parseFloat(document.getElementById(`alt-${xl.id}`)?.value) || xl.defaultAlt,
      hdg:   parseInt(document.getElementById(`hdg-${xl.id}`)?.value)   ?? xl.nomHdg ?? 0,
    }));
    localStorage.setItem(storageKey('extra_legs'),       JSON.stringify(xlData));
    localStorage.setItem(storageKey('next_xl_idx'),      String(state.nextExtraLegIdx));
    localStorage.setItem(storageKey('leg_hdg_override'), JSON.stringify(state.legHdgOverride || {}));
    // Per-leg perf inputs (standard + extra legs)
    [...LEG_DEFS.map(l => l.key), ...state.extraLegs.map(xl => xl.id)].forEach(leg => {
      ['glide', 'speed', 'sink'].forEach(field => {
        const el = document.getElementById(`${leg}-${field}`);
        if (el && el.value !== '') localStorage.setItem(storageKey(`${leg}_${field}`), el.value);
      });
    });
  } catch(e) {
    console.warn('saveSettings error:', e);
    if (e.name === 'QuotaExceededError' || e.code === 22) setStatus('Storage full — settings not saved');
  }
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
      // Preserve waiver and invite verification across storage version changes
      const waiverAgreed    = localStorage.getItem('pp_waiver_version');
      const inviteVerified  = localStorage.getItem('pp_invite_verified');
      Object.keys(localStorage).filter(k => k.startsWith('pp_')).forEach(k => localStorage.removeItem(k));
      localStorage.setItem(storageKey('storage_version'), STORAGE_VERSION);
      if (waiverAgreed)   localStorage.setItem('pp_waiver_version',  waiverAgreed);
      if (inviteVerified) localStorage.setItem('pp_invite_verified', inviteVerified);
    }
  } catch(e) {}
}

/**
 * Restore all persisted settings from localStorage into DOM inputs and state.
 * Sets _loadingSettings=true to suppress saveSettings() feedback loops during restore.
 * Runs renderLegs() to rebuild leg cards after extra legs are restored from storage.
 * Called once during app init (app.js), after initStorage() and loadWindCache().
 */
function loadSettings() {
  _loadingSettings = true;
  try {
    // Numeric inputs
    PERSIST_INPUTS.forEach(id => {
      const val = localStorage.getItem(storageKey(id));
      const el  = document.getElementById(id);
      if (val !== null && el) { el.value = val; el.style.color = 'var(--text)'; }
    });

    // Leg heading overrides — restore early before renderLegs calls
    const hdgOverrideStr = localStorage.getItem(storageKey('leg_hdg_override'));
    if (hdgOverrideStr) {
      try {
        const saved = JSON.parse(hdgOverrideStr);
        if (!state.legHdgOverride) state.legHdgOverride = {};
        Object.assign(state.legHdgOverride, saved);
      } catch(e) {}
    }

    // Hand
    const hand = localStorage.getItem(storageKey('hand'));
    if (hand === 'left' || hand === 'right') setHand(hand);

    // Leg modes
    const legModesStr = localStorage.getItem(storageKey('leg_modes'));
    if (legModesStr) {
      const saved = JSON.parse(legModesStr);
      LEG_DEFS.map(l => l.key).forEach(leg => {
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
      LEG_DEFS.map(l => l.key).forEach(leg => {
        if (saved[leg]) {
          const cb = document.getElementById(`${leg}-custom-perf`);
          if (cb) cb.checked = true;
          state.legCustomPerf[leg] = true;
          const section = document.getElementById(`${leg}-perf`);
          if (section) section.style.display = 'block';
          // Open the details panel so restored perf fields are visible
          const details = cb?.closest('details');
          if (details) details.open = true;
        }
        ['glide', 'speed', 'sink'].forEach(field => {
          const val = localStorage.getItem(storageKey(`${leg}_${field}`));
          const el  = document.getElementById(`${leg}-${field}`);
          if (val !== null && el) { el.value = val; el.style.color = 'var(--text)'; }
        });
      });
    }

    // Extra legs — must restore before layer visibility so renderLegs() has state
    const xlStr = localStorage.getItem(storageKey('extra_legs'));
    if (xlStr) {
      try {
        const xlData   = JSON.parse(xlStr);
        const savedModes = (() => {
          try { return JSON.parse(localStorage.getItem(storageKey('leg_modes')) || '{}'); } catch(e) { return {}; }
        })();
        state.extraLegs      = [];
        state.nextExtraLegIdx = parseInt(localStorage.getItem(storageKey('next_xl_idx'))) || (xlData.length + 1);
        const savedCustom = (() => {
          try { return JSON.parse(localStorage.getItem(storageKey('leg_custom')) || '{}'); } catch(e) { return {}; }
        })();
        xlData.forEach(xl => {
          state.extraLegs.push({ id: xl.id, defaultAlt: xl.alt, color: xl.color, nomHdg: xl.hdg ?? 0 });
          state.legModes[xl.id]      = savedModes[xl.id] || 'crab';
          state.legCustomPerf[xl.id] = !!savedCustom[xl.id];
        });
        renderLegs(); // re-render with extra legs present
        // Restore altitude, heading, and custom perf inputs after renderLegs() created them
        xlData.forEach(xl => {
          const el = document.getElementById(`alt-${xl.id}`);
          if (el) { el.value = xl.alt; el.style.color = 'var(--text)'; }
          const altSlEl = document.getElementById(`alt-${xl.id}-sl`);
          if (altSlEl) altSlEl.value = xl.alt;
          const hdg = xl.hdg ?? 0;
          const hdgEl = document.getElementById(`hdg-${xl.id}`);
          if (hdgEl) { hdgEl.value = hdg; }
          const hdgSlEl = document.getElementById(`hdg-sl-${xl.id}`);
          if (hdgSlEl) { hdgSlEl.value = hdg; }
          if (savedCustom[xl.id]) {
            const cb = document.getElementById(`${xl.id}-custom-perf`);
            if (cb) cb.checked = true;
            const section = document.getElementById(`${xl.id}-perf`);
            if (section) section.style.display = 'block';
            const details = document.getElementById(`leg-details-${xl.id}`);
            if (details) details.open = true;
            ['glide', 'speed', 'sink'].forEach(field => {
              const val = localStorage.getItem(storageKey(`${xl.id}_${field}`));
              const inp = document.getElementById(`${xl.id}-${field}`);
              if (val !== null && inp) { inp.value = val; inp.style.color = 'var(--text)'; }
            });
          }
        });
      } catch(e) { console.warn('extra legs restore error:', e); }
    }

    // Sync alt sliders after restoring values
    ['alt-enter', 'alt-base', 'alt-final', 'alt-exit', 'alt-open'].forEach(id => {
      const num = document.getElementById(id);
      const sl  = document.getElementById(id + '-sl');
      if (num && sl && num.value) sl.value = num.value;
    });

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
  // Re-render legs to ensure standard leg override UI is visible, then sync sliders
  renderLegs();
  ['alt-enter', 'alt-base', 'alt-final', 'alt-exit', 'alt-open'].forEach(id => {
    const num = document.getElementById(id);
    const sl  = document.getElementById(id + '-sl');
    if (num && sl && num.value) sl.value = num.value;
  });
  // Update magnetic declination display from restored DZ zero point
  if (typeof updateMagDeclination === 'function') updateMagDeclination();
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
