// ─── CONFIG ────────────────────────────────────────────────────────────────────
// Physical constants and API configuration shared across all modules.

// Earth radius in feet (used for lat/lng offset math)
const R_FT = 20902231;
const D2R  = Math.PI / 180;
const R2D  = 180 / Math.PI;

// Wind cache TTL — 20 minutes
const CACHE_MS = 20 * 60 * 1000;

// GFS API: pressure levels (hPa) to query for winds + temperature
const PRESSURE_LEVELS = [1000, 975, 950, 925, 850, 700, 600, 500, 400, 300];

// GFS API: fixed height levels above ground (metres)
const HEIGHT_LEVELS = [80, 120, 180]; // → ~262, 394, 591 ft AGL

// Display rows: interpolated wind altitudes shown in the wind table (ft AGL)
const INTERP_ALTS_FT = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000];
