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
 * @param {Array<{altFt: number, dirDeg: number, speedKts: number}>} sorted - Wind levels sorted ascending by altFt
 * @param {number} targetAlt - MSL altitude to interpolate at (ft)
 * @returns {{dir: number, speed: number}} Interpolated wind direction (° true, rounded) and speed (kts, rounded)
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
        dir:   Math.round((lo.dirDeg + t * dd + 360) % 360),
        speed: Math.round(lo.speedKts + t * (hi.speedKts - lo.speedKts)),
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
 * Uses WMM2025 Gauss coefficients through degree/order 3 (Schmidt quasi-normal).
 * Accuracy: ~1–2° for most mid-latitudes. Not for navigation; display only.
 * @param {number} latDeg - Geodetic latitude (°)
 * @param {number} lonDeg - Longitude (°)
 * @returns {number} Magnetic declination in degrees (positive = east of north)
 */
function magDeclination(latDeg, lonDeg) {
  // WMM2025 main-field Gauss coefficients g_nm, h_nm (nT), through n=3
  // Source: NOAA WMM2025 coefficient file (epoch 2025.0)
  // Indexed as G[n][m] and H[n][m] (m=0..n); h_n0 = 0 by definition.
  const G = [
    [],                                          // n=0 (unused)
    [-29351.8, -1410.8,        0,       0],      // n=1: m=0,1
    [ -2556.6,  2951.0,   1580.6,       0],      // n=2: m=0,1,2
    [  1361.0, -2404.0,   1243.8,   453.6],      // n=3: m=0,1,2,3
  ];
  const H = [
    [],                                          // n=0 (unused)
    [      0,  4545.4,        0,       0],       // n=1: m=0,1
    [      0, -3133.6,   -814.8,       0],       // n=2: m=0,1,2
    [      0,    56.6,    237.4,  -549.1],       // n=3: m=0,1,2,3
  ];

  const lat  = latDeg * D2R;
  const lon  = lonDeg * D2R;
  const sinL = Math.sin(lat);
  const cosL = Math.cos(lat);

  // Schmidt quasi-normal associated Legendre polynomials P(n,m,sinLat)
  // and their latitude derivatives dP(n,m) = dP/d(latitude).
  // Evaluated at sinLat = sin(geocentric lat).
  // For surface approximation, geocentric ≈ geodetic (error < 0.2° at poles).

  // Pre-compute P and dP through n=3 using standard recursion
  const P  = [[1,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  const dP = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  P[0][0]  = 1;
  P[1][0]  = sinL;     dP[1][0] = cosL;
  P[1][1]  = cosL;     dP[1][1] = -sinL;
  P[2][0]  = 0.5 * (3*sinL*sinL - 1);                    dP[2][0] = 3*sinL*cosL;
  P[2][1]  = Math.sqrt(3) * sinL * cosL;                  dP[2][1] = Math.sqrt(3) * (cosL*cosL - sinL*sinL);
  P[2][2]  = Math.sqrt(3)/2 * cosL*cosL;                  dP[2][2] = -Math.sqrt(3) * sinL * cosL;
  P[3][0]  = 0.5 * sinL * (5*sinL*sinL - 3);              dP[3][0] = 0.5*(15*sinL*sinL - 3)*cosL;
  P[3][1]  = Math.sqrt(6)/4 * cosL * (5*sinL*sinL - 1);  dP[3][1] = Math.sqrt(6)/4 * (-sinL*(5*sinL*sinL-1) + 10*sinL*cosL*cosL);
  P[3][2]  = Math.sqrt(15)/2 * sinL * cosL*cosL;          dP[3][2] = Math.sqrt(15)/2 * (cosL*cosL*cosL - 2*sinL*sinL*cosL);
  P[3][3]  = Math.sqrt(10)/4 * cosL*cosL*cosL;            dP[3][3] = -3*Math.sqrt(10)/4 * sinL*cosL*cosL;

  let Bx = 0, By = 0; // north (+Bx), east (+By) field components

  for (let n = 1; n <= 3; n++) {
    // At Earth's surface (r=a), the (a/r)^(n+2) factor equals 1 for all n.
    for (let m = 0; m <= n; m++) {
      const gnm = G[n][m] || 0;
      const hnm = H[n][m] || 0;
      const cosM = Math.cos(m * lon);
      const sinM = Math.sin(m * lon);
      // North component: X = (1/r) dV/d(lat) = -dP/d(lat) * (g cos + h sin)
      // dP here is d/d(latitude), so Bx -= dP * (g cos + h sin)
      Bx -= dP[n][m] * (gnm * cosM + hnm * sinM);
      // East component: Y = -(1/(r cosLat)) dV/dlon → -m * P * (-g sin + h cos) / cosLat
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
 * @param {number} agl - Altitude above ground level (ft)
 * @returns {number} TAS/IAS ratio (1.0 at field elevation, ~1.02 per 1000 ft at ISA)
 */
function tasFactor(agl) {
  const mslFt = agl + state.fieldElevFt;
  if (mslFt <= 0) return 1;
  const tempC      = getTempAtAGL(agl);
  const T_isa_K    = 288.15 - 0.001981 * mslFt;                        // ISA temp at MSL alt (K)
  const T_actual_K = tempC !== null ? tempC + 273.15 : T_isa_K;        // actual or ISA fallback
  const P_ratio    = Math.pow(Math.max(1 - 6.8756e-6 * mslFt, 0.01), 5.2561); // std atmosphere
  const sigma      = P_ratio * (T_isa_K / Math.max(T_actual_K, 1));    // density ratio
  return 1 / Math.sqrt(Math.max(sigma, 0.1));
}
