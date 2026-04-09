// ─── CALCULATE ─────────────────────────────────────────────────────────────────
// Core pattern solver and wind-integration helpers.
// Depends on: config, state, geometry, ui (getLegPerf, setStatus, updateJumpRunDisplay)
// Turn model: coordinated banked turn; radius = v_TAS²/(g·tan θ); altitude consumed
// via increased descent rate 1/cos(θ); two-pass to propagate altitude adjustments.

/**
 * Compute integrated wind drift during descent through an altitude band using Riemann sums.
 * Uses 200 ft steps; TAS factor adjusts effective descent rate with altitude (ISA model).
 * @param {number} altTopAGL - Top of descent band (ft AGL)
 * @param {number} altBotAGL - Bottom of descent band (ft AGL)
 * @param {number} descentFtMin - Vertical speed (ft/min, positive = descending)
 * @returns {Displacement} Accumulated drift in feet (north positive, east positive)
 */
function integratedDrift(altTopAGL, altBotAGL, descentFtMin) {
  if (altTopAGL <= altBotAGL) return {dN: 0, dE: 0};
  let dN = 0, dE = 0;
  for (let agl = altBotAGL; agl < altTopAGL; agl += DRIFT_STEP_FT) {
    const bandTop = Math.min(agl + DRIFT_STEP_FT, altTopAGL);
    const midAGL  = (agl + bandTop) / 2;
    const bandAlt = bandTop - agl;
    const w       = getWindAtAGL(midAGL);
    const tMin    = bandAlt / (descentFtMin * tasFactor(midAGL));
    dN += w.n * (tMin / 60) * FT_PER_NM;
    dE += w.e * (tMin / 60) * FT_PER_NM;
  }
  return {dN, dE};
}

/**
 * Average wind speed and direction across an altitude band (used for zone labels).
 * Samples every 200 ft and returns a scalar average, not a vector average.
 * @param {number} altBotAGL - Bottom of band (ft AGL)
 * @param {number} altTopAGL - Top of band (ft AGL)
 * @returns {{spd: number, dir: number}} Average wind speed (kts, rounded) and direction (° true, rounded)
 */
function avgWindInBand(altBotAGL, altTopAGL) {
  let sumN = 0, sumE = 0, count = 0;
  for (let agl = altBotAGL; agl < altTopAGL; agl += DRIFT_STEP_FT) {
    const mid = (agl + Math.min(agl + DRIFT_STEP_FT, altTopAGL)) / 2;
    const w   = getWindAtAGL(mid);
    sumN += w.n; sumE += w.e; count++;
  }
  if (!count) return {spd: 0, dir: 0};
  const avgN = sumN / count, avgE = sumE / count;
  return {
    spd: Math.round(Math.sqrt(avgN ** 2 + avgE ** 2)),
    dir: Math.round((Math.atan2(avgE, avgN) * R2D + 360) % 360),
  };
}

/**
 * Average wind vector {n, e} over an altitude band using 200 ft steps.
 * More accurate than a single midpoint sample for legs spanning large altitude ranges.
 * Used for straight-leg heading and displacement calculations in calculate().
 * @param {number} altBot - Bottom of band (ft AGL)
 * @param {number} altTop - Top of band (ft AGL)
 * @returns {{n: number, e: number}} Average wind vector (kts, north/east)
 */
function avgWindVec(altBot, altTop) {
  let sumN = 0, sumE = 0, count = 0;
  for (let agl = altBot; agl < altTop; agl += DRIFT_STEP_FT) {
    const mid = (agl + Math.min(agl + DRIFT_STEP_FT, altTop)) / 2;
    const w   = getWindAtAGL(mid);
    sumN += w.n; sumE += w.e; count++;
  }
  if (!count) return getWindAtAGL((altBot + altTop) / 2);
  return {n: sumN / count, e: sumE / count};
}

// ── Main pattern solver ───────────────────────────────────────────────────────

/**
 * Main pattern solver. Reads DOM inputs, computes wind-adjusted headings and turn points
 * for all legs, stores result in state.pattern, then calls drawPattern().
 * No-op if state.target is null or required inputs are NaN/invalid.
 * Validates altitude ordering (100 ft minimum gaps) and shows errors via setStatus().
 */
function calculate() {
  if (!state.target) return;

  const glide  = parseFloat(document.getElementById('glide').value);
  const cSpd   = parseFloat(document.getElementById('canopy-speed').value);
  const altE   = parseFloat(document.getElementById('alt-enter').value);
  const altB   = parseFloat(document.getElementById('alt-base').value);
  const altF   = parseFloat(document.getElementById('alt-final').value);

  const _altExit    = parseFloat(document.getElementById('alt-exit').value);
  const _altOpen    = parseFloat(document.getElementById('alt-open').value);
  const _ffSpeed    = parseFloat(document.getElementById('ff-speed').value);
  const _safety     = parseFloat(document.getElementById('safety-margin').value);
  const _jrAirspeed = parseFloat(document.getElementById('jr-airspeed').value);
  const _exitSep    = parseFloat(document.getElementById('exit-sep').value);

  const bankDeg = Math.max(10, Math.min(60, parseFloat(document.getElementById('turn-bank')?.value) || 30));
  const bankRad = bankDeg * D2R;

  const altExit       = isNaN(_altExit)    ? 13500 : _altExit;
  const altOpen       = isNaN(_altOpen)    ? 3000  : _altOpen;
  const ffSpeedMph    = isNaN(_ffSpeed)    ? 120   : _ffSpeed;
  const safetyPct     = (isNaN(_safety)   ? 0     : _safety) / 100;
  const jrAirspeedKts = isNaN(_jrAirspeed) ? 80   : _jrAirspeed;
  const exitSepFt     = isNaN(_exitSep)    ? 1500 : _exitSep;

  if (isNaN(glide) || isNaN(cSpd) || isNaN(altE) || isNaN(altB) || isNaN(altF)) return;

  // ── Altitude sanity checks ────────────────────────────────────────────────
  if (altExit <= altOpen) { setStatus('Exit altitude must be above Opening altitude'); return; }
  if (altF < 100) { setStatus('Turn Final must be at least 100 ft AGL'); return; }
  if (altB < altF + 100) { setStatus('Turn Base must be at least 100 ft above Turn Final'); return; }
  if (altE < altB + 100) { setStatus('Enter altitude must be at least 100 ft above Turn Base'); return; }
  if (state.extraLegs && state.extraLegs.length > 0) {
    const extraAlts = state.extraLegs
      .map(xl => ({ id: xl.id, alt: parseFloat(document.getElementById(`alt-${xl.id}`)?.value) || xl.defaultAlt }))
      .filter(xl => xl.alt > 0)
      .sort((a, b) => a.alt - b.alt);
    if (extraAlts.length > 0 && extraAlts[0].alt < altE + 100) {
      setStatus('Lowest extra leg must be at least 100 ft above Enter altitude'); return;
    }
    for (let i = 1; i < extraAlts.length; i++) {
      if (extraAlts[i].alt < extraAlts[i - 1].alt + 100) {
        setStatus('Extra legs must each be at least 100 ft apart'); return;
      }
    }
  }

  let fHdgFromBar = state.finalHeadingDeg;
  if (fHdgFromBar === null) {
    const s = state.winds.find(w => w.dirDeg !== null);
    if (!s) { setStatus('Set winds or a final heading'); return; }
    fHdgFromBar = s.dirDeg;
  }
  const fHdg = state.legHdgOverride?.f != null ? state.legHdgOverride.f : fHdgFromBar;

  // Jump run heading (needs fHdg as fallback for calm winds)
  let jrHdg = state.jumpRunHdgDeg;
  if (jrHdg === null) {
    const wExit      = getWindAtAGL(altExit);
    const exitWindSpd = vecLen(wExit);
    if (exitWindSpd > MIN_WIND_SPD_KT) {
      const windVelDir = (Math.atan2(wExit.e, wExit.n) * R2D + 360) % 360;
      jrHdg = (windVelDir + 180) % 360;
    } else {
      jrHdg = fHdg;
    }
    document.getElementById('jr-hdg-display').value = Math.round(jrHdg);
    document.getElementById('jr-hdg-slider').value  = Math.round(jrHdg);
  }

  // Per-leg canopy performance
  const perfF  = getLegPerf('f');
  const perfB  = getLegPerf('b');
  const perfDW = getLegPerf('dw');

  // Descent rates (ft/min) — cSpd in kts × 101.269 = ft/min
  const dRateF  = (perfF.cSpd  / perfF.glide)  * FT_MIN_PER_KT;
  const dRateB  = (perfB.cSpd  / perfB.glide)  * FT_MIN_PER_KT;
  const dRateDW = (perfDW.cSpd / perfDW.glide) * FT_MIN_PER_KT;

  // ── Turn displacement helper ──────────────────────────────────────────────────
  // Models a coordinated banked turn from heading h1 to h2 at altAGL.
  // Returns displacement (ft), turn time (s), altitude consumed (ft), and arc
  // geometry parameters for rendering the actual curved ground path in draw.js.
  // Arc: center is R ft perpendicular to h1; each point at fraction f sweeps
  // heading by dh*f with accumulated wind drift w*(f*tSec/60)*FT_PER_NM.
  function calcTurn(h1, h2, altAGL, cSpd, glide, patternSign = 0) {
    let dh = ((h2 - h1 + 540) % 360) - 180;            // signed shortest path (°)
    // Always force the turn to go in the pattern-hand direction.
    // Without this, extra legs with user-specified headings can produce arcs that go
    // the wrong way (shortest path ≠ pattern direction), causing turn paths to cross
    // over themselves and the backward position chain to place leg entry points wildly.
    // Standard-leg headings are computed to already agree with patternSign, so this
    // only changes behaviour for extra-leg turns with a naturally wrong-direction arc.
    if (patternSign !== 0) {
      if (patternSign > 0 && dh < 0) dh += 360;  // right-hand pattern → right turn
      if (patternSign < 0 && dh > 0) dh -= 360;  // left-hand pattern  → left turn
    }
    const dhRad = Math.abs(dh) * D2R;
    const w     = getWindAtAGL(altAGL);
    if (dhRad < 0.001) return {dN: 0, dE: 0, tSec: 0, altConsumed: 0, R: 0, h1, h2, dh: 0, sign: 1, w};
    const tas    = cSpd * tasFactor(altAGL);            // TAS (kts)
    const v_ft_s = tas * FT_MIN_PER_KT / 60;           // TAS (ft/s)
    const omega  = G_FT_S2 * Math.tan(bankRad) / v_ft_s; // turn rate (rad/s)
    const R      = v_ft_s / omega;                      // turn radius (ft)
    const tSec   = dhRad / omega;                       // turn time (s)
    const sign   = dh > 0 ? 1 : -1;                    // +1 = right turn, -1 = left
    const hAvg   = (h1 + dh / 2 + 360) % 360;         // avg heading during arc
    const hv     = hdgVec(hAvg);
    const chord  = 2 * R * Math.sin(dhRad / 2);        // arc chord length (ft)
    const tMin   = tSec / 60;
    // Descent rate in banked turn (TAS-adjusted, increased by 1/cos(bank))
    const dRateTurn = (cSpd / glide) * FT_MIN_PER_KT * tasFactor(altAGL) / Math.cos(bankRad);
    return {
      dN:          hv.n * chord + w.n * (tMin / 60) * FT_PER_NM,
      dE:          hv.e * chord + w.e * (tMin / 60) * FT_PER_NM,
      tSec,
      altConsumed: dRateTurn * tMin,
      R, h1, h2, dh, sign, w,   // arc geometry for draw.js
    };
  }

  // ── Leg heading solver (pure function, no side-effects) ───────────────────────
  // Solves crab or drift heading+displacement for a leg given track direction,
  // still-air glide distance, wind, and time. Returns {hdg, disp}.
  function solveleg(mode, trackN, trackE, stillFt, w, tMin, nomHdg) {
    const driftN = w.n * (tMin / 60) * FT_PER_NM, driftE = w.e * (tMin / 60) * FT_PER_NM;
    if (mode === 'crab') {
      const bc = -2 * (trackN * driftN + trackE * driftE);
      const cc = driftN ** 2 + driftE ** 2 - stillFt ** 2;
      const bd = bc ** 2 - 4 * cc;
      const k  = bd >= 0 ? (-bc + Math.sqrt(bd)) / 2 : stillFt;
      const rN = trackN * k - driftN, rE = trackE * k - driftE;
      return {
        hdg:  (Math.atan2(rE, rN) * R2D + 360) % 360,
        disp: {dN: rN + driftN, dE: rE + driftE},
      };
    } else {
      const hdg = (Math.atan2(trackE, trackN) * R2D + 360) % 360;
      const h   = nomHdg ?? hdg;
      const hv  = hdgVec(h);
      return {hdg: h, disp: {dN: hv.n * stillFt + driftN, dE: hv.e * stillFt + driftE}};
    }
  }

  // Sign convention: +1 = right-hand pattern (right turns), -1 = left-hand (left turns).
  // Used by calcTurn to break the ±180° shortest-arc ambiguity consistently.
  const patternSign = state.hand === 'right' ? 1 : -1;

  // ── Pass 1: headings at nominal altitudes ─────────────────────────────────────
  // Final leg
  const fVec1      = hdgVec(fHdg);
  const fStillFt1  = altF * perfF.glide;
  const tF1        = altF / (dRateF * tasFactor(altF / 2));
  const wF1        = avgWindVec(0, altF);
  let   p1f, fHdgActual1;
  if (state.legModes.f === 'crab') {
    const r = solveleg('crab', fVec1.n, fVec1.e, fStillFt1, wF1, tF1, null);
    fHdgActual1 = r.hdg; p1f = r.disp;
  } else {
    fHdgActual1 = fHdg;
    p1f = {dN: fVec1.n * fStillFt1 + wF1.n * (tF1 / 60) * FT_PER_NM,
           dE: fVec1.e * fStillFt1 + wF1.e * (tF1 / 60) * FT_PER_NM};
  }
  // We need fTrackUnit for base/DW direction — use pass-1 final disp
  const fTrackUnit1 = normalize({n: p1f.dN, e: p1f.dE});

  // Base leg at nominal altitudes
  const bOverride  = state.legHdgOverride?.b;
  const bTN1 = bOverride != null ? hdgVec(bOverride).n : (state.hand === 'left' ? -fTrackUnit1.e :  fTrackUnit1.e);
  const bTE1 = bOverride != null ? hdgVec(bOverride).e : (state.hand === 'left' ?  fTrackUnit1.n : -fTrackUnit1.n);
  const bStillFt1  = (altB - altF) * perfB.glide;
  const tB1        = (altB - altF) / (dRateB * tasFactor((altB + altF) / 2));
  const wB1        = avgWindVec(altF, altB);
  const bNomHdg1   = bOverride ?? (state.hand === 'left' ? (fHdg + 90) % 360 : (fHdg - 90 + 360) % 360);
  const p1b        = solveleg(state.legModes.b, bTN1, bTE1, bStillFt1, wB1, tB1, bNomHdg1);
  const bHdg1      = p1b.hdg;

  // Downwind leg at nominal altitudes (heading only needed for pass-1 turns)
  const dwOverride = state.legHdgOverride?.dw;
  const dwTrackSign = state.zPattern ? 1 : -1;
  const dwTN1 = dwOverride != null ? hdgVec(dwOverride).n : dwTrackSign * fTrackUnit1.n;
  const dwTE1 = dwOverride != null ? hdgVec(dwOverride).e : dwTrackSign * fTrackUnit1.e;
  const dStillFt1  = (altE - altB) * perfDW.glide;
  const tD1        = (altE - altB) / (dRateDW * tasFactor((altE + altB) / 2));
  const wD1        = avgWindVec(altB, altE);
  const dwNomHdg1  = dwOverride ?? (state.zPattern ? fHdg : (fHdg + 180) % 360);
  const p1dw       = solveleg(state.legModes.dw, dwTN1, dwTE1, dStillFt1, wD1, tD1, dwNomHdg1);
  const dwHdg1     = p1dw.hdg;

  // Pass-1 turns (determine altitude consumed at each turn boundary)
  const avgCSpdBF   = (perfB.cSpd  + perfF.cSpd)  / 2;
  const avgGlideBF  = (perfB.glide + perfF.glide)  / 2;
  const avgCSpdDB   = (perfDW.cSpd + perfB.cSpd)   / 2;
  const avgGlideDB  = (perfDW.glide + perfB.glide)  / 2;
  const turn1BF = calcTurn(bHdg1, fHdgActual1, altF, avgCSpdBF, avgGlideBF, patternSign);
  const turn1DB = calcTurn(dwHdg1, bHdg1,      altB, avgCSpdDB, avgGlideDB, patternSign);

  // ── Pass 2: adjusted altitudes ────────────────────────────────────────────────
  // Altitude consumed by each turn reduces the starting altitude of the following leg.
  const altFstart = Math.max(50, altF - turn1BF.altConsumed);  // final leg start alt
  const altBstart = Math.max(altFstart + 50, altB - turn1DB.altConsumed);  // base leg start alt

  // Final leg (adjusted)
  const fVec       = hdgVec(fHdg);
  const fStillFt   = altFstart * perfF.glide;
  const tF         = altFstart / (dRateF * tasFactor(altFstart / 2));
  const wF         = avgWindVec(0, altFstart);
  let fDisp, fHdgActual;
  if (state.legModes.f === 'crab') {
    const dfN = wF.n * (tF / 60) * FT_PER_NM, dfE = wF.e * (tF / 60) * FT_PER_NM;
    const bfc = -2 * (fVec.n * dfN + fVec.e * dfE);
    const cfc = dfN ** 2 + dfE ** 2 - fStillFt ** 2;
    const dfc = bfc ** 2 - 4 * cfc;
    if (dfc < 0) console.warn('calculate: final crab discriminant < 0 — crosswind too strong, using still-air fallback');
    const kf  = dfc >= 0 ? (-bfc + Math.sqrt(dfc)) / 2 : fStillFt;
    const fRN = fVec.n * kf - dfN, fRE = fVec.e * kf - dfE;
    fHdgActual = (Math.atan2(fRE, fRN) * R2D + 360) % 360;
    fDisp      = {dN: fRN + dfN, dE: fRE + dfE};
  } else {
    fHdgActual = fHdg;
    fDisp = {dN: fVec.n * fStillFt + wF.n * (tF / 60) * FT_PER_NM, dE: fVec.e * fStillFt + wF.e * (tF / 60) * FT_PER_NM};
  }
  const fTrackUnit = normalize({n: fDisp.dN, e: fDisp.dE});

  // Base leg (adjusted: altBstart → altF)
  const bTN = bOverride != null ? hdgVec(bOverride).n : (state.hand === 'left' ? -fTrackUnit.e :  fTrackUnit.e);
  const bTE = bOverride != null ? hdgVec(bOverride).e : (state.hand === 'left' ?  fTrackUnit.n : -fTrackUnit.n);
  const bStillFt   = (altBstart - altF) * perfB.glide;
  const tB         = (altBstart - altF) / (dRateB * tasFactor((altBstart + altF) / 2));
  const wB         = avgWindVec(altF, altBstart);
  let bHdg, bDisp;
  const bNomHdg = bOverride ?? (state.hand === 'left' ? (fHdg + 90) % 360 : (fHdg - 90 + 360) % 360);
  if (state.legModes.b === 'crab') {
    const dbN = wB.n * (tB / 60) * FT_PER_NM, dbE = wB.e * (tB / 60) * FT_PER_NM;
    const bc  = -2 * (bTN * dbN + bTE * dbE);
    const cc  = dbN ** 2 + dbE ** 2 - bStillFt ** 2;
    const bd  = bc ** 2 - 4 * cc;
    if (bd < 0) console.warn('calculate: base crab discriminant < 0 — crosswind too strong, using still-air fallback');
    const bk  = bd >= 0 ? (-bc + Math.sqrt(bd)) / 2 : bStillFt;
    const bRN = bTN * bk - dbN, bRE = bTE * bk - dbE;
    bHdg  = (Math.atan2(bRE, bRN) * R2D + 360) % 360;
    bDisp = {dN: bRN + dbN, dE: bRE + dbE};
  } else {
    bHdg  = bNomHdg;
    bDisp = {dN: hdgVec(bHdg).n * bStillFt + wB.n * (tB / 60) * FT_PER_NM, dE: hdgVec(bHdg).e * bStillFt + wB.e * (tB / 60) * FT_PER_NM};
  }

  // Downwind leg (altE → altB; turns happen outside DW altitude band — unchanged)
  const dwTN = dwOverride != null ? hdgVec(dwOverride).n : dwTrackSign * fTrackUnit.n;
  const dwTE = dwOverride != null ? hdgVec(dwOverride).e : dwTrackSign * fTrackUnit.e;
  const dStillFt = (altE - altB) * perfDW.glide;
  const tD       = (altE - altB) / (dRateDW * tasFactor((altE + altB) / 2));
  const wD       = avgWindVec(altB, altE);
  const driftN   = wD.n * (tD / 60) * FT_PER_NM, driftE = wD.e * (tD / 60) * FT_PER_NM;
  let dwHdg, dDisp;
  const isZPattern = state.zPattern;
  if (state.legModes.dw === 'crab') {
    const b1 = -2 * (dwTN * driftN + dwTE * driftE);
    const c1 = driftN ** 2 + driftE ** 2 - dStillFt ** 2;
    const d1 = b1 ** 2 - 4 * c1;
    if (d1 < 0) console.warn('calculate: downwind crab discriminant < 0 — crosswind too strong, using still-air fallback');
    const k1 = d1 >= 0 ? (-b1 + Math.sqrt(d1)) / 2 : dStillFt;
    const rN = dwTN * k1 - driftN, rE = dwTE * k1 - driftE;
    dwHdg = (Math.atan2(rE, rN) * R2D + 360) % 360;
    dDisp = {dN: rN + driftN, dE: rE + driftE};
  } else {
    dwHdg = dwOverride ?? (state.zPattern ? fHdg : (fHdg + 180) % 360);
    dDisp = {dN: hdgVec(dwHdg).n * dStillFt + driftN, dE: hdgVec(dwHdg).e * dStillFt + driftE};
  }

  // ── Pass-2 turns (with adjusted headings) ─────────────────────────────────────
  const turnBF = calcTurn(bHdg, fHdgActual, altF, avgCSpdBF, avgGlideBF, patternSign);
  const turnDB = calcTurn(dwHdg, bHdg,      altB, avgCSpdDB, avgGlideDB, patternSign);

  // ── Backward position chain ───────────────────────────────────────────────────
  // tFinal = where final leg begins (after B→F turn); tBase = where base begins (after DW→B turn).
  // tFinalTurnStart / tBaseTurnStart = geographic points where each turn begins.
  const {lat: tLat, lng: tLng} = state.target;
  const tFinal          = offsetLL(tLat, tLng, -fDisp.dN, -fDisp.dE);
  const tFinalTurnStart = offsetLL(tFinal.lat, tFinal.lng, -turnBF.dN, -turnBF.dE);
  const tBase           = offsetLL(tFinalTurnStart.lat, tFinalTurnStart.lng, -bDisp.dN, -bDisp.dE);
  const tBaseTurnStart  = offsetLL(tBase.lat, tBase.lng, -turnDB.dN, -turnDB.dE);
  const entry           = offsetLL(tBaseTurnStart.lat, tBaseTurnStart.lng, -dDisp.dN, -dDisp.dE);

  // ── Extra legs above downwind ─────────────────────────────────────────────
  // Each extra leg heading is user-specified via the Approach Hdg input.
  // Turns are modeled at each transition (extra→lower extra, or lowest extra→DW).
  const extraLegResults = [];
  {
    let topPoint = entry;   // bottom of the current chain (post-turn entry of lower leg)
    let topAlt   = altE;

    // Sort lowest extra altitude first so we chain correctly upward
    const extrasSorted = [...(state.extraLegs || [])]
      .map(xl => ({ ...xl, alt: parseFloat(document.getElementById(`alt-${xl.id}`)?.value) || xl.defaultAlt }))
      .filter(xl => xl.alt > 0)
      .sort((a, b) => a.alt - b.alt);

    extrasSorted.forEach((xl, i) => {
      if (xl.alt <= topAlt) return; // altitude must be above current top

      const xlPerf  = getLegPerf(xl.id);
      const dRateXL = (xlPerf.cSpd / xlPerf.glide) * FT_MIN_PER_KT;
      const xlMode  = state.legModes[xl.id] || 'crab';

      // Approach heading is user-specified via the per-leg heading input
      const nomHdg = ((parseFloat(document.getElementById(`hdg-${xl.id}`)?.value) || 0) + 3600) % 360;

      // lowerHdg: heading of the leg immediately below this one (DW or previous extra leg).
      const lowerHdg  = i === 0 ? dwHdg : extraLegResults[extraLegResults.length - 1].hdg;
      const lowerPerf = i === 0 ? perfDW : getLegPerf(extrasSorted[i - 1].id);
      const avgCSpd   = (xlPerf.cSpd + lowerPerf.cSpd) / 2;
      const avgGlide  = (xlPerf.glide + lowerPerf.glide) / 2;

      // Solve heading and displacement for a straight-leg band [altBot, xl.alt].
      // The turn altitude consumed must be SUBTRACTED from the straight band (two-pass),
      // so that the turn happens within this leg's altitude range, not below it.
      function solveXL(altBot) {
        const tXL_    = (xl.alt - altBot) / (dRateXL * tasFactor((xl.alt + altBot) / 2));
        const wXL_    = avgWindVec(altBot, xl.alt);
        const dN_     = wXL_.n * (tXL_ / 60) * FT_PER_NM;
        const dE_     = wXL_.e * (tXL_ / 60) * FT_PER_NM;
        const still_  = (xl.alt - altBot) * xlPerf.glide;
        let hdg_, disp_;
        if (xlMode === 'crab') {
          const tN = hdgVec(nomHdg).n, tE = hdgVec(nomHdg).e;
          const b  = -2 * (tN * dN_ + tE * dE_);
          const c  = dN_ ** 2 + dE_ ** 2 - still_ ** 2;
          const d  = b ** 2 - 4 * c;
          if (d < 0) console.warn(`calculate: extra leg ${xl.id} crab discriminant < 0 — using still-air fallback`);
          const k  = d >= 0 ? (-b + Math.sqrt(d)) / 2 : still_;
          const rN = tN * k - dN_, rE = tE * k - dE_;
          hdg_  = (Math.atan2(rE, rN) * R2D + 360) % 360;
          disp_ = { dN: rN + dN_, dE: rE + dE_ };
        } else {
          hdg_  = nomHdg;
          disp_ = { dN: hdgVec(nomHdg).n * still_ + dN_, dE: hdgVec(nomHdg).e * still_ + dE_ };
        }
        return { hdg: hdg_, disp: disp_, tSec: Math.round(tXL_ * 60), w: wXL_, still: still_ };
      }

      // Pass 1: full altitude band → compute turn to find altitude consumed
      const p1     = solveXL(topAlt);
      const turn1  = calcTurn(p1.hdg, lowerHdg, topAlt, avgCSpd, avgGlide, patternSign);

      // The turn happens at topAlt; its altitude is consumed from ABOVE topAlt,
      // within this leg's band — mirrors how altBstart/altFstart work for standard legs.
      const altBotStraight = Math.min(xl.alt - 50, topAlt + turn1.altConsumed);

      // Pass 2: reduced straight-leg band [altBotStraight, xl.alt]
      const p2     = solveXL(altBotStraight);
      const xlHdg  = p2.hdg;
      const xlDisp = p2.disp;
      const wXL    = p2.w;

      // Final turn with pass-2 heading
      const turnXL = calcTurn(xlHdg, lowerHdg, topAlt, avgCSpd, avgGlide, patternSign);

      // xl.exitTurnStart = where this leg's straight flight ends (turn begins)
      // xl.exit          = where the lower leg begins (after the turn)
      const xlExit          = topPoint;                                                   // post-turn, lower leg starts here
      const xlExitTurnStart = offsetLL(xlExit.lat, xlExit.lng, -turnXL.dN, -turnXL.dE); // turn begins here
      const xlEntry         = offsetLL(xlExitTurnStart.lat, xlExitTurnStart.lng, -xlDisp.dN, -xlDisp.dE);

      const xlTrackUnit = normalize({n: xlDisp.dN, e: xlDisp.dE});
      const xlCrossVec  = { n: -xlTrackUnit.e, e: xlTrackUnit.n };
      const xlTrackHdg  = (Math.atan2(xlDisp.dE, xlDisp.dN) * R2D + 360) % 360;
      let xlDrift = Math.abs(xlHdg - xlTrackHdg) % 360;
      if (xlDrift > 180) xlDrift = 360 - xlDrift;

      extraLegResults.push({
        id:            xl.id,
        entry:         xlEntry,         // top of leg (far from landing, entered first)
        exit:          xlExit,          // bottom of leg = start of lower leg (post-turn)
        exitTurnStart: xlExitTurnStart, // where straight flight ends and turn begins
        turnInfo:      turnXL,          // arc geometry for draw.js
        disp:          xlDisp,
        hdg:           xlHdg,
        nomHdg,
        trackHdg:      xlTrackHdg,
        drift:         xlDrift,
        altTop:        xl.alt,
        altBot:        topAlt,
        color:         xl.color,
        tSec:          p2.tSec,
        turnTSec:      Math.round(turnXL.tSec),
        wc:            { along: safeWC(wXL, xlTrackUnit), cross: safeWC(wXL, xlCrossVec) },
        steered:       offsetLL(xlEntry.lat, xlEntry.lng, hdgVec(xlHdg).n * p2.still, hdgVec(xlHdg).e * p2.still),
      });

      topPoint = xlEntry;
      topAlt   = xl.alt;
    });
  }

  // ── Steered heading endpoint lines ──
  const DRIFT_THRESH = state.driftThresh ?? 5;

  function trackHdgDeg(disp) { return (Math.atan2(disp.dE, disp.dN) * R2D + 360) % 360; }
  function hdgDiff(a, b) { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  const bSteered  = offsetLL(tBase.lat,  tBase.lng,  hdgVec(bHdg).n * bStillFt,       hdgVec(bHdg).e * bStillFt);
  const fSteered  = offsetLL(tFinal.lat, tFinal.lng, hdgVec(fHdgActual).n * fStillFt, hdgVec(fHdgActual).e * fStillFt);
  const dwSteered = offsetLL(entry.lat,  entry.lng,  hdgVec(dwHdg).n * dStillFt,      hdgVec(dwHdg).e * dStillFt);

  const bDrift  = hdgDiff(bHdg,       trackHdgDeg(bDisp));
  const fDrift  = hdgDiff(fHdgActual, fHdg);
  const dwDrift = hdgDiff(dwHdg,      trackHdgDeg(dDisp));

  // ── Wind components ──
  function safeWC(w, unitVec) {
    if (!isFinite(w.n) || !isFinite(w.e)) return 0;
    return Math.round(w.n * unitVec.n + w.e * unitVec.e);
  }

  const fAlong    = safeWC(wF, fTrackUnit);
  const fCrossVec = {n: -fTrackUnit.e, e: fTrackUnit.n};
  const fCross    = safeWC(wF, fCrossVec);

  const dwTrackUnit = normalize({n: dDisp.dN, e: dDisp.dE});
  const dwAlong     = safeWC(wD, dwTrackUnit);
  const dwCrossVec  = {n: -dwTrackUnit.e, e: dwTrackUnit.n};
  const dwCross     = safeWC(wD, dwCrossVec);

  const bHdgVec   = hdgVec(bHdg);
  const bAlong    = safeWC(wB, bHdgVec);
  const bCrossVec = {n: -bHdgVec.e, e: bHdgVec.n};
  const bCross    = safeWC(wB, bCrossVec);

  const fWC = {along: fAlong,  cross: fCross};
  const dWC = {along: dwAlong, cross: dwCross};
  const bWC = {along: bAlong,  cross: bCross};

  state.pattern = {
    entry, tBase, tFinal, landing: state.target,
    tBaseTurnStart, tFinalTurnStart,
    turnBF, turnDB,
    altFstart, altBstart,
    bSteered, fSteered, dwSteered,
    bDrift, fDrift, dwDrift, DRIFT_THRESH,
    fHdg, fHdgActual, bHdg, dwHdg,
    fTrackHdg: fHdg,
    bTrackHdg: trackHdgDeg(bDisp),
    dwTrackHdg: trackHdgDeg(dDisp),
    tF_sec: Math.round(tF * 60),
    tB_sec: Math.round(tB * 60),
    tD_sec: Math.round(tD * 60),
    fDisp, bDisp, dDisp,
    fWC, bWC, dWC,
    glide: perfF.glide, cSpd: perfF.cSpd,  // default for safety region calcs
    altE, altB, altF,
    altExit, altOpen, ffSpeedMph, safetyPct,
    jrHdg, jrAirspeedKts, exitSepFt,
    isZPattern,
    fieldElevFt: state.fieldElevFt,
    extraLegs: extraLegResults,
  };

  drawPattern();
}
