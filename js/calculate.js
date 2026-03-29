// ─── CALCULATE ─────────────────────────────────────────────────────────────────
// Core pattern solver and wind-integration helpers.
// Depends on: config, state, geometry, ui (getLegPerf, setStatus, updateJumpRunDisplay)

// Compute integrated wind drift (ft N, ft E) during descent from altTopAGL to altBotAGL.
function integratedDrift(altTopAGL, altBotAGL, descentFtMin) {
  if (altTopAGL <= altBotAGL) return {dN: 0, dE: 0};
  const STEP = 200;
  let dN = 0, dE = 0;
  for (let agl = altBotAGL; agl < altTopAGL; agl += STEP) {
    const bandTop = Math.min(agl + STEP, altTopAGL);
    const midAGL  = (agl + bandTop) / 2;
    const bandAlt = bandTop - agl;
    const w       = getWindAtAGL(midAGL);
    const tMin    = bandAlt / descentFtMin;
    dN += w.n * (tMin / 60) * 6076;
    dE += w.e * (tMin / 60) * 6076;
  }
  return {dN, dE};
}

// Average wind speed/direction across an altitude band (used for zone labels).
function avgWindInBand(altBotAGL, altTopAGL) {
  const STEP = 200;
  let sumN = 0, sumE = 0, count = 0;
  for (let agl = altBotAGL; agl < altTopAGL; agl += STEP) {
    const mid = (agl + Math.min(agl + STEP, altTopAGL)) / 2;
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

// ── Main pattern solver ───────────────────────────────────────────────────────

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

  const altExit       = isNaN(_altExit)    ? 13500 : _altExit;
  const altOpen       = isNaN(_altOpen)    ? 3000  : _altOpen;
  const ffSpeedMph    = isNaN(_ffSpeed)    ? 120   : _ffSpeed;
  const safetyPct     = (isNaN(_safety)   ? 0     : _safety) / 100;
  const jrAirspeedKts = isNaN(_jrAirspeed) ? 80   : _jrAirspeed;
  const exitSepFt     = isNaN(_exitSep)    ? 1500 : _exitSep;

  if (isNaN(glide) || isNaN(cSpd) || isNaN(altE) || isNaN(altB) || isNaN(altF)) return;
  if (altB >= altE || altF >= altB) { setStatus('Altitudes must be: Enter > Base > Final'); return; }

  let fHdg = state.finalHeadingDeg;
  if (fHdg === null) {
    const s = state.winds.find(w => w.dirDeg !== null);
    if (!s) { setStatus('Set winds or a final heading'); return; }
    fHdg = s.dirDeg;
  }

  // Jump run heading (needs fHdg as fallback for calm winds)
  let jrHdg = state.jumpRunHdgDeg;
  if (jrHdg === null) {
    const wExit      = getWindAtAGL(altExit);
    const exitWindSpd = vecLen(wExit);
    if (exitWindSpd > 0.5) {
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
  const dRateF  = (perfF.cSpd  / perfF.glide)  * 101.269;
  const dRateB  = (perfB.cSpd  / perfB.glide)  * 101.269;
  const dRateDW = (perfDW.cSpd / perfDW.glide) * 101.269;

  const tF = altF / dRateF;
  const tB = (altB - altF) / dRateB;
  const tD = (altE - altB) / dRateDW;

  // ── Final leg ──
  const wF       = getWindAtAGL(altF / 2);
  const fVec     = hdgVec(fHdg);
  const fStillFt = altF * perfF.glide;
  let fDisp, fHdgActual;

  if (state.legModes.f === 'crab') {
    const dfN = wF.n * (tF / 60) * 6076, dfE = wF.e * (tF / 60) * 6076;
    const bfc = -2 * (fVec.n * dfN + fVec.e * dfE);
    const cfc = dfN ** 2 + dfE ** 2 - fStillFt ** 2;
    const dfc = bfc ** 2 - 4 * cfc;
    const kf  = dfc >= 0 ? (-bfc + Math.sqrt(Math.max(0, dfc))) / 2 : fStillFt;
    const fRN = fVec.n * kf - dfN, fRE = fVec.e * kf - dfE;
    fHdgActual = (Math.atan2(fRE, fRN) * R2D + 360) % 360;
    fDisp      = {dN: fRN + dfN, dE: fRE + dfE};
  } else {
    fHdgActual = fHdg;
    fDisp = {dN: fVec.n * fStillFt + wF.n * (tF / 60) * 6076, dE: fVec.e * fStillFt + wF.e * (tF / 60) * 6076};
  }

  const {lat: tLat, lng: tLng} = state.target;
  const tFinal     = offsetLL(tLat, tLng, -fDisp.dN, -fDisp.dE);
  const fTrackUnit = normalize({n: fDisp.dN, e: fDisp.dE});

  // ── Base leg ──
  const wB       = getWindAtAGL((altB + altF) / 2);
  const bStillFt = (altB - altF) * perfB.glide;
  let bHdg, bDisp;

  if (state.legModes.b === 'crab') {
    const bTN = state.hand === 'left' ? -fTrackUnit.e :  fTrackUnit.e;
    const bTE = state.hand === 'left' ?  fTrackUnit.n : -fTrackUnit.n;
    const dbN = wB.n * (tB / 60) * 6076, dbE = wB.e * (tB / 60) * 6076;
    const bc  = -2 * (bTN * dbN + bTE * dbE);
    const cc  = dbN ** 2 + dbE ** 2 - bStillFt ** 2;
    const bd  = bc ** 2 - 4 * cc;
    const bk  = bd >= 0 ? (-bc + Math.sqrt(Math.max(0, bd))) / 2 : bStillFt;
    const bRN = bTN * bk - dbN, bRE = bTE * bk - dbE;
    bHdg  = (Math.atan2(bRE, bRN) * R2D + 360) % 360;
    bDisp = {dN: bRN + dbN, dE: bRE + dbE};
  } else {
    bHdg  = state.hand === 'left' ? (fHdg + 90) % 360 : (fHdg - 90 + 360) % 360;
    bDisp = {dN: hdgVec(bHdg).n * bStillFt + wB.n * (tB / 60) * 6076, dE: hdgVec(bHdg).e * bStillFt + wB.e * (tB / 60) * 6076};
  }
  const tBase = offsetLL(tFinal.lat, tFinal.lng, -bDisp.dN, -bDisp.dE);

  // ── Downwind leg ──
  const wD       = getWindAtAGL((altE + altB) / 2);
  const dStillFt = (altE - altB) * perfDW.glide;
  const driftN   = wD.n * (tD / 60) * 6076, driftE = wD.e * (tD / 60) * 6076;
  let dwHdg, dDisp;

  // Target track direction: Z=upwind (fTrackUnit), normal=downwind (-fTrackUnit)
  const dwTrackSign = state.zPattern ? 1 : -1;
  const isZPattern  = state.zPattern;

  if (state.legModes.dw === 'crab') {
    const tN = dwTrackSign * fTrackUnit.n, tE = dwTrackSign * fTrackUnit.e;
    const b1 = -2 * (tN * driftN + tE * driftE);
    const c1 = driftN ** 2 + driftE ** 2 - dStillFt ** 2;
    const d1 = b1 ** 2 - 4 * c1;
    const k1 = d1 >= 0 ? (-b1 + Math.sqrt(Math.max(0, d1))) / 2 : dStillFt;
    const rN = tN * k1 - driftN, rE = tE * k1 - driftE;
    dwHdg = (Math.atan2(rE, rN) * R2D + 360) % 360;
    dDisp = {dN: rN + driftN, dE: rE + driftE};
  } else {
    // Drift: steer in target track direction, drift freely
    dwHdg = state.zPattern ? fHdg : (fHdg + 180) % 360;
    dDisp = {dN: hdgVec(dwHdg).n * dStillFt + driftN, dE: hdgVec(dwHdg).e * dStillFt + driftE};
  }
  const entry = offsetLL(tBase.lat, tBase.lng, -dDisp.dN, -dDisp.dE);

  // ── Steered heading endpoint lines ──
  const DRIFT_THRESH = 5; // degrees — only show steered heading line when drift is meaningful

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
    bSteered, fSteered, dwSteered,
    bDrift, fDrift, dwDrift, DRIFT_THRESH,
    fHdg, fHdgActual, bHdg, dwHdg,
    fDisp, bDisp, dDisp,
    fWC, bWC, dWC,
    glide: perfF.glide, cSpd: perfF.cSpd,  // default for safety region calcs
    altE, altB, altF,
    altExit, altOpen, ffSpeedMph, safetyPct,
    jrHdg, jrAirspeedKts, exitSepFt,
    isZPattern,
    fieldElevFt: state.fieldElevFt,
  };

  drawPattern();
}
