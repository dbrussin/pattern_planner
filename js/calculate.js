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
    const tMin    = bandAlt / (descentFtMin * tasFactor(midAGL));
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

  const tF = altF / (dRateF * tasFactor(altF / 2));
  const tB = (altB - altF) / (dRateB * tasFactor((altB + altF) / 2));
  const tD = (altE - altB) / (dRateDW * tasFactor((altE + altB) / 2));

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

  const bOverride = state.legHdgOverride?.b;
  const bTN = bOverride != null ? hdgVec(bOverride).n : (state.hand === 'left' ? -fTrackUnit.e :  fTrackUnit.e);
  const bTE = bOverride != null ? hdgVec(bOverride).e : (state.hand === 'left' ?  fTrackUnit.n : -fTrackUnit.n);

  if (state.legModes.b === 'crab') {
    const dbN = wB.n * (tB / 60) * 6076, dbE = wB.e * (tB / 60) * 6076;
    const bc  = -2 * (bTN * dbN + bTE * dbE);
    const cc  = dbN ** 2 + dbE ** 2 - bStillFt ** 2;
    const bd  = bc ** 2 - 4 * cc;
    const bk  = bd >= 0 ? (-bc + Math.sqrt(Math.max(0, bd))) / 2 : bStillFt;
    const bRN = bTN * bk - dbN, bRE = bTE * bk - dbE;
    bHdg  = (Math.atan2(bRE, bRN) * R2D + 360) % 360;
    bDisp = {dN: bRN + dbN, dE: bRE + dbE};
  } else {
    bHdg  = bOverride ?? (state.hand === 'left' ? (fHdg + 90) % 360 : (fHdg - 90 + 360) % 360);
    bDisp = {dN: hdgVec(bHdg).n * bStillFt + wB.n * (tB / 60) * 6076, dE: hdgVec(bHdg).e * bStillFt + wB.e * (tB / 60) * 6076};
  }
  const tBase = offsetLL(tFinal.lat, tFinal.lng, -bDisp.dN, -bDisp.dE);

  // ── Downwind leg ──
  const wD       = getWindAtAGL((altE + altB) / 2);
  const dStillFt = (altE - altB) * perfDW.glide;
  const driftN   = wD.n * (tD / 60) * 6076, driftE = wD.e * (tD / 60) * 6076;
  let dwHdg, dDisp;

  // Target track direction: override > Z=upwind (fTrackUnit) > normal=downwind (-fTrackUnit)
  const dwOverride = state.legHdgOverride?.dw;
  let dwTN, dwTE;
  if (dwOverride != null) {
    dwTN = hdgVec(dwOverride).n;
    dwTE = hdgVec(dwOverride).e;
  } else {
    const dwTrackSign = state.zPattern ? 1 : -1;
    dwTN = dwTrackSign * fTrackUnit.n;
    dwTE = dwTrackSign * fTrackUnit.e;
  }
  const isZPattern = state.zPattern;

  if (state.legModes.dw === 'crab') {
    const b1 = -2 * (dwTN * driftN + dwTE * driftE);
    const c1 = driftN ** 2 + driftE ** 2 - dStillFt ** 2;
    const d1 = b1 ** 2 - 4 * c1;
    const k1 = d1 >= 0 ? (-b1 + Math.sqrt(Math.max(0, d1))) / 2 : dStillFt;
    const rN = dwTN * k1 - driftN, rE = dwTE * k1 - driftE;
    dwHdg = (Math.atan2(rE, rN) * R2D + 360) % 360;
    dDisp = {dN: rN + driftN, dE: rE + driftE};
  } else {
    // Drift: steer in target track direction, drift freely
    dwHdg = dwOverride ?? (state.zPattern ? fHdg : (fHdg + 180) % 360);
    dDisp = {dN: hdgVec(dwHdg).n * dStillFt + driftN, dE: hdgVec(dwHdg).e * dStillFt + driftE};
  }
  const entry = offsetLL(tBase.lat, tBase.lng, -dDisp.dN, -dDisp.dE);

  // ── Extra legs above downwind ─────────────────────────────────────────────
  // Each extra leg heading is user-specified via the Approach Hdg input.
  const extraLegResults = [];
  {
    let topPoint = entry;
    let topAlt   = altE;

    // Sort lowest extra altitude first so we chain correctly upward
    const extrasSorted = [...(state.extraLegs || [])]
      .map(xl => ({ ...xl, alt: parseFloat(document.getElementById(`alt-${xl.id}`)?.value) || xl.defaultAlt }))
      .filter(xl => xl.alt > 0)
      .sort((a, b) => a.alt - b.alt);

    extrasSorted.forEach((xl, i) => {
      if (xl.alt <= topAlt) return; // altitude must be above current top

      const xlPerf   = getLegPerf(xl.id);
      const dRateXL  = (xlPerf.cSpd / xlPerf.glide) * 101.269;
      const tXL      = (xl.alt - topAlt) / (dRateXL * tasFactor((xl.alt + topAlt) / 2));
      const wXL      = getWindAtAGL((xl.alt + topAlt) / 2);
      const driftXLN = wXL.n * (tXL / 60) * 6076;
      const driftXLE = wXL.e * (tXL / 60) * 6076;

      // Approach heading is user-specified via the per-leg heading input
      const nomHdg = ((parseFloat(document.getElementById(`hdg-${xl.id}`)?.value) || 0) + 3600) % 360;

      const xStillFt = (xl.alt - topAlt) * xlPerf.glide;
      let xlHdg, xlDisp;
      const xlMode = state.legModes[xl.id] || 'crab';

      if (xlMode === 'crab') {
        const tN = hdgVec(nomHdg).n, tE = hdgVec(nomHdg).e;
        const b1 = -2 * (tN * driftXLN + tE * driftXLE);
        const c1 = driftXLN ** 2 + driftXLE ** 2 - xStillFt ** 2;
        const d1 = b1 ** 2 - 4 * c1;
        const k1 = d1 >= 0 ? (-b1 + Math.sqrt(Math.max(0, d1))) / 2 : xStillFt;
        const rN = tN * k1 - driftXLN, rE = tE * k1 - driftXLE;
        xlHdg  = (Math.atan2(rE, rN) * R2D + 360) % 360;
        xlDisp = { dN: rN + driftXLN, dE: rE + driftXLE };
      } else {
        xlHdg  = nomHdg;
        xlDisp = { dN: hdgVec(xlHdg).n * xStillFt + driftXLN, dE: hdgVec(xlHdg).e * xStillFt + driftXLE };
      }

      const xlEntry     = offsetLL(topPoint.lat, topPoint.lng, -xlDisp.dN, -xlDisp.dE);
      const xlTrackUnit = normalize({n: xlDisp.dN, e: xlDisp.dE});
      const xlCrossVec  = { n: -xlTrackUnit.e, e: xlTrackUnit.n };
      const xlTrackHdg  = (Math.atan2(xlDisp.dE, xlDisp.dN) * R2D + 360) % 360;
      let xlDrift = Math.abs(xlHdg - xlTrackHdg) % 360;
      if (xlDrift > 180) xlDrift = 360 - xlDrift;

      extraLegResults.push({
        id:       xl.id,
        entry:    xlEntry,       // top of leg (far from landing, entered first)
        exit:     topPoint,      // bottom of leg (closer to landing)
        disp:     xlDisp,
        hdg:      xlHdg,
        nomHdg,
        trackHdg: xlTrackHdg,
        drift:    xlDrift,
        altTop:   xl.alt,
        altBot:   topAlt,
        color:    xl.color,
        tSec:     Math.round(tXL * 60),
        wc:       { along: safeWC(wXL, xlTrackUnit), cross: safeWC(wXL, xlCrossVec) },
        steered:  offsetLL(xlEntry.lat, xlEntry.lng, hdgVec(xlHdg).n * xStillFt, hdgVec(xlHdg).e * xStillFt),
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
