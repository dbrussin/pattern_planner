// ─── JUMP RUN ──────────────────────────────────────────────────────────────────
// Jump run solver shared by canopy and freefall modes: per-group freefall/tracking
// physics, inter-group exit spacing, and placement of the whole load so every jumper
// can open within reach of the pattern. Produces the single jump run line, exit ring,
// opening rings, and green/red lights that both modes render.
// Depends on: config, state, geometry, calculate (integratedDrift, avgWindVec, canopy
//             result), ui-groups (GROUP_TYPES, DEFAULT_OPEN_ALT)
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
  // For movement groups an extra sample is injected at the straight→lateral
  // transition (MVMT_STRAIGHT_SEC) so the first rendered segment is a clean
  // along-JR line rather than a blend of straight + early lateral glide.
  const SAMPLE_FT          = 500;
  const pathPoints         = [{ dN: 0, dE: 0, alt: altTopAGL }];
  let   nextSampleAlt      = altTopAGL - SAMPLE_FT;
  let   straightSampled    = !lateralGlide;  // non-movement groups skip this
  let   safety             = 0;
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
    const lat   = (lateralGlide && t >= MVMT_STRAIGHT_SEC) ? v * lateralGlide * lateralSign : 0;
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
    // Inject transition sample at the straight→lateral boundary
    if (!straightSampled && t >= MVMT_STRAIGHT_SEC) {
      pathPoints.push({ dN, dE, alt: z });
      straightSampled = true;
    }
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

// ── Jump run heading ──────────────────────────────────────────────────────────

// Into-wind heading from the mean wind between group #1's opening altitude and exit,
// or null when that wind is calm (below MIN_WIND_SPD_KT).
function autoJumpRunHeading(altExit) {
  const w = avgWindVec(firstGroupOpenAlt(), altExit);
  if (vecLen(w) <= MIN_WIND_SPD_KT) return null;
  return ((Math.atan2(w.e, w.n) * R2D + 360) % 360 + 180) % 360;
}

// ── Opening circles ───────────────────────────────────────────────────────────

// Canopy reachability circle for an opening altitude (ft AGL), in N/E ft from the
// target: open anywhere inside it and the canopy can glide to the top of the pattern.
function openingCircleAt(cr, altOpen) {
  const o     = cr.openRef;
  const drift = integratedDrift(altOpen, o.alt, o.dRate);
  return { n: o.n - drift.dN, e: o.e - drift.dE, r: Math.max(0, (altOpen - o.alt) * o.glide) };
}

// DZ reference point (DZ zero, else the landing target) in N/E ft from the target.
function dzRefNE(target) {
  const lat = parseFloat(document.getElementById('dz-zero-lat')?.value);
  const lng = parseFloat(document.getElementById('dz-zero-lng')?.value);
  return (isFinite(lat) && isFinite(lng)) ? llToNE({lat, lng}, target) : { n: 0, e: 0 };
}

// ── Load placement ────────────────────────────────────────────────────────────

/**
 * Place the whole load (a rigid set of relative opening positions — wind drift doesn't
 * depend on position, so the solved spacing is translation-invariant) by translating it
 * T = s·jrVec + t·jrPerp to minimize the worst jumper's (distance from own group's
 * opening-circle center − that circle's radius). Convex minimax → nested ternary search.
 * With tFixed (manual JR offset) only the along-track position s is searched.
 * @param {Array<{n,e,cn,ce,r}>} pts - relative opening position + its group's circle
 * @returns {{s:number, t:number, worst:number}} worst < 0 ⇒ every jumper has margin
 */
function placeLoad(pts, jrVec, jrPerp, tFixed) {
  const F = (s, t) => {
    const Tn = s * jrVec.n + t * jrPerp.n, Te = s * jrVec.e + t * jrPerp.e;
    let worst = -Infinity;
    for (const p of pts) {
      const d = Math.hypot(p.n + Tn - p.cn, p.e + Te - p.ce) - p.r;
      if (d > worst) worst = d;
    }
    return worst;
  };
  // Search around the translation that maps the mean opening onto the mean circle center.
  let mN = 0, mE = 0;
  pts.forEach(p => { mN += p.cn - p.n; mE += p.ce - p.e; });
  mN /= pts.length; mE /= pts.length;
  const span = 2 * Math.max(...pts.map(p => Math.hypot(p.cn - p.n - mN, p.ce - p.e - mE) + p.r)) + 1000;
  const ternary = (lo, hi, f) => {
    for (let i = 0; i < 40; i++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (f(a) <= f(b)) hi = b; else lo = a;
    }
    return (lo + hi) / 2;
  };
  const s0 = mN * jrVec.n + mE * jrVec.e, t0 = mN * jrPerp.n + mE * jrPerp.e;
  const bestT = s => tFixed != null ? tFixed : ternary(t0 - span, t0 + span, t => F(s, t));
  const s = ternary(s0 - span, s0 + span, s => F(s, bestT(s)));
  const t = bestT(s);
  return { s, t, worst: F(s, t) };
}

// ── Jump run solver ───────────────────────────────────────────────────────────

/**
 * Per-group freefall + tracking solver and load placement. Runs whenever either mode is
 * on (after the canopy solver, whose pattern defines the opening circles).
 *  1. Physics per group: exit→breakoff (quadratic drag, throw, movement glide), then
 *     breakoff→open tracking fan. Intra-group spread short of openSepFt is reported as
 *     `reqBreakoffAlt`.
 *  2. Spacing: greedy outward from the middle group; each group's exit offset is
 *     binary-searched so every member is ≥ openSepFt from every member of placed groups,
 *     with a MIN_EXIT_GAP_SEC floor.
 *  3. Placement: placeLoad() slides the whole load to maximize the worst-case margin
 *     inside each group's own opening circle (manual JR offset pins the lateral position).
 *  4. Green/red: earliest point on the line the first group can exit / latest point the
 *     last group can, with every member still opening inside its group's circle.
 * Writes state.jumpRun.result; returns an error message string on invalid input.
 */
function calculateJumpRun() {
  const cr     = state.canopy.result;
  const groups = state.freefall.groups;
  if (!cr) return null;
  if (!groups || !groups.length) return 'Add at least one jump run group';

  const altExit = parseFloat(document.getElementById('alt-exit').value);
  if (!isFinite(altExit)) return 'Enter an exit altitude';
  if (altExit > 25000)    return 'Exit altitude unrealistic (>25,000 ft AGL)';

  const jrAirspeedKts = parseFloat(document.getElementById('jr-airspeed').value) || 80;
  const openSepFt     = parseFloat(document.getElementById('exit-sep').value)    || 1500;
  const margin        = 1 - cr.safetyPct;
  const target        = state.target;
  const toLL          = (n, e) => offsetLL(target.lat, target.lng, n, e);

  for (const g of groups) {
    const ga = g.openAlt     ?? DEFAULT_OPEN_ALT[g.type] ?? 3000;
    const gb = g.breakoffAlt ?? (ga + 1500);
    if (altExit <= gb + 100) return `Exit altitude must be ≥100 ft above breakoff for ${g.name}`;
    if (gb <= ga + 100)      return `Breakoff must be ≥100 ft above opening for ${g.name}`;
  }

  let jrHdg = state.jumpRun.hdgDeg;
  if (jrHdg == null) {
    jrHdg = autoJumpRunHeading(altExit) ?? cr.fHdg;  // calm aloft → align with final
    const dEl = document.getElementById('jr-hdg-display');
    const sEl = document.getElementById('jr-hdg-slider');
    if (dEl) dEl.value = Math.round(jrHdg);
    if (sEl) sEl.value = Math.round(jrHdg);
  }
  const jrVec  = hdgVec(jrHdg);
  const jrPerp = { n: -jrVec.e, e: jrVec.n };  // 90° right of jump run (compass right)

  // Aircraft ground speed along jump run (TAS at exit alt + along-track wind component)
  const wJr          = getWindAtAGL(altExit);
  const jrTAS        = jrAirspeedKts * tasFactor(altExit);
  const jrGndSpdKts  = Math.max(1, jrTAS + wJr.n * jrVec.n + wJr.e * jrVec.e);
  const jrGndSpdFps  = jrGndSpdKts * FPS_PER_KT;
  const minExitGapFt = jrGndSpdFps * MIN_EXIT_GAP_SEC;

  // Per-member tracking heading list for breakoff→open integration.
  function memberTrackHeadings(g) {
    if (g.size <= 1) return [null];
    const t = GROUP_TYPES[g.type];
    if (t.isMovement) {
      const groupHdgDeg = ((jrHdg + (g.mvmt === 'L' ? -90 : 90)) + 360) % 360;
      // Leader (index 0) always at movement heading (0° offset).
      // nRight = ceil((N-1)/2) others go to the positive side, nLeft to the negative.
      // Step = 45°/nRight → furthest positive member is exactly +45°, all gaps uniform.
      const nRight = Math.ceil((g.size - 1) / 2);
      const nLeft  = g.size - 1 - nRight;
      const step   = nRight > 0 ? 45 / nRight : 45;
      const hdgs   = [groupHdgDeg];
      for (let i = nLeft; i >= 1; i--) hdgs.push((groupHdgDeg - i * step + 360) % 360);
      for (let i = 1; i <= nRight; i++) hdgs.push((groupHdgDeg + i * step + 360) % 360);
      return hdgs;
    }
    // Split fan: ceil(N/2) members on the right half-circle, floor(N/2) on the left,
    // each side half-step offset from the JR axis so nobody tracks up/down jump run.
    //   N=2 → 90°, 270°   N=3 → 45°, 135°, 270°   N=4 → 45°, 135°, 225°, 315°
    const hdgs = [];
    const rightCount = Math.ceil(g.size / 2);
    const leftCount  = g.size - rightCount;
    for (let i = 0; i < rightCount; i++)
      hdgs.push((jrHdg + (2 * i + 1) * 90 / rightCount + 360) % 360);
    for (let j = 0; j < leftCount; j++)
      hdgs.push((jrHdg + 180 + (2 * j + 1) * 90 / leftCount + 360) % 360);
    return hdgs;
  }

  // ── 1. Per-group physics ──
  const plan = groups.map(g => {
    const t           = GROUP_TYPES[g.type];
    const openAlt     = g.openAlt     ?? DEFAULT_OPEN_ALT[g.type] ?? 3000;
    const breakoffAlt = g.breakoffAlt ?? (openAlt + 1500);
    const vTermSL     = (g.vSpeedMph ?? t.fallMph) * FPS_PER_MPH;
    const latSign     = t.isMovement ? (g.mvmt === 'L' ? -1 : 1) : 0;
    const latGlide    = t.isMovement ? t.glide : 0;
    const ff          = integrateFreefallExitToBreakoff(
                          altExit, breakoffAlt, vTermSL,
                          jrAirspeedKts, jrVec, jrPerp, latGlide, latSign);
    const memberLegs  = memberTrackHeadings(g).map(hdg => {
      if (hdg === null) return { dN: 0, dE: 0, tSec: 0, hdg: null };
      const tr = integrateTrackToOpening(breakoffAlt, openAlt, vTermSL, hdg, TRACK_GR);
      return { dN: tr.dN, dE: tr.dE, tSec: tr.tSec, hdg };
    });

    // Intra-group spread: chord between adjacent tracking headings 2·band·sin(half-gap).
    let reqBreakoffAlt = null;
    if (g.size >= 2) {
      const trackBand = (breakoffAlt - openAlt) * TRACK_GR;
      const halfAngle = t.isMovement
        ? (Math.ceil((g.size - 1) / 2) > 0 ? (22.5 / Math.ceil((g.size - 1) / 2)) * D2R : 0)
        : Math.PI / (g.size % 2 === 0 ? g.size : g.size + 1);  // split fan min gap = 360°/(N or N+1)
      const sinH = Math.sin(halfAngle);
      if (sinH > 0 && 2 * trackBand * sinH < openSepFt)
        reqBreakoffAlt = Math.ceil(openAlt + openSepFt / (2 * sinH) / TRACK_GR);
    }

    // Mean exit→opening displacement of the group (breakoff + average tracking leg)
    const avgN = memberLegs.reduce((a, m) => a + m.dN, 0) / memberLegs.length;
    const avgE = memberLegs.reduce((a, m) => a + m.dE, 0) / memberLegs.length;
    return {
      def: g, openAlt, breakoffAlt,
      tFreefallSec: ff.tSec, tBreakoffSec: memberLegs[0].tSec,
      breakoffDispN: ff.dN, breakoffDispE: ff.dE,
      openDispN: ff.dN + avgN, openDispE: ff.dE + avgE,
      throwFt: ff.throwFt, ffPathPoints: ff.pathPoints,
      memberLegs, reqBreakoffAlt,
    };
  });

  // ── 2. Exit spacing (relative to an arbitrary origin; placement comes later) ──
  const SEARCH_RANGE = Math.max(openSepFt * 60, 60000);  // ft — generous upper bound
  const memberOpenPosAtOffset = (p, offsetFt) => p.memberLegs.map(m => ({
    dN: jrVec.n * offsetFt + p.breakoffDispN + m.dN,
    dE: jrVec.e * offsetFt + p.breakoffDispE + m.dE,
  }));
  const minSepFromPlaced = (p, offsetFt) => {
    const pos = memberOpenPosAtOffset(p, offsetFt);
    let minDist = Infinity;
    for (const fp of plan) {
      if (!fp._openPos) continue;
      for (const a of pos) for (const b of fp._openPos) {
        const d = Math.hypot(a.dN - b.dN, a.dE - b.dE);
        if (d < minDist) minDist = d;
      }
    }
    return minDist;
  };

  const middleIdx   = Math.floor(plan.length / 2);
  const exitOffsets = new Array(plan.length).fill(0);
  plan[middleIdx]._openPos = memberOpenPosAtOffset(plan[middleIdx], 0);
  // Later groups exit further along jump run (upwind); earlier groups before (downwind).
  for (let i = middleIdx + 1; i < plan.length; i++) {
    const prevOff = exitOffsets[i - 1];
    let lo = prevOff, hi = prevOff + SEARCH_RANGE;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (minSepFromPlaced(plan[i], mid) >= openSepFt) hi = mid; else lo = mid;
    }
    exitOffsets[i]   = Math.max(hi, prevOff + minExitGapFt);
    plan[i]._openPos = memberOpenPosAtOffset(plan[i], exitOffsets[i]);
  }
  for (let i = middleIdx - 1; i >= 0; i--) {
    const nextOff = exitOffsets[i + 1];
    let lo = nextOff - SEARCH_RANGE, hi = nextOff;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (minSepFromPlaced(plan[i], mid) >= openSepFt) lo = mid; else hi = mid;
    }
    exitOffsets[i]   = Math.min(lo, nextOff - minExitGapFt);
    plan[i]._openPos = memberOpenPosAtOffset(plan[i], exitOffsets[i]);
  }

  // ── 3. Place the load against each group's own opening circle ──
  const circles = plan.map(p => openingCircleAt(cr, p.openAlt));
  const pts = [];
  plan.forEach((p, i) => p._openPos.forEach(m =>
    pts.push({ n: m.dN, e: m.dE, cn: circles[i].n, ce: circles[i].e, r: circles[i].r * margin })));

  const dz         = dzRefNE(target);
  const jrOffsetEl = document.getElementById('jr-offset');
  // Manual offset = line's distance right of the DZ reference: (T − dz)·jrPerp = offset
  const tFixed = (state.jumpRun.manualOffset && jrOffsetEl && jrOffsetEl.value !== '')
    ? (parseFloat(jrOffsetEl.value) || 0) * FT_PER_NM + (dz.n * jrPerp.n + dz.e * jrPerp.e)
    : null;
  const place = placeLoad(pts, jrVec, jrPerp, tFixed);
  const Tn    = place.s * jrVec.n + place.t * jrPerp.n;
  const Te    = place.s * jrVec.e + place.t * jrPerp.e;

  plan.forEach((p, i) => {
    p.exitN     = Tn + jrVec.n * exitOffsets[i];
    p.exitE     = Te + jrVec.e * exitOffsets[i];
    p.tExitSec  = exitOffsets[i] / jrGndSpdFps;
    p.tDeltaSec = i > 0 ? (exitOffsets[i] - exitOffsets[i - 1]) / jrGndSpdFps : 0;
  });
  const minT = Math.min(...plan.map(p => p.tExitSec));
  plan.forEach(p => { p.tExitSec -= minT; });

  // Per-group minimum separation from any member of any other group (translation-invariant)
  plan.forEach((p, i) => {
    let ms = Infinity;
    plan.forEach((q, j) => {
      if (j === i) return;
      for (const a of p._openPos) for (const b of q._openPos) ms = Math.min(ms, Math.hypot(a.dN - b.dN, a.dE - b.dE));
    });
    p.minSepFt = isFinite(ms) ? Math.round(ms) : null;
  });

  // Exit ring: mean of each group's own exit circle (its opening circle shifted back by
  // the group's exit→opening displacement); radius = the tightest group's circle.
  let exN = 0, exE = 0;
  plan.forEach((p, i) => { exN += circles[i].n - p.openDispN; exE += circles[i].e - p.openDispE; });
  exN /= plan.length; exE /= plan.length;
  const exitR = Math.min(...circles.map(c => c.r)) * margin;

  // Line geometry in along/perp coordinates measured from the line's origin T
  const along = (n, e) => (n - Tn) * jrVec.n  + (e - Te) * jrVec.e;
  const perp  = (n, e) => (n - Tn) * jrPerp.n + (e - Te) * jrPerp.e;
  const ringA  = along(exN, exE);
  const exitAs = plan.map(p => along(p.exitN, p.exitE));

  // Valid exit window for a group along the line: where EVERY member (exit + that member's
  // exit→opening displacement) opens inside the group's own opening circle. Each member is
  // a circle–line intersection; the window is their overlap. null ⇒ nowhere on this line.
  const exitWindow = i => {
    const p = plan[i], c = circles[i], R = c.r * margin;
    let lo = -Infinity, hi = Infinity;
    for (const m of p.memberLegs) {
      const qN = Tn + p.breakoffDispN + m.dN - c.n, qE = Te + p.breakoffDispE + m.dE - c.e;
      const b  = qN * jrVec.n + qE * jrVec.e;
      const disc = b * b - (qN * qN + qE * qE) + R * R;
      if (disc < 0) return null;
      lo = Math.max(lo, -b - Math.sqrt(disc));
      hi = Math.min(hi, -b + Math.sqrt(disc));
    }
    return lo <= hi ? { lo, hi } : null;
  };
  // Green = earliest point the first group can exit; red = latest point the last group can.
  const firstWin = exitWindow(0), lastWin = exitWindow(plan.length - 1);
  const greenA   = firstWin ? firstWin.lo : null;
  const redA     = lastWin  ? lastWin.hi  : null;

  const spanAs = [...exitAs, ...(greenA != null ? [greenA] : []), ...(redA != null ? [redA] : [])];
  const aMin   = Math.min(ringA - exitR * 1.25, Math.min(...spanAs) - 1500);
  const aMax   = Math.max(ringA + exitR * 1.25, Math.max(...spanAs) + 1500);
  const onLine = a => toLL(Tn + jrVec.n * a, Te + jrVec.e * a);

  // Signed nm past the DZ reference, measured along jump run
  const dzA     = along(dz.n, dz.e);
  const greenNm = greenA != null ? (greenA - dzA) / FT_PER_NM : null;
  const redNm   = redA   != null ? (redA   - dzA) / FT_PER_NM : null;

  const openAlts = [...new Set(plan.map(p => p.openAlt))].sort((a, b) => a - b);

  state.jumpRun.result = {
    altExit, jrHdg, jrAirspeedKts, openSepFt,
    jrGndSpdKts:  Math.round(jrGndSpdKts),
    maxTDelta:    plan.length > 1 ? Math.max(...plan.slice(1).map(p => p.tDeltaSec)) : 0,
    passSec:      Math.max(...plan.map(p => p.tExitSec)),
    topAlt:       cr.openRef.alt,
    lineStart:    onLine(aMin),
    lineEnd:      onLine(aMax),
    lineMid:      onLine(ringA),
    greenPt:      greenA != null ? onLine(greenA) : null,
    redPt:        redA   != null ? onLine(redA)   : null,
    calcOffsetNm: -perp(dz.n, dz.e) / FT_PER_NM,
    greenNm, redNm,
    openMarginFt: Math.round(-place.worst),
    exitRing:     { center: toLL(exN, exE), radiusFt: exitR },
    openRings:    openAlts.map(alt => {
      const c = openingCircleAt(cr, alt);
      return { alt, center: toLL(c.n, c.e), radiusFt: c.r * margin };
    }),
    groups: plan.map(p => {
      const brN = p.exitN + p.breakoffDispN, brE = p.exitE + p.breakoffDispE;
      const isMv = GROUP_TYPES[p.def.type].isMovement;
      return {
        id: p.def.id, name: p.def.name, size: p.def.size, type: p.def.type, mvmt: p.def.mvmt,
        openAlt:        p.openAlt,
        breakoffAlt:    p.breakoffAlt,
        tExitSec:       p.tExitSec,
        tDeltaSec:      p.tDeltaSec,
        tFreefall:      Math.round(p.tFreefallSec),
        tBreakoff:      Math.round(p.tBreakoffSec),
        throwFt:        Math.round(p.throwFt),
        minSepFt:       p.minSepFt,
        reqBreakoffAlt: p.reqBreakoffAlt,
        exit:           toLL(p.exitN, p.exitE),
        breakoff:       toLL(brN, brE),
        openCenter:     toLL(p.exitN + p.openDispN, p.exitE + p.openDispE),
        ffPath:         (p.ffPathPoints || []).map(pp => toLL(p.exitN + pp.dN, p.exitE + pp.dE)),
        members: p.memberLegs.map((m, mi) => ({
          opening:  toLL(brN + m.dN, brE + m.dE),
          breakoff: toLL(brN, brE),
          hdg:      m.hdg,
          isLeader: mi === 0 && isMv,
        })),
      };
    }),
  };
  return null;
}
