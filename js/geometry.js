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
