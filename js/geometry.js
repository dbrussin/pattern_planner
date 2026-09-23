// ─── GEOMETRY ──────────────────────────────────────────────────────────────────
// Pure spherical-Earth math and wind interpolation utilities.
// Depends on: config (R_FT, D2R, R2D), state (winds, fieldElevFt)

// Offset a lat/lng point by dN feet north and dE feet east
function offsetLL(lat, lng, dN, dE) {
  return {
    lat: lat + (dN / R_FT) * R2D,
    lng: lng + (dE / (R_FT * Math.cos(lat * D2R))) * R2D,
  };
}

// Inverse of offsetLL: point → {n, e} feet from ref
function llToNE(p, ref) {
  return {
    n: (p.lat - ref.lat) * D2R * R_FT,
    e: (p.lng - ref.lng) * D2R * R_FT * Math.cos(ref.lat * D2R),
  };
}

// Heading (0-359°) → unit vector {n, e}
function hdgVec(h) { const r = h * D2R; return {n: Math.cos(r), e: Math.sin(r)}; }

// Wind "from" direction + speed (kts) → velocity vector {n, e}
function windVec(from, spd) { const r = (from + 180) * D2R; return {n: Math.cos(r) * spd, e: Math.sin(r) * spd}; }

// Vector magnitude
function vecLen(v) { return Math.sqrt(v.n ** 2 + v.e ** 2); }

// Unit vector (safe: returns {0,0} for zero-length input)
function normalize(v) { const l = vecLen(v) || 1; return {n: v.n / l, e: v.e / l}; }

// Approximate great-circle distance in statute miles between two {lat,lng} points
function distMiles(a, b) {
  const dLat = (a.lat - b.lat) * STATUTE_MI_PER_DEG;
  const dLng = (a.lng - b.lng) * STATUTE_MI_PER_DEG * Math.cos(a.lat * Math.PI / 180);
  return Math.sqrt(dLat ** 2 + dLng ** 2);
}

// ── Wind interpolation ────────────────────────────────────────────────────────

/**
 * Linear interpolation of wind between two altitude levels.
 * Handles circular direction interpolation (shortest angular path through ±180°).
 * Clamps to nearest endpoint for altitudes outside the sorted array range.
 * Returns unrounded values — callers that display to the user should round.
 * @param {Array<{altFt: number, dirDeg: number, speedKts: number}>} sorted - Wind levels sorted ascending by altFt
 * @param {number} targetAlt - MSL altitude to interpolate at (ft)
 * @returns {{dir: number, speed: number}} Interpolated wind direction (° true) and speed (kts)
 */
function interpolateWind(sorted, targetAlt) {
  if (!sorted.length) return {dir: 0, speed: 0};
  if (targetAlt <= sorted[0].altFt) return {dir: sorted[0].dirDeg, speed: sorted[0].speedKts};
  const last = sorted[sorted.length - 1];
  if (targetAlt >= last.altFt) return {dir: last.dirDeg, speed: last.speedKts};
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i], hi = sorted[i + 1];
    if (targetAlt >= lo.altFt && targetAlt <= hi.altFt) {
      const t = (targetAlt - lo.altFt) / (hi.altFt - lo.altFt);
      let dd = hi.dirDeg - lo.dirDeg;
      if (dd > 180) dd -= 360;
      if (dd < -180) dd += 360;
      return {
        dir:   ((lo.dirDeg + t * dd) % 360 + 360) % 360,
        speed: lo.speedKts + t * (hi.speedKts - lo.speedKts),
      };
    }
  }
  return {dir: 0, speed: 0};
}

// Convenience wrapper: returns {dirDeg, speedKts} instead of {dir, speed}
function interpObj(sorted, msl) {
  const r = interpolateWind(sorted, msl);
  return {dirDeg: r.dir, speedKts: r.speed};
}

// ── Sorted winds cache ────────────────────────────────────────────────────────
// Rebuilt when state.winds changes (invalidated by setting _sortedWindsCache = null).
// Avoids re-sorting inside the 200ft integration loop.

let _sortedWindsCache   = null;
let _sortedWindsElevFt  = null;

function getSortedWinds() {
  if (_sortedWindsCache && _sortedWindsElevFt === state.fieldElevFt) return _sortedWindsCache;
  _sortedWindsCache = state.winds
    .filter(w => w.dirDeg !== null && w.speedKts !== null && isFinite(w.dirDeg) && isFinite(w.speedKts))
    .map(w => ({altFt: w.aglFt + state.fieldElevFt, dirDeg: w.dirDeg, speedKts: w.speedKts}))
    .sort((a, b) => a.altFt - b.altFt);
  _sortedWindsElevFt = state.fieldElevFt;
  return _sortedWindsCache;
}

// Returns wind velocity vector {n, e} at a given AGL altitude
function getWindAtAGL(agl) {
  const msl    = agl + state.fieldElevFt;
  const sorted = getSortedWinds();
  if (!sorted.length) return {n: 0, e: 0};
  const r = interpolateWind(sorted, msl);
  if (!isFinite(r.dir) || !isFinite(r.speed)) return {n: 0, e: 0};
  return windVec(r.dir, r.speed);
}

// ── Sorted temperature cache ──────────────────────────────────────────────────
// Parallel to _sortedWindsCache; rebuilt when state.winds changes.

let _sortedTempCache  = null;
let _sortedTempElevFt = null;

// Call this whenever state.winds is mutated to invalidate both caches.
function invalidateWindCaches() {
  _sortedWindsCache = null;
  _sortedTempCache  = null;
}

function getSortedTemps() {
  if (_sortedTempCache && _sortedTempElevFt === state.fieldElevFt) return _sortedTempCache;
  _sortedTempCache = state.winds
    .filter(w => w.tempC !== null && w.tempC !== undefined && isFinite(w.tempC))
    .map(w => ({altFt: w.aglFt + state.fieldElevFt, tempC: w.tempC}))
    .sort((a, b) => a.altFt - b.altFt);
  _sortedTempElevFt = state.fieldElevFt;
  return _sortedTempCache;
}

// Returns interpolated temperature (°C) at a given AGL altitude, or null if no data.
function getTempAtAGL(agl) {
  const msl    = agl + state.fieldElevFt;
  const sorted = getSortedTemps();
  if (!sorted.length) return null;
  if (msl <= sorted[0].altFt) return sorted[0].tempC;
  const last = sorted[sorted.length - 1];
  if (msl >= last.altFt) return last.tempC;
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i], hi = sorted[i + 1];
    if (msl >= lo.altFt && msl <= hi.altFt) {
      const t = (msl - lo.altFt) / (hi.altFt - lo.altFt);
      return lo.tempC + t * (hi.tempC - lo.tempC);
    }
  }
  return null;
}

/**
 * Approximate magnetic declination (degrees, east positive) for a given lat/lon.
 * Uses WMM2025 Gauss coefficients through degree/order 6 with secular variation.
 * Accuracy: ~0.3–0.5° for most locations. Not for navigation; display only.
 * @param {number} latDeg - Geodetic latitude (°)
 * @param {number} lonDeg - Longitude (°)
 * @returns {number} Magnetic declination in degrees (positive = east of north)
 */
function magDeclination(latDeg, lonDeg) {
  // WMM2025 Gauss coefficients [n, m, g_nm(nT), h_nm(nT), ġ_nm(nT/yr), ḣ_nm(nT/yr)]
  // Source: NOAA WMM2025, epoch 2025.0, released 2024-11-13.
  // Secular variation applied as: g(t) = g(2025.0) + ġ * (t − 2025.0)
  const WMM = [
    [1,0,-29351.8,     0.0, 12.0,   0.0],
    [1,1,  -1410.8,  4545.4,  9.7, -21.5],
    [2,0,  -2556.6,     0.0,-11.6,   0.0],
    [2,1,   2951.1, -3133.6, -5.2, -27.7],
    [2,2,   1649.3,  -815.1, -8.0, -12.1],
    [3,0,   1361.0,     0.0, -1.3,   0.0],
    [3,1,  -2404.1,   -56.6, -4.2,   4.0],
    [3,2,   1243.8,   237.5,  0.4,  -0.3],
    [3,3,    453.6,  -549.5,-15.6,  -4.1],
    [4,0,    895.0,     0.0, -1.6,   0.0],
    [4,1,    799.5,   278.6, -2.4,  -1.1],
    [4,2,     55.7,  -133.9, -6.0,   4.1],
    [4,3,   -281.1,   212.0,  5.6,   1.6],
    [4,4,     12.1,  -375.6, -7.0,  -4.4],
    [5,0,   -233.2,     0.0,  0.6,   0.0],
    [5,1,    368.9,    45.4,  1.4,  -0.5],
    [5,2,    187.2,   220.2,  0.0,   2.2],
    [5,3,   -138.7,  -122.9,  0.6,   0.4],
    [5,4,   -142.0,    43.0,  2.2,   1.7],
    [5,5,     20.9,   106.1,  0.9,   1.9],
    [6,0,     64.4,     0.0, -0.2,   0.0],
    [6,1,     63.8,   -18.4, -0.4,   0.3],
    [6,2,     76.9,    16.8,  0.9,  -1.6],
    [6,3,   -115.7,    48.8,  1.2,  -0.4],
    [6,4,    -40.9,   -59.8, -0.9,   0.9],
    [6,5,     14.9,    10.9,  0.3,   0.7],
    [6,6,    -60.7,    72.7,  0.9,   0.9],
  ];

  // Fractional year for secular variation
  const now  = new Date();
  const yr0  = Date.UTC(now.getUTCFullYear(), 0, 1);
  const yr1  = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
  const dt   = (now.getUTCFullYear() + (now.getTime() - yr0) / (yr1 - yr0)) - 2025.0;

  // Build G[n][m] / H[n][m] with secular variation applied
  const NMAX = 6;
  const G = Array.from({length: NMAX + 1}, () => new Float64Array(NMAX + 1));
  const H = Array.from({length: NMAX + 1}, () => new Float64Array(NMAX + 1));
  for (const [n, m, g, h, gd, hd] of WMM) {
    G[n][m] = g + gd * dt;
    H[n][m] = h + hd * dt;
  }

  const lat  = latDeg * D2R;
  const lon  = lonDeg * D2R;
  const sinL = Math.sin(lat);
  const cosL = Math.cos(lat);

  // Schmidt quasi-normal Legendre polynomials P[n][m](sinLat) and latitude
  // derivatives dP[n][m] = dP/d(lat), computed via standard two-term recursion.
  const P  = Array.from({length: NMAX + 1}, () => new Float64Array(NMAX + 1));
  const dP = Array.from({length: NMAX + 1}, () => new Float64Array(NMAX + 1));
  P[0][0]  = 1.0;
  P[1][0]  = sinL;  dP[1][0] = cosL;
  P[1][1]  = cosL;  dP[1][1] = -sinL;
  for (let n = 2; n <= NMAX; n++) {
    // Diagonal term: P[n][n] = √((2n-1)/(2n)) * cosL * P[n-1][n-1]
    const fd  = Math.sqrt((2.0 * n - 1.0) / (2.0 * n));
    P[n][n]   = fd * cosL * P[n-1][n-1];
    dP[n][n]  = fd * (-sinL * P[n-1][n-1] + cosL * dP[n-1][n-1]);
    // Off-diagonal terms (m = 0 to n-1)
    for (let m = 0; m <= n - 1; m++) {
      const nm2 = n * n - m * m;
      const a   = (2 * n - 1) / Math.sqrt(nm2);
      const b   = Math.sqrt(((n - 1) * (n - 1) - m * m) / nm2);
      P[n][m]   = a * sinL * P[n-1][m]  - b * P[n-2][m];
      dP[n][m]  = a * (cosL * P[n-1][m] + sinL * dP[n-1][m]) - b * dP[n-2][m];
    }
  }

  // Accumulate north (Bx) and east (By) field components.
  // At Earth's surface (r=a), (a/r)^(n+2) = 1 for all n.
  // X = −(dP/dLat)·(g·cosML + h·sinML)
  // Y = −m·P·(−g·sinML + h·cosML) / cosLat
  let Bx = 0, By = 0;
  for (let n = 1; n <= NMAX; n++) {
    for (let m = 0; m <= n; m++) {
      const gnm  = G[n][m];
      const hnm  = H[n][m];
      const cosM = Math.cos(m * lon);
      const sinM = Math.sin(m * lon);
      Bx -= dP[n][m] * (gnm * cosM + hnm * sinM);
      if (cosL > 1e-6) {
        By -= m * P[n][m] * (-gnm * sinM + hnm * cosM) / cosL;
      }
    }
  }

  return Math.atan2(By, Bx) * R2D;
}

/**
 * Compute the TAS/IAS ratio at a given AGL altitude using the ISA atmosphere model.
 * Uses actual temperature from API data when available, falls back to ISA standard temp.
 * Reference: ICAO standard atmosphere — pressure ratio exponent 5.2561, lapse 6.5 K/km.
 *
 * Density ratio σ = (P/P₀)·(T₀/T_actual), where T₀ = 288.15 K is the sea-level
 * standard temperature. At ISA this collapses to (1 − Lh/T₀)^(g/RL − 1).
 * TAS/IAS = 1/√σ ≈ 1.015 per 1000 ft at ISA.
 *
 * @param {number} agl - Altitude above ground level (ft)
 * @returns {number} TAS/IAS ratio (1.0 at sea level, ~1.015 per 1000 ft at ISA)
 */
const T_SL_K = 288.15; // sea-level standard temperature (K)
function tasFactor(agl) {
  const mslFt = agl + state.fieldElevFt;
  if (mslFt <= 0) return 1;
  const tempC      = getTempAtAGL(agl);
  const T_isa_K    = T_SL_K - 0.001981 * mslFt;                        // ISA temp at MSL alt (K)
  const T_actual_K = tempC !== null ? tempC + 273.15 : T_isa_K;        // actual or ISA fallback
  const P_ratio    = Math.pow(Math.max(1 - 6.8756e-6 * mslFt, 0.01), 5.2561); // std atmosphere
  // σ = (P/P₀)·(T₀/T) — must use SL standard temp, NOT T_isa at altitude.
  const sigma      = P_ratio * (T_SL_K / Math.max(T_actual_K, 1));
  return 1 / Math.sqrt(Math.max(sigma, 0.1));
}
