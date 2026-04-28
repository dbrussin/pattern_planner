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

// Freefall speed (mph) derived from the mandatory first group's type.
// Used by the canopy exit-ring calc; falls back to FS belly (120 mph) if no groups exist.
function firstGroupFallMph() {
  const g0 = state.freefall.groups[0];
  if (!g0) return 120;
  const t = GROUP_TYPES[g0.type];
  return t ? t.fallMph : 120;
}

// ── Main entry: mode dispatcher ───────────────────────────────────────────────

/**
 * Top-level entry point. Runs each enabled mode's solver, then redraws.
 * Modes (state.modes.canopy, state.modes.freefall) are independent on/off toggles.
 * Each mode writes to its own result slot (state.canopy.result, state.freefall.result) which
 * the matching draw function reads. New modes plug in here and in drawPattern().
 */
function calculate() {
  if (!state.target) return;
  if (state.modes.canopy)   calculateCanopyPattern();
  else                      state.canopy.result = null;
  if (state.modes.freefall) calculateFreefallPlan();
  else                      state.freefall.result = null;
  drawPattern();
}

// ── Freefall physics integrators ──────────────────────────────────────────────

/**
 * Integrate exit → breakoff trajectory under quadratic drag. Drag constant
 * k/m = g/v_t² is inferred from the group's terminal velocity (density-corrected
 * via tasFactor). Forward velocity along jump run starts at aircraft TAS and
 * decays as drag pulls the jumper toward the local airmass; vertical velocity
 * starts at 0 and approaches v_t (tanh-style profile) with the coupling
 * speed term ‖V‖ = √(u² + v²) so forward motion slows the vertical fall.
 *
 * Movement groups carry a sustained lateral airmass velocity v·glide along
 * jrPerp (no decay — represents steady aerodynamic glide).
 *
 * Wind drift accumulates each step using getWindAtAGL at the current altitude.
 *
 * @returns {{tSec, dN, dE, throwN, throwE, throwFt, vFinalFps}}
 *   dN/dE: total ground displacement (airmass forward + drift)
 *   throwN/E/Ft: airmass-relative forward displacement only ("throw")
 */
function integrateFreefallExitToBreakoff(altTopAGL, altBotAGL, vTermSL_fps,
                                          jrAirspeedKts, jrVec, jrPerp,
                                          lateralGlide, lateralSign) {
  let t = 0, z = altTopAGL;
  let u = jrAirspeedKts * tasFactor(z) * FPS_PER_KT;  // forward airspeed (along jrVec)
  let v = 0;                                          // vertical speed (positive down)
  let dN = 0, dE = 0;
  let throwN = 0, throwE = 0;
  const dt = FF_DT_SEC;
  // Sample positions every ~500 ft of descent so movement-group paths can be
  // rendered as a curve (forward throw decays while lateral glide grows in).
  const SAMPLE_FT      = 500;
  const pathPoints     = [{ dN: 0, dE: 0, alt: altTopAGL }];
  let   nextSampleAlt  = altTopAGL - SAMPLE_FT;
  let   safety         = 0;
  while (z > altBotAGL && safety++ < 20000) {
    const vTermAlt = vTermSL_fps * tasFactor(z);
    const kOverM   = G_FT_S2 / (vTermAlt * vTermAlt);
    const speed    = Math.sqrt(u * u + v * v);
    const a_v      = G_FT_S2 - kOverM * v * speed;
    const a_u      = -kOverM * u * speed;
    let stepSec    = dt;
    if (v > 0) {
      const remaining = z - altBotAGL;
      if (v * dt > remaining) stepSec = remaining / v;
    }
    const lat   = lateralGlide ? v * lateralGlide * lateralSign : 0;
    const w     = getWindAtAGL(z);
    const fwdN  = jrVec.n * u + jrPerp.n * lat;
    const fwdE  = jrVec.e * u + jrPerp.e * lat;
    throwN     += fwdN * stepSec;
    throwE     += fwdE * stepSec;
    dN         += (fwdN + w.n * FPS_PER_KT) * stepSec;
    dE         += (fwdE + w.e * FPS_PER_KT) * stepSec;
    v += a_v * stepSec;
    u += a_u * stepSec;
    if (u < 0) u = 0;
    z -= v * stepSec;
    t += stepSec;
    if (z <= nextSampleAlt && z > altBotAGL) {
      pathPoints.push({ dN, dE, alt: z });
      nextSampleAlt -= SAMPLE_FT;
    }
  }
  pathPoints.push({ dN, dE, alt: z });
  return {
    tSec: t,
    dN, dE,
    throwN, throwE,
    throwFt: Math.sqrt(throwN * throwN + throwE * throwE),
    vFinalFps: v,
    pathPoints,
  };
}

/**
 * Integrate breakoff → opening for a single tracking jumper. Vertical speed is
 * held at terminal v_t(z) (density-corrected); horizontal motion is along
 * trackHdg at v_t × trackGR (sustained aerodynamic glide). Wind drift
 * integrates each altitude step.
 *
 * @returns {{tSec, dN, dE, trackN, trackE}}
 */
function integrateTrackToOpening(altTopAGL, altBotAGL, vTermSL_fps, trackHdgDeg, trackGR) {
  let t = 0, z = altTopAGL;
  let dN = 0, dE = 0, trackN = 0, trackE = 0;
  const tVec = hdgVec(trackHdgDeg);
  let safety = 0;
  while (z > altBotAGL && safety++ < 20000) {
    const vTermAlt = vTermSL_fps * tasFactor(z);
    const remaining = z - altBotAGL;
    const dz       = Math.min(vTermAlt * FF_DT_SEC, remaining);
    const stepSec  = dz / vTermAlt;
    const horizFps = vTermAlt * trackGR;
    const w        = getWindAtAGL(z - dz / 2);
    trackN += tVec.n * horizFps * stepSec;
    trackE += tVec.e * horizFps * stepSec;
    dN     += (tVec.n * horizFps + w.n * FPS_PER_KT) * stepSec;
    dE     += (tVec.e * horizFps + w.e * FPS_PER_KT) * stepSec;
    z -= dz;
    t += stepSec;
  }
  return { tSec: t, dN, dE, trackN, trackE };
}

// ── Freefall (jump run) planner ───────────────────────────────────────────────

/**
 * Per-group freefall + tracking solver. For each group exits → breakoff → opening,
 * computes group center positions plus per-jumper opening positions accounting for
 * exit throw, integrated wind drift, and (for movement groups) glide-path movement.
 * Iterates exit timing so every member of every group is ≥ exitSepFt from every
 * other member at opening altitude.
 *
 * All groups exit along the jump run line: a single line through jrBase (the
 * pure-vertical-descent exit center, optionally shifted by the manual JR offset)
 * parallel to jrVec. Group #1's along-track exit position is chosen so its
 * average-member open lands at the target's along-track position; perpendicular
 * displacement of opens reflects whatever the physics produces (e.g. movement
 * glide for movement groups). Subsequent groups exit later along the same line.
 *
 * Physics (see integrateFreefallExitToBreakoff and integrateTrackToOpening):
 *  · Exit→breakoff: quadratic drag with k/m = g/v_t², coupled forward+vertical ODE,
 *    integrated at FF_DT_SEC steps. Initial forward speed = aircraft TAS at exit.
 *    Movement groups carry sustained lateral airmass velocity v·glide along jrPerp;
 *    the resulting path curves as forward throw decays and lateral glide grows in.
 *  · Breakoff→opening: per-member track at terminal vertical (density-corrected),
 *    horizontal at v_t × TRACK_GR along each member's chosen heading. Vertical
 *    formations radiate 360° from group center; movement members fan evenly
 *    within ±45° of group heading. Solo (size=1) does not track.
 */
function calculateFreefallPlan() {
  const groups = state.freefall.groups;
  if (!groups || !groups.length) { state.freefall.result = null; return; }

  const altExit = parseFloat(document.getElementById('alt-exit').value);
  const altOpen = parseFloat(document.getElementById('alt-open').value);
  if (!isFinite(altExit) || !isFinite(altOpen)) { state.freefall.result = null; return; }

  const breakoffAlt = altOpen + 1000;
  if (altExit <= breakoffAlt + 100) {
    setStatus('Exit altitude must be ≥1000 ft above breakoff (opening + 1000)');
    state.freefall.result = null;
    return;
  }

  const jrAirspeedKts = parseFloat(document.getElementById('jr-airspeed').value) || 80;
  const exitSepFt     = parseFloat(document.getElementById('exit-sep').value)    || 1500;

  // Jump run heading: prefer state.jumpRun.hdgDeg (canopy may have set it); else from
  // mean wind across exit→open band, else 0. Sync DOM display when we computed it
  // ourselves so the JR heading slider stays accurate when canopy mode is off.
  let jrHdg = state.jumpRun.hdgDeg;
  if (jrHdg == null) {
    const wExit = avgWindVec(altOpen, altExit);
    if (vecLen(wExit) > MIN_WIND_SPD_KT) {
      const windVelDir = (Math.atan2(wExit.e, wExit.n) * R2D + 360) % 360;
      jrHdg = (windVelDir + 180) % 360;
    } else {
      jrHdg = 0;
    }
    if (!state.modes.canopy) {
      const dEl = document.getElementById('jr-hdg-display');
      const sEl = document.getElementById('jr-hdg-slider');
      if (dEl) dEl.value = Math.round(jrHdg);
      if (sEl) sEl.value = Math.round(jrHdg);
    }
  }

  const jrVec  = hdgVec(jrHdg);
  const jrPerp = { n: -jrVec.e, e: jrVec.n };  // 90° right of jump run (compass right)

  // Aircraft ground speed along jump run (TAS at exit alt + along-track wind component)
  const wJr        = getWindAtAGL(altExit);
  const jrTAS      = jrAirspeedKts * tasFactor(altExit);
  const jrAlongWC  = wJr.n * jrVec.n + wJr.e * jrVec.e;
  const jrGndSpdKts = Math.max(1, jrTAS + jrAlongWC);
  const jrGndSpdFps = jrGndSpdKts * FPS_PER_KT;

  // Anchor: landing target is where group #1 opens.
  const openTarget = state.target;

  // Jump run line anchor: pure-vertical-descent exit point (relative to openTarget),
  // optionally shifted perpendicular by manual JR offset. All groups exit ALONG this line.
  const ffSpeedMph     = firstGroupFallMph();
  const ffRateFtMin    = ffSpeedMph * 88;                              // mph → ft/min
  const ffDriftAnchor  = integratedDrift(altExit, altOpen, ffRateFtMin);
  let   jrBaseN        = -ffDriftAnchor.dN;
  let   jrBaseE        = -ffDriftAnchor.dE;
  const jrOffsetEl     = document.getElementById('jr-offset');
  if (state.jumpRun.manualOffset && jrOffsetEl && jrOffsetEl.value !== '') {
    const userOffsetNm = parseFloat(jrOffsetEl.value) || 0;
    const calcOffsetFt = jrBaseN * jrPerp.n + jrBaseE * jrPerp.e;
    const dOffsetFt    = userOffsetNm * FT_PER_NM - calcOffsetFt;
    jrBaseN += jrPerp.n * dOffsetFt;
    jrBaseE += jrPerp.e * dOffsetFt;
  }

  // Per-member tracking heading list for a group (used for breakoff→open integration).
  // Movement groups: all members fan evenly within ±45° of group heading (forward fan).
  // Vertical groups: members radiate 360° from group center.
  function memberTrackHeadings(g) {
    if (g.size <= 1) return [null];
    const t = GROUP_TYPES[g.type];
    if (t.isMovement) {
      const groupHdgDeg = ((jrHdg + (g.mvmt === 'L' ? -90 : 90)) + 360) % 360;
      const hdgs = [];
      for (let i = 0; i < g.size; i++) {
        const frac   = g.size === 1 ? 0.5 : i / (g.size - 1);
        const offDeg = -45 + frac * 90;
        hdgs.push((groupHdgDeg + offDeg + 360) % 360);
      }
      return hdgs;
    }
    const hdgs = [];
    for (let i = 0; i < g.size; i++) hdgs.push((i * 360) / g.size);
    return hdgs;
  }

  // Per-group plan: physics-integrated trajectories from exit → breakoff → open.
  const plan = groups.map(g => {
    const t          = GROUP_TYPES[g.type];
    const vTermSL    = t.fallMph * FPS_PER_MPH;
    const latSign    = t.isMovement ? (g.mvmt === 'L' ? -1 : 1) : 0;
    const latGlide   = t.isMovement ? t.glide : 0;
    const ff         = integrateFreefallExitToBreakoff(
                         altExit, breakoffAlt, vTermSL,
                         jrAirspeedKts, jrVec, jrPerp, latGlide, latSign);
    const trackHdgs  = memberTrackHeadings(g);
    const memberLegs = trackHdgs.map(hdg => {
      if (hdg === null) return { dN: 0, dE: 0, tSec: 0, hdg: null };
      const tr = integrateTrackToOpening(breakoffAlt, altOpen, vTermSL, hdg, TRACK_GR);
      return { dN: tr.dN, dE: tr.dE, tSec: tr.tSec, hdg };
    });
    return {
      def: g,
      tFreefallSec: ff.tSec,
      tBreakoffSec: memberLegs[0].tSec,
      breakoffDispN: ff.dN, breakoffDispE: ff.dE,    // exit → breakoff (incl. drift + throw)
      throwN: ff.throwN,    throwE: ff.throwE,       // airmass-only forward + lateral
      throwFt: ff.throwFt,
      ffPathPoints: ff.pathPoints,                   // sampled exit→breakoff trajectory (curved)
      memberLegs,                                    // per-member breakoff → open vector
    };
  });

  // Average member breakoff→open displacement (used for along-track exit positioning
  // and rendering the group's opening center).
  function avgMemberOpenDisp(p) {
    const n = p.memberLegs.length;
    let sN = 0, sE = 0;
    p.memberLegs.forEach(m => { sN += m.dN; sE += m.dE; });
    return { dN: sN / n, dE: sE / n };
  }

  function memberOpenPositions(p, exitN, exitE) {
    const breakoffN = exitN + p.breakoffDispN;
    const breakoffE = exitE + p.breakoffDispE;
    return p.memberLegs.map(m => ({
      dN: breakoffN + m.dN,
      dE: breakoffE + m.dE,
      hdg: m.hdg,
    }));
  }

  // ── Resolve group exit positions and timing ──
  // ALL groups exit along the jump run line (passing through jrBase along jrVec).
  // Group 1: along-track position chosen so group avg-open is at openTarget along-track.
  //   Perpendicular offset from openTarget = whatever the lateral physics produces (e.g.
  //   movement glide for movement groups).
  // Subsequent groups: aircraft moves jrGndSpdFps × tDelta further along jump run line.
  // Spacing: tDelta is increased until every member of this group is ≥ exitSepFt from
  // every member of every previous group at opening altitude.
  const g1 = plan[0];
  {
    const avg = avgMemberOpenDisp(g1);
    // Place exit on JR line so along-track open position matches openTarget (along = 0).
    // exit = jrBase + alpha*jrVec; require along(exit + breakoffDisp + avg) = 0.
    const openDispN = g1.breakoffDispN + avg.dN;
    const openDispE = g1.breakoffDispE + avg.dE;
    const alpha     = -((jrBaseN + openDispN) * jrVec.n + (jrBaseE + openDispE) * jrVec.e);
    g1.tExitSec = 0;
    g1.exitN    = jrBaseN + alpha * jrVec.n;
    g1.exitE    = jrBaseE + alpha * jrVec.e;
    g1.openMemberPos = memberOpenPositions(g1, g1.exitN, g1.exitE);
  }

  for (let i = 1; i < plan.length; i++) {
    const gPrev = plan[i - 1];
    const gThis = plan[i];
    let tDelta = exitSepFt / jrGndSpdFps;
    let lastMin = 0;
    for (let iter = 0; iter < 50; iter++) {
      const exitN = gPrev.exitN + jrVec.n * jrGndSpdFps * tDelta;
      const exitE = gPrev.exitE + jrVec.e * jrGndSpdFps * tDelta;
      const cur   = memberOpenPositions(gThis, exitN, exitE);
      // Min distance to ANY member of ANY previous group at opening altitude.
      let minDist = Infinity;
      for (let j = 0; j < i; j++) {
        plan[j].openMemberPos.forEach(prev => {
          cur.forEach(c => {
            const d = Math.hypot(c.dN - prev.dN, c.dE - prev.dE);
            if (d < minDist) minDist = d;
          });
        });
      }
      lastMin = minDist;
      if (minDist >= exitSepFt) break;
      tDelta += (exitSepFt - minDist) / jrGndSpdFps + 0.1;
    }
    gThis.tDeltaSec = tDelta;
    gThis.tExitSec  = gPrev.tExitSec + tDelta;
    gThis.exitN     = gPrev.exitN + jrVec.n * jrGndSpdFps * tDelta;
    gThis.exitE     = gPrev.exitE + jrVec.e * jrGndSpdFps * tDelta;
    gThis.openMemberPos = memberOpenPositions(gThis, gThis.exitN, gThis.exitE);
    gThis.minSepFt  = lastMin;
  }
  g1.minSepFt = Infinity; // first group has no predecessor

  // Build renderer-ready result with lat/lng positions.
  const renderedGroups = plan.map(p => {
    const breakoffN = p.exitN + p.breakoffDispN;
    const breakoffE = p.exitE + p.breakoffDispE;
    const avg       = avgMemberOpenDisp(p);
    const openN     = breakoffN + avg.dN;
    const openE     = breakoffE + avg.dE;
    const isMv      = GROUP_TYPES[p.def.type].isMovement;
    // Curved exit→breakoff path: rebase sampled offsets relative to the actual exit.
    const ffPath    = (p.ffPathPoints || []).map(pp =>
      offsetLL(openTarget.lat, openTarget.lng, p.exitN + pp.dN, p.exitE + pp.dE)
    );
    return {
      id:         p.def.id,
      name:       p.def.name,
      size:       p.def.size,
      type:       p.def.type,
      mvmt:       p.def.mvmt,
      tExitSec:   p.tExitSec,
      tDeltaSec:  p.tDeltaSec ?? 0,
      tFreefall:  Math.round(p.tFreefallSec),
      tBreakoff:  Math.round(p.tBreakoffSec),
      throwFt:    Math.round(p.throwFt),
      minSepFt:   isFinite(p.minSepFt) ? Math.round(p.minSepFt) : null,
      exit:       offsetLL(openTarget.lat, openTarget.lng, p.exitN,    p.exitE),
      breakoff:   offsetLL(openTarget.lat, openTarget.lng, breakoffN,  breakoffE),
      openCenter: offsetLL(openTarget.lat, openTarget.lng, openN,      openE),
      ffPath,                                        // curved exit→breakoff trajectory
      members:    p.memberLegs.map((m, mi) => ({
        opening:  offsetLL(openTarget.lat, openTarget.lng, breakoffN + m.dN, breakoffE + m.dE),
        breakoff: offsetLL(openTarget.lat, openTarget.lng, breakoffN, breakoffE),
        hdg:      m.hdg,
        isLeader: mi === 0 && isMv,
      })),
    };
  });

  state.freefall.result = {
    openTarget,
    altExit, altOpen, breakoffAlt,
    jrHdg, jrAirspeedKts, jrGndSpdKts: Math.round(jrGndSpdKts),
    exitSepFt,
    groups: renderedGroups,
  };
}

// ── Canopy pattern solver ─────────────────────────────────────────────────────

/**
 * Canopy mode solver. Reads DOM inputs, computes wind-adjusted headings and turn
 * points for all legs, stores result in state.canopy.result. Caller (calculate()) draws.
 * No-op via early return if required inputs are NaN/invalid; validation errors
 * surface via setStatus(). Altitude ordering enforced with 100 ft minimum gaps.
 */
function calculateCanopyPattern() {
  const glide  = parseFloat(document.getElementById('glide').value);
  const cSpd   = parseFloat(document.getElementById('canopy-speed').value);
  const altE   = parseFloat(document.getElementById('alt-enter').value);
  const altB   = parseFloat(document.getElementById('alt-base').value);
  const altF   = parseFloat(document.getElementById('alt-final').value);

  const _altExit    = parseFloat(document.getElementById('alt-exit').value);
  const _altOpen    = parseFloat(document.getElementById('alt-open').value);
  const _safety     = parseFloat(document.getElementById('safety-margin').value);
  const _jrAirspeed = parseFloat(document.getElementById('jr-airspeed').value);
  const _exitSep    = parseFloat(document.getElementById('exit-sep').value);

  const bankDeg = Math.max(10, Math.min(60, parseFloat(document.getElementById('turn-bank')?.value) || 30));
  const bankRad = bankDeg * D2R;

  const altExit       = isNaN(_altExit)    ? 13500 : _altExit;
  const altOpen       = isNaN(_altOpen)    ? 3000  : _altOpen;
  // First group's type sets freefall speed for the exit ring calculation.
  const ffSpeedMph    = firstGroupFallMph();
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
  if (state.canopy.extraLegs && state.canopy.extraLegs.length > 0) {
    const extraAlts = state.canopy.extraLegs
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

  let fHdgFromBar = state.canopy.finalHeadingDeg;
  if (fHdgFromBar === null) {
    const s = state.winds.find(w => w.dirDeg !== null);
    if (!s) { setStatus('Set winds or a final heading'); return; }
    fHdgFromBar = s.dirDeg;
  }
  const fHdg = state.canopy.legHdgOverride?.f != null ? state.canopy.legHdgOverride.f : fHdgFromBar;

  // Jump run heading: mean wind across open→exit band (better spot-drift estimate
  // than single point sample); falls back to fHdg when winds are calm.
  let jrHdg = state.jumpRun.hdgDeg;
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
  const patternSign = state.canopy.hand === 'right' ? 1 : -1;

  const bOverride   = state.canopy.legHdgOverride?.b;
  const dwOverride  = state.canopy.legHdgOverride?.dw;
  const dwTrackSign = state.canopy.zPattern ? 1 : -1;
  const isZPattern  = state.canopy.zPattern;
  const fVec        = hdgVec(fHdg);

  // When an override is active, leg heading is arbitrary → use shortest path (sign=0).
  const avgCSpdBF  = (perfB.cSpd  + perfF.cSpd)  / 2;
  const avgGlideBF = (perfB.glide + perfF.glide) / 2;
  const avgCSpdDB  = (perfDW.cSpd + perfB.cSpd)  / 2;
  const avgGlideDB = (perfDW.glide + perfB.glide)/ 2;
  const bfSign = bOverride != null ? 0 : patternSign;
  const dbSign = (dwOverride != null || bOverride != null || state.canopy.zPattern) ? 0 : patternSign;

  // Solves all three standard legs; returns bundle of results or null if unflyable.
  function solveLegs(altFs, altBs) {
    // Final leg: altFs → 0
    const fStillFt = altFs * perfF.glide;
    const tF       = altFs / (dRateF * tasFactor(altFs / 2));
    const wF       = avgWindVec(0, altFs);
    const rF       = solveleg(state.canopy.legModes.f, fVec.n, fVec.e, fStillFt, wF, tF, fHdg);
    if (rF === null) return null;
    const fHdgActual = state.canopy.legModes.f === 'crab' ? rF.hdg : fHdg;
    const fDisp      = rF.disp;
    const fTrackUnit = normalize({n: fDisp.dN, e: fDisp.dE});

    // Base leg: altBs → altF
    const bTN = bOverride != null ? hdgVec(bOverride).n : (state.canopy.hand === 'left' ? -fTrackUnit.e :  fTrackUnit.e);
    const bTE = bOverride != null ? hdgVec(bOverride).e : (state.canopy.hand === 'left' ?  fTrackUnit.n : -fTrackUnit.n);
    const bStillFt = (altBs - altF) * perfB.glide;
    const tB       = (altBs - altF) / (dRateB * tasFactor((altBs + altF) / 2));
    const wB       = avgWindVec(altF, altBs);
    const bNomHdg  = bOverride ?? (state.canopy.hand === 'left' ? (fHdg + 90) % 360 : (fHdg - 90 + 360) % 360);
    const rB       = solveleg(state.canopy.legModes.b, bTN, bTE, bStillFt, wB, tB, bNomHdg);
    if (rB === null) return null;

    // Downwind leg: altE → altB (turn-consumed altitude happens BELOW this band)
    const dwTN = dwOverride != null ? hdgVec(dwOverride).n : dwTrackSign * fTrackUnit.n;
    const dwTE = dwOverride != null ? hdgVec(dwOverride).e : dwTrackSign * fTrackUnit.e;
    const dStillFt = (altE - altB) * perfDW.glide;
    const tD       = (altE - altB) / (dRateDW * tasFactor((altE + altB) / 2));
    const wD       = avgWindVec(altB, altE);
    const dwNomHdg = dwOverride ?? (state.canopy.zPattern ? fHdg : (fHdg + 180) % 360);
    const rDW      = solveleg(state.canopy.legModes.dw, dwTN, dwTE, dStillFt, wD, tD, dwNomHdg);
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
    const extrasSorted = [...(state.canopy.extraLegs || [])]
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
      const xlMode  = state.canopy.legModes[xl.id] || 'crab';

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

  state.canopy.result = {
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
}
