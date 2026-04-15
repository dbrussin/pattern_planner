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
 * Average wind vector {n, e} over an altitude band using 200 ft steps.
 * More accurate than a single midpoint sample for legs spanning large altitude ranges.
 * Used for straight-leg heading and displacement calculations in calculate().
 * @param {number} altBot - Bottom of band (ft AGL)
 * @param {number} altTop - Top of band (ft AGL)
 * @returns {{n: number, e: number}} Average wind vector (kts, north/east velocity)
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

/**
 * Vector-mean wind across a band, returned in {spd, dir} form for zone labels.
 * `dir` is the VELOCITY direction (where the wind blows toward, degrees true),
 * NOT the conventional meteorological "from" direction. Callers that display
 * a "from" arrow should add 180°.
 * @param {number} altBotAGL - Bottom of band (ft AGL)
 * @param {number} altTopAGL - Top of band (ft AGL)
 * @returns {{spd: number, dir: number}} Vector-mean wind speed (kts, rounded)
 *   and velocity direction (° true, rounded).
 */
function avgWindInBand(altBotAGL, altTopAGL) {
  const w = avgWindVec(altBotAGL, altTopAGL);
  return {
    spd: Math.round(Math.sqrt(w.n ** 2 + w.e ** 2)),
    dir: Math.round((Math.atan2(w.e, w.n) * R2D + 360) % 360),
  };
}

// Project wind vector onto a unit vector; returns rounded scalar component (kts).
// Positive = along unit vector direction (tailwind for track unit); negative = head.
function safeWC(w, unitVec) {
  if (!isFinite(w.n) || !isFinite(w.e)) return 0;
  return Math.round(w.n * unitVec.n + w.e * unitVec.e);
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
  // Upper-bound sanity (defense-in-depth; HTML min/max are the primary guard)
  if (altE    > 10000) { setStatus('Pattern entry altitude unrealistic (>10,000 ft AGL)'); return; }
  if (altExit > 25000) { setStatus('Exit altitude unrealistic (>25,000 ft AGL)');          return; }
  if (altOpen > 10000) { setStatus('Opening altitude unrealistic (>10,000 ft AGL)');       return; }
  if (altOpen < altF + 100) { setStatus('Opening altitude must be above pattern Final');   return; }
  if (cSpd    <= 0 || cSpd > 60)  { setStatus('Canopy speed must be between 1 and 60 kts'); return; }
  if (glide   <= 0 || glide > 10) { setStatus('Glide ratio must be between 0 and 10:1');    return; }
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

  // Jump run heading: mean wind across open→exit band (better spot-drift estimate
  // than single point sample); falls back to fHdg when winds are calm.
  let jrHdg = state.jumpRunHdgDeg;
  if (jrHdg === null) {
    const wExit       = avgWindVec(altOpen, altExit);
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
  // Models a coordinated banked turn from h1 to h2 at altAGL. Returns displacement,
  // time, altitude consumed, and arc geometry for draw.js.
  // Descent rate in turn ≈ IAS-sink × (1/cos θ) — first-order (1/cos²θ is closer
  // for ram-air at steep banks; error is small for 20°–45° pattern banks).
  function calcTurn(h1, h2, altAGL, cSpd, glide, patternSign = 0) {
    let dh = ((h2 - h1 + 540) % 360) - 180;            // signed shortest path (°)
    // patternSign forces turn direction for standard legs; 0 = shortest path
    // (used for extra legs whose headings are user-specified).
    if (patternSign !== 0) {
      if (patternSign > 0 && dh < 0) dh += 360;
      if (patternSign < 0 && dh > 0) dh -= 360;
    }
    const dhRad = Math.abs(dh) * D2R;
    if (dhRad < 0.001) {
      return {dN: 0, dE: 0, tSec: 0, altConsumed: 0, R: 0, h1, h2, dh: 0, sign: 1, w: getWindAtAGL(altAGL)};
    }
    const tas    = cSpd * tasFactor(altAGL);            // TAS (kts)
    const v_ft_s = tas * FT_MIN_PER_KT / 60;            // TAS (ft/s)
    const omega  = G_FT_S2 * Math.tan(bankRad) / v_ft_s;// turn rate (rad/s)
    const R      = v_ft_s / omega;                      // turn radius (ft)
    const tSec   = dhRad / omega;                       // turn time (s)
    const tMin   = tSec / 60;
    const sign   = dh > 0 ? 1 : -1;                     // +1 = right turn, -1 = left
    const hAvg   = (h1 + dh / 2 + 360) % 360;           // avg heading during arc
    const hv     = hdgVec(hAvg);
    const chord  = 2 * R * Math.sin(dhRad / 2);         // arc chord length (ft)
    const dRateTurn = (cSpd / glide) * FT_MIN_PER_KT * tasFactor(altAGL) / Math.cos(bankRad);
    const altConsumed = dRateTurn * tMin;
    // Sample wind at the turn's midpoint altitude (best representative sample).
    const altMid = Math.max(0, altAGL - altConsumed / 2);
    const w      = getWindAtAGL(altMid);
    return {
      dN:          hv.n * chord + w.n * (tMin / 60) * FT_PER_NM,
      dE:          hv.e * chord + w.e * (tMin / 60) * FT_PER_NM,
      tSec,
      altConsumed,
      R, h1, h2, dh, sign, w,   // arc geometry for draw.js
    };
  }

  // Solve crab/drift heading+displacement. Returns null if crab crosswind > canopy speed.
  function solveleg(mode, trackN, trackE, stillFt, w, tMin, nomHdg) {
    const driftN = w.n * (tMin / 60) * FT_PER_NM, driftE = w.e * (tMin / 60) * FT_PER_NM;
    if (mode === 'crab') {
      const bc = -2 * (trackN * driftN + trackE * driftE);
      const cc = driftN ** 2 + driftE ** 2 - stillFt ** 2;
      const bd = bc ** 2 - 4 * cc;
      if (bd < 0) return null;               // crosswind > canopy speed → unflyable
      const k  = (-bc + Math.sqrt(bd)) / 2;
      if (k <= 0) return null;               // degenerate (wind overpowers canopy)
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

  // +1 = right-hand pattern (right turns), -1 = left-hand; breaks shortest-arc ambiguity.
  const patternSign = state.hand === 'right' ? 1 : -1;

  const bOverride   = state.legHdgOverride?.b;
  const dwOverride  = state.legHdgOverride?.dw;
  const dwTrackSign = state.zPattern ? 1 : -1;
  const isZPattern  = state.zPattern;
  const fVec        = hdgVec(fHdg);

  // When an override is active, leg heading is arbitrary → use shortest path (sign=0).
  const avgCSpdBF  = (perfB.cSpd  + perfF.cSpd)  / 2;
  const avgGlideBF = (perfB.glide + perfF.glide) / 2;
  const avgCSpdDB  = (perfDW.cSpd + perfB.cSpd)  / 2;
  const avgGlideDB = (perfDW.glide + perfB.glide)/ 2;
  const bfSign = bOverride != null ? 0 : patternSign;
  const dbSign = (dwOverride != null || bOverride != null || state.zPattern) ? 0 : patternSign;

  // Solves all three standard legs; returns bundle of results or null if unflyable.
  function solveLegs(altFs, altBs) {
    // Final leg: altFs → 0
    const fStillFt = altFs * perfF.glide;
    const tF       = altFs / (dRateF * tasFactor(altFs / 2));
    const wF       = avgWindVec(0, altFs);
    const rF       = solveleg(state.legModes.f, fVec.n, fVec.e, fStillFt, wF, tF, fHdg);
    if (rF === null) return null;
    const fHdgActual = state.legModes.f === 'crab' ? rF.hdg : fHdg;
    const fDisp      = rF.disp;
    const fTrackUnit = normalize({n: fDisp.dN, e: fDisp.dE});

    // Base leg: altBs → altF
    const bTN = bOverride != null ? hdgVec(bOverride).n : (state.hand === 'left' ? -fTrackUnit.e :  fTrackUnit.e);
    const bTE = bOverride != null ? hdgVec(bOverride).e : (state.hand === 'left' ?  fTrackUnit.n : -fTrackUnit.n);
    const bStillFt = (altBs - altF) * perfB.glide;
    const tB       = (altBs - altF) / (dRateB * tasFactor((altBs + altF) / 2));
    const wB       = avgWindVec(altF, altBs);
    const bNomHdg  = bOverride ?? (state.hand === 'left' ? (fHdg + 90) % 360 : (fHdg - 90 + 360) % 360);
    const rB       = solveleg(state.legModes.b, bTN, bTE, bStillFt, wB, tB, bNomHdg);
    if (rB === null) return null;

    // Downwind leg: altE → altB (turn-consumed altitude happens BELOW this band)
    const dwTN = dwOverride != null ? hdgVec(dwOverride).n : dwTrackSign * fTrackUnit.n;
    const dwTE = dwOverride != null ? hdgVec(dwOverride).e : dwTrackSign * fTrackUnit.e;
    const dStillFt = (altE - altB) * perfDW.glide;
    const tD       = (altE - altB) / (dRateDW * tasFactor((altE + altB) / 2));
    const wD       = avgWindVec(altB, altE);
    const dwNomHdg = dwOverride ?? (state.zPattern ? fHdg : (fHdg + 180) % 360);
    const rDW      = solveleg(state.legModes.dw, dwTN, dwTE, dStillFt, wD, tD, dwNomHdg);
    if (rDW === null) return null;

    return {
      fHdgActual, fDisp, fTrackUnit, tF, wF, fStillFt,
      bHdg: rB.hdg, bDisp: rB.disp,                           tB, wB, bStillFt,
      dwHdg: rDW.hdg, dDisp: rDW.disp,                         tD, wD, dStillFt,
    };
  }

  // Fixed-point iteration: solve legs → recompute turn alt consumption → feed back.
  // Converges in 2–3 iterations typical; capped at 5.
  let altFstart = altF, altBstart = altB;
  let legs = solveLegs(altFstart, altBstart);
  if (legs === null) { setStatus('Crosswind exceeds canopy speed on one or more legs — pattern unflyable'); return; }

  let turnBF, turnDB;
  for (let iter = 0; iter < 5; iter++) {
    turnBF = calcTurn(legs.bHdg, legs.fHdgActual, altF, avgCSpdBF, avgGlideBF, bfSign);
    turnDB = calcTurn(legs.dwHdg, legs.bHdg,      altB, avgCSpdDB, avgGlideDB, dbSign);

    const newAltFstart = altF - turnBF.altConsumed;
    const newAltBstart = altB - turnDB.altConsumed;

    // Hard failure: turn consumes more altitude than available.
    if (newAltFstart < 50) {
      setStatus('Base→Final turn consumes too much altitude — raise Turn Final or reduce bank angle');
      return;
    }
    if (newAltBstart < newAltFstart + 50) {
      setStatus('Downwind→Base turn consumes too much altitude — raise Turn Base or reduce bank angle');
      return;
    }

    const converged =
      Math.abs(newAltFstart - altFstart) < 0.5 &&
      Math.abs(newAltBstart - altBstart) < 0.5;

    altFstart = newAltFstart;
    altBstart = newAltBstart;
    legs = solveLegs(altFstart, altBstart);
    if (legs === null) { setStatus('Crosswind exceeds canopy speed on one or more legs — pattern unflyable'); return; }

    if (converged) break;
  }

  // Final recompute of turns with converged leg headings.
  turnBF = calcTurn(legs.bHdg, legs.fHdgActual, altF, avgCSpdBF, avgGlideBF, bfSign);
  turnDB = calcTurn(legs.dwHdg, legs.bHdg,      altB, avgCSpdDB, avgGlideDB, dbSign);

  const {
    fHdgActual, fDisp, fTrackUnit, tF, wF, fStillFt,
    bHdg, bDisp, tB, wB, bStillFt,
    dwHdg, dDisp, tD, wD, dStillFt,
  } = legs;

  // Backward position chain: landing ← tFinal ← tBase ← entry, with turn-start points.
  const {lat: tLat, lng: tLng} = state.target;
  const tFinal          = offsetLL(tLat, tLng, -fDisp.dN, -fDisp.dE);
  const tFinalTurnStart = offsetLL(tFinal.lat, tFinal.lng, -turnBF.dN, -turnBF.dE);
  const tBase           = offsetLL(tFinalTurnStart.lat, tFinalTurnStart.lng, -bDisp.dN, -bDisp.dE);
  const tBaseTurnStart  = offsetLL(tBase.lat, tBase.lng, -turnDB.dN, -turnDB.dE);
  const entry           = offsetLL(tBaseTurnStart.lat, tBaseTurnStart.lng, -dDisp.dN, -dDisp.dE);

  // Extra legs above downwind (user-specified headings; turns at each transition).
  const extraLegResults = [];
  {
    let topPoint = entry;   // bottom of the current chain (post-turn entry of lower leg)
    let topAlt   = altE;

    // Sort lowest extra altitude first so we chain correctly upward
    const extrasSorted = [...(state.extraLegs || [])]
      .map(xl => ({ ...xl, alt: parseFloat(document.getElementById(`alt-${xl.id}`)?.value) || xl.defaultAlt }))
      .filter(xl => xl.alt > 0)
      .sort((a, b) => a.alt - b.alt);

    // Use a classic for loop so that early `return` inside the body bails out of
    // calculate() (a `return` inside .forEach() would only skip the iteration).
    for (let i = 0; i < extrasSorted.length; i++) {
      const xl = extrasSorted[i];
      if (xl.alt <= topAlt) continue; // altitude must be above current top

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

      // Two-pass: pass 1 solves full band; pass 2 subtracts turn-consumed alt from
      // the bottom so the turn fits inside this leg's altitude range.
      function solveXL(altBot) {
        const tXL_    = (xl.alt - altBot) / (dRateXL * tasFactor((xl.alt + altBot) / 2));
        const wXL_    = avgWindVec(altBot, xl.alt);
        const still_  = (xl.alt - altBot) * xlPerf.glide;
        const tN      = hdgVec(nomHdg).n;
        const tE      = hdgVec(nomHdg).e;
        const r       = solveleg(xlMode, tN, tE, still_, wXL_, tXL_, nomHdg);
        if (r === null) return null;
        return { hdg: r.hdg, disp: r.disp, tSec: Math.round(tXL_ * 60), w: wXL_, still: still_ };
      }

      const p1 = solveXL(topAlt);
      if (p1 === null) { setStatus(`Extra leg ${xl.id}: crosswind exceeds canopy speed — unflyable`); return; }
      const turn1XL = calcTurn(p1.hdg, lowerHdg, topAlt, avgCSpd, avgGlide, 0);

      // Cap band so it never collapses below 50 ft.
      const altBotStraight = Math.min(xl.alt - 50, topAlt + turn1XL.altConsumed);

      const p2 = solveXL(altBotStraight);
      if (p2 === null) { setStatus(`Extra leg ${xl.id}: crosswind exceeds canopy speed — unflyable`); return; }
      const xlHdg  = p2.hdg;
      const xlDisp = p2.disp;
      const wXL    = p2.w;

      const turnXL = calcTurn(xlHdg, lowerHdg, topAlt, avgCSpd, avgGlide, 0);

      const xlExit          = topPoint;                                                 // post-turn, lower leg starts here
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
    }
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

  // Wind components measured against GROUND TRACK so along = head/tail wind in all modes.
  const fAlong    = safeWC(wF, fTrackUnit);
  const fCrossVec = {n: -fTrackUnit.e, e: fTrackUnit.n};
  const fCross    = safeWC(wF, fCrossVec);

  const dwTrackUnit = normalize({n: dDisp.dN, e: dDisp.dE});
  const dwAlong     = safeWC(wD, dwTrackUnit);
  const dwCrossVec  = {n: -dwTrackUnit.e, e: dwTrackUnit.n};
  const dwCross     = safeWC(wD, dwCrossVec);

  const bTrackUnit = normalize({n: bDisp.dN, e: bDisp.dE});
  const bCrossVec  = {n: -bTrackUnit.e, e: bTrackUnit.n};
  const bAlong     = safeWC(wB, bTrackUnit);
  const bCross     = safeWC(wB, bCrossVec);

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
