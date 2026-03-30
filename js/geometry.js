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
  const dLat = (a.lat - b.lat) * 69;
  const dLng = (a.lng - b.lng) * 69 * Math.cos(a.lat * Math.PI / 180);
  return Math.sqrt(dLat ** 2 + dLng ** 2);
}

// ── Wind interpolation ────────────────────────────────────────────────────────

// Linear wind interpolation between two altitude levels.
// sorted: array of {altFt, dirDeg, speedKts} sorted ascending by altFt
// targetAlt: MSL altitude in feet
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

// TAS/IAS ratio at a given AGL altitude.
// Uses actual temperature from API (when available) and standard atmosphere pressure.
// Returns 1.0 at field elevation; increases with altitude (~2% per 1000 ft at ISA).
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
