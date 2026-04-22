// ─── CONFIG ────────────────────────────────────────────────────────────────────
// Physical constants and API configuration shared across all modules.

// ── Type annotations (JSDoc @typedef) ────────────────────────────────────────
// These allow editors and Claude to infer types without running TypeScript.

/** @typedef {{lat: number, lng: number}} LatLng - WGS-84 coordinate pair */
/** @typedef {{n: number, e: number}} Vec2 - North/east velocity or unit vector */
/** @typedef {{dN: number, dE: number}} Displacement - Wind drift in feet (north, east) */
/** @typedef {{dirDeg: number, speedKts: number}} WindLevel - Wind at a single altitude */
/** @typedef {{along: number, cross: number}} WindComponents - Along-track and cross-track wind (kts) */
/** @typedef {'crab'|'drift'} LegMode - How wind correction is applied to a leg */

// Earth radius in feet (used for lat/lng offset math)
const R_FT = 20902231;
const D2R  = Math.PI / 180;
const R2D  = 180 / Math.PI;

// ── Conversion constants ──────────────────────────────────────────────────────
const FT_PER_NM          = 6076;    // feet per nautical mile
const FT_MIN_PER_KT      = 101.269; // ft/min per knot (horizontal speed → descent rate)
const G_FT_S2            = 32.174;  // gravitational acceleration (ft/s²) for turn radius
const DRIFT_STEP_FT      = 200;     // Riemann integration step for wind drift (ft)
const MIN_WIND_SPD_KT    = 0.5;     // minimum wind speed for jump-run auto-heading (kts)
const STATUTE_MI_PER_DEG = 69;      // approximate statute miles per degree of latitude
const MIN_AGL_FT         = 50;      // minimum AGL threshold for pressure-level wind data (ft)

// Wind cache TTL — 20 minutes
const CACHE_MS = 20 * 60 * 1000;

// Access gate — trivial obfuscation only, not real security
const _IC = atob('RE9OVERFTEFZQ1VUQVdBWQ==');

/**
 * Returns a debounced version of fn that delays invocation by `wait` ms.
 * Resets the timer on each call; only the last call within the window executes.
 * @param {Function} fn - Function to debounce
 * @param {number} wait - Delay in milliseconds
 * @returns {Function} Debounced function
 */
function debounce(fn, wait) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// GFS API: pressure levels (hPa) to query for winds + temperature.
// All levels from 1000–500 hPa (~surface to ~18k ft MSL); covers 14k ft AGL
// at even high-elevation DZs. 400/300 hPa (~23k/30k ft) are above any exit altitude.
const PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 675, 650, 625, 600, 575, 550, 525, 500];

// GFS API: fixed height levels above ground (metres)
const HEIGHT_LEVELS = [80]; // → ~262 ft AGL

// Display rows: interpolated wind altitudes shown in the wind table (ft AGL)
const INTERP_ALTS_FT = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000];

// ── Leg definitions — drives the rendered leg cards in the settings overlay ──
// Adding an entry here automatically adds a leg card to the UI.
// `key` must match state.legModes and element ID prefixes (e.g. dw-crab, dw-glide).
// `altId` must match PERSIST_INPUTS and calculate.js element reads.
// Colors for dynamically added extra legs (cycles if more than 5)
const EXTRA_LEG_COLORS = ['#c084fc', '#60a5fa', '#fb923c', '#34d399', '#f472b6'];

const LEG_DEFS = [
  { key: 'dw', label: 'Downwind', color: '#f4944d', altId: 'alt-enter', altLabel: 'Enter Alt (ft AGL)', altDefault: 900,  altMin: 200, altMax: 3000, altStep: 50, hasZPattern: true  },
  { key: 'b',  label: 'Base',     color: '#4df4c8', altId: 'alt-base',  altLabel: 'Turn Base (ft AGL)', altDefault: 600,  altMin: 100, altMax: 2000, altStep: 50, hasZPattern: false },
  { key: 'f',  label: 'Final',    color: '#e8f44d', altId: 'alt-final', altLabel: 'Turn Final (ft AGL)', altDefault: 300, altMin: 50,  altMax: 1000, altStep: 50, hasZPattern: false },
];
