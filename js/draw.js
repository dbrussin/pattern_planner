// ─── DRAW ──────────────────────────────────────────────────────────────────────
// Leaflet map visualization: pattern legs, safety zones, jump run, labels.
// Depends on: config, state, geometry, calculate (integratedDrift, avgWindInBand)
// Accesses globals: map, patternLayers (declared in app.js)

function clearPattern() { patternLayers.forEach(l => map.removeLayer(l)); patternLayers = []; }
function addL(l)        { l.addTo(map); patternLayers.push(l); return l; }
function ll(o)          { return [o.lat, o.lng]; }
function midLL(a, b)    { return {lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2}; }
function dft(d)         { return Math.round(Math.sqrt(d.dN ** 2 + d.dE ** 2)); }

function pinIcon(color) {
  return L.divIcon({
    html: `<div style="width:12px;height:12px;border:2px solid ${color};background:${color}33;border-radius:50%;"></div>`,
    iconSize: [12, 12], iconAnchor: [6, 6], className: '',
  });
}

// Compute the arc length (ft) a canopy flies through a banked turn.
// Arc length = R × |Δh_rad|, which is always ≥ the chord displacement magnitude.
function turnArcLen(turn) {
  if (!turn || !turn.R || !turn.dh) return 0;
  return Math.round(turn.R * Math.abs(turn.dh) * D2R);
}

function legLabel(disp, wc, color, legSec, totalDist, totalSec) {
  const dist       = totalDist != null ? totalDist : dft(disp);
  const displaySec = totalSec  != null ? totalSec  : legSec;
  const {along, cross} = wc;

  function compLabel(val, type) {
    const abs = Math.abs(val || 0);
    if (abs < 1) return null;
    return type === 'along' ? `${abs}kt ${val > 0 ? 'tail' : 'head'}` : `${abs}kt cross`;
  }

  const alongLbl  = compLabel(along, 'along');
  const crossLbl  = compLabel(cross, 'cross');
  const primary   = Math.abs(along || 0) >= Math.abs(cross || 0) ? alongLbl : crossLbl;
  const secondary = Math.abs(along || 0) >= Math.abs(cross || 0) ? crossLbl : alongLbl;

  const shadow   = '0 1px 4px #000,0 0 8px #000';
  const distLine = `<div style="font-family:'Barlow Condensed',sans-serif;font-size:17px;font-weight:700;color:${color};letter-spacing:0.04em;text-shadow:${shadow};">${dist.toLocaleString()}ft</div>`;
  const pri  = primary   ? `<div style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:600;color:${color};text-shadow:${shadow};">${primary}</div>` : '';
  const sec  = secondary ? `<div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:400;color:${color};text-shadow:${shadow};">${secondary}</div>` : '';
  const calm = (!primary && !secondary) ? `<div style="font-family:'Barlow Condensed',sans-serif;font-size:14px;color:${color};text-shadow:${shadow};">calm</div>` : '';
  const secLine = displaySec != null ? `<div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:400;color:${color};opacity:0.75;text-shadow:${shadow};">${displaySec}s</div>` : '';

  return L.divIcon({
    html: `<div style="text-align:center;pointer-events:none;line-height:1.3;">${distLine}${pri}${sec}${calm}${secLine}</div>`,
    iconSize: [100, 72], iconAnchor: [50, 36], className: '',
  });
}

function hdgLabelIcon(trackHdg, steerHdg, showSteer, color) {
  const shadow = '0 1px 4px #000,0 0 8px #000';
  const trackLine = `<div style="font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:600;color:${color};text-shadow:${shadow};white-space:nowrap;">track ${Math.round(trackHdg)}°</div>`;
  const steerLine = showSteer
    ? `<div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:400;color:${color};opacity:0.7;text-shadow:${shadow};white-space:nowrap;">steer ${Math.round(steerHdg)}°</div>`
    : '';
  return L.divIcon({
    html: `<div style="text-align:center;pointer-events:none;line-height:1.3;">${trackLine}${steerLine}</div>`,
    iconSize: [130, 40], iconAnchor: [65, 20], className: '',
  });
}

function steerLineLabelIcon(steerHdg, color) {
  const shadow = '0 1px 4px #000,0 0 8px #000';
  return L.divIcon({
    html: `<div style="font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;color:${color};opacity:0.85;text-shadow:${shadow};white-space:nowrap;pointer-events:none;">steer ${Math.round(steerHdg)}°</div>`,
    iconSize: [100, 16], iconAnchor: [50, 8], className: '',
  });
}

function legChevron(from, to, trackHdg, color) {
  const mid = midLL(from, to);
  const chevronSvg = `<svg width="14" height="14" viewBox="0 0 12 12" style="display:block;">
    <polyline points="3,10 6,2 9,10" fill="none" stroke="${color}"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
      transform="rotate(${Math.round(trackHdg)},6,6)"/>
  </svg>`;
  return L.marker(ll(mid), {
    icon: L.divIcon({html: chevronSvg, iconSize: [14, 14], iconAnchor: [7, 7], className: ''}),
    interactive: false, zIndexOffset: 43,
  });
}

// ── Main entry: mode dispatcher ───────────────────────────────────────────────

/**
 * Top-level render. Clears previous map layers, then renders each enabled mode.
 * Modes (state.modes.canopy, state.modes.freefall) are independent on/off.
 * Each mode's renderer reads from its own state slot and is responsible for
 * conditional layer visibility via state.layers.* flags.
 */
function drawPattern() {
  clearPattern();
  if (state.modes.canopy)   drawCanopyPattern();
  if (state.modes.freefall) drawFreefallPlan();
}

/**
 * Freefall renderer stub — populated by future jump run planner / movement planner.
 * Will read state.freefall (groups, exit timing, drift tracks, breakoff points).
 */
function drawFreefallPlan() { /* no-op until freefall mode is implemented */ }

// ── Canopy pattern renderer ───────────────────────────────────────────────────

/**
 * Render the canopy landing pattern from state.pattern. Caller (drawPattern)
 * has already cleared previous layers. Conditional on state.layers flags:
 * - Ground track polylines (solid, leg colors) and steered heading lines (dashed)
 * - Turn point markers and extra leg markers
 * - Canopy entry rings, opening ring, exit ring (safety zones)
 * - Jump run line with direction chevron and green/red light label
 * - Turn altitude labels, leg distance/wind/timing labels, heading labels, directional arrows
 * - Wind arrow at landing target
 * Fits map bounds on first draw per target (state.fitDone = false).
 */
function drawCanopyPattern() {
  const p = state.pattern; if (!p) return;
  const {entry, tBase, tFinal, landing, tBaseTurnStart, tFinalTurnStart,
         bSteered, fSteered, dwSteered, bDrift, fDrift, dwDrift} = p;
  const DRIFT_THRESH = state.driftThresh ?? 5;

  // Small marker for the point where a straight leg ends and the turn arc begins
  function turnStartIcon(color) {
    return L.divIcon({
      html: `<div style="width:7px;height:7px;border:2px solid ${color};border-radius:50%;opacity:0.65;"></div>`,
      iconSize: [7, 7], iconAnchor: [3, 3], className: '',
    });
  }

  // Build a polyline point array for a curved banked-turn arc.
  // Arc sweeps from turnStart by dh° around a center R ft perpendicular to h1,
  // with accumulated wind drift w at each fraction f along the arc.
  function turnArcPoints(turnStart, turn) {
    const {h1, dh, sign, R, w, tSec} = turn;
    if (!R || !tSec) return [ll(turnStart)];
    const steps = Math.max(8, Math.ceil(Math.abs(dh) / 8));
    const c1 = hdgVec((h1 + sign * 90 + 360) % 360);   // center direction from turnStart
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const f   = i / steps;
      const c2  = hdgVec((h1 + dh * f - sign * 90 + 360) % 360); // center→canopy at fraction f
      const arcN = R * c1.n + R * c2.n;
      const arcE = R * c1.e + R * c2.e;
      const wN   = w.n * (f * tSec / 3600) * FT_PER_NM;  // wind drift (ft)
      const wE   = w.e * (f * tSec / 3600) * FT_PER_NM;
      pts.push(ll(offsetLL(turnStart.lat, turnStart.lng, arcN + wN, arcE + wE)));
    }
    return pts;
  }

  // Ground track lines (solid, ending at turn-start points)
  addL(L.polyline([ll(entry),          ll(tBaseTurnStart)],  {color: '#f4944d', weight: 3, opacity: 0.9}));
  addL(L.polyline([ll(tBase),          ll(tFinalTurnStart)], {color: '#4df4c8', weight: 3, opacity: 0.9}));
  addL(L.polyline([ll(tFinal),         ll(landing)],         {color: '#e8f44d', weight: 3, opacity: 0.95}));

  // Turn arcs (actual curved path, colored to match the following leg)
  addL(L.polyline(turnArcPoints(tBaseTurnStart,  p.turnDB), {color: '#4df4c8', weight: 3, opacity: 0.9}));
  addL(L.polyline(turnArcPoints(tFinalTurnStart, p.turnBF), {color: '#e8f44d', weight: 3, opacity: 0.95}));

  // Steered heading lines (dashed, colored to match leg) when drift is significant
  if (dwDrift > DRIFT_THRESH) addL(L.polyline([ll(entry),  ll(dwSteered)], {color: 'rgba(244,148,77,0.6)',  weight: 2, dashArray: '6 4'}));
  if (bDrift  > DRIFT_THRESH) addL(L.polyline([ll(tBase),  ll(bSteered)],  {color: 'rgba(77,244,200,0.6)',  weight: 2, dashArray: '6 4'}));
  if (fDrift  > DRIFT_THRESH) addL(L.polyline([ll(tFinal), ll(fSteered)],  {color: 'rgba(232,244,77,0.6)',  weight: 2, dashArray: '6 4'}));

  // Leg-start markers (post-turn positions, where the new leg heading begins)
  addL(L.marker(ll(entry),  {icon: pinIcon('#f4944d'), zIndexOffset: 100}));
  addL(L.marker(ll(tBase),  {icon: pinIcon('#4df4c8'), zIndexOffset: 100}));
  addL(L.marker(ll(tFinal), {icon: pinIcon('#e8f44d'), zIndexOffset: 100}));

  // Turn-start markers (smaller rings, colored to match following leg)
  addL(L.marker(ll(tBaseTurnStart),  {icon: turnStartIcon('#4df4c8'), zIndexOffset: 90}));
  addL(L.marker(ll(tFinalTurnStart), {icon: turnStartIcon('#e8f44d'), zIndexOffset: 90}));

  // Extra legs above downwind
  if (p.extraLegs?.length) {
    p.extraLegs.forEach((xl, xlIdx) => {
      // The exit turn at the bottom of each extra leg transitions into the lower leg;
      // color it to match the lower leg so every altitude band is one consistent color.
      const lowerColor = xlIdx === 0 ? '#f4944d' : p.extraLegs[xlIdx - 1].color;
      addL(L.polyline([ll(xl.entry), ll(xl.exitTurnStart)], {color: xl.color, weight: 3, opacity: 0.9}));
      if (xl.turnInfo) {
        addL(L.polyline(turnArcPoints(xl.exitTurnStart, xl.turnInfo), {color: lowerColor, weight: 3, opacity: 0.9}));
      } else {
        addL(L.polyline([ll(xl.exitTurnStart), ll(xl.exit)], {color: lowerColor, weight: 3, opacity: 0.9}));
      }
      if (xl.drift > DRIFT_THRESH)
        addL(L.polyline([ll(xl.entry), ll(xl.steered)], {color: xl.color, weight: 2, opacity: 0.5, dashArray: '6 4'}));
      addL(L.marker(ll(xl.entry),         {icon: pinIcon(xl.color),        zIndexOffset: 100}));
      addL(L.marker(ll(xl.exitTurnStart), {icon: turnStartIcon(lowerColor), zIndexOffset: 90}));
    });
  }

  // ── Zones, jump run, labels ──
  {
    const dRate  = (p.cSpd / p.glide) * FT_MIN_PER_KT;
    const margin = 1 - p.safetyPct;

    // Topmost pattern entry point: highest extra leg entry (if any), else downwind entry
    const topEntry  = p.extraLegs?.length ? p.extraLegs[p.extraLegs.length - 1].entry  : entry;
    const topAltAGL = p.extraLegs?.length ? p.extraLegs[p.extraLegs.length - 1].altTop : p.altE;

    // Draw one circle zone; returns center point
    function drawZone(centerAGL, radiusFt, driftAGL, borderColor, fillColor, fillOpacity, borderOpacity, borderWidth) {
      const drift = integratedDrift(driftAGL.top, driftAGL.bot, driftAGL.rate);
      const r     = radiusFt * margin * 0.3048; // metres, with safety margin
      const ctr   = offsetLL(topEntry.lat, topEntry.lng, -drift.dN, -drift.dE);
      addL(L.circle([ctr.lat, ctr.lng], {
        radius: r, color: borderColor, weight: borderWidth,
        fill: false, interactive: false,
      }));
      return ctr;
    }

    // Zone label placed on the upwind border of the circle
    function zoneLabel(ctr, radiusFt, txt, color, windVelDir) {
      const radiusM        = radiusFt * margin * 0.3048;
      const radiusFtActual = radiusM / 0.3048;
      const upwindHdg      = (windVelDir + 180) % 360;
      const upwindVec      = hdgVec(upwindHdg);
      const labelPt        = offsetLL(ctr.lat, ctr.lng,
        upwindVec.n * (radiusFtActual + 100),
        upwindVec.e * (radiusFtActual + 100));

      const arrowSvg = `<svg width="12" height="12" viewBox="0 0 14 14" style="display:inline-block;vertical-align:middle;margin-right:3px;flex-shrink:0;">
        <polygon points="7,1 12,13 7,10 2,13" fill="${color}" transform="rotate(${windVelDir},7,7)"/>
      </svg>`;

      addL(L.marker(ll(labelPt), {
        icon: L.divIcon({
          html: `<div style="font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;
            color:${color};text-shadow:0 1px 4px #000,0 0 8px #000;white-space:nowrap;
            text-align:center;pointer-events:none;line-height:1.4;display:flex;align-items:center;justify-content:center;">
            ${arrowSvg}${txt}</div>`,
          iconSize: [160, 20], iconAnchor: [80, 10], className: '',
        }),
        interactive: false, zIndexOffset: 40,
      }));
    }

    // ── Shared geometry (used by multiple layers) ──
    const canopyRange  = p.altOpen - topAltAGL;
    const openDrift    = integratedDrift(p.altOpen, topAltAGL, dRate);
    const openRadiusFt = canopyRange * p.glide;
    const openCtr      = offsetLL(topEntry.lat, topEntry.lng, -openDrift.dN, -openDrift.dE);
    const ffRateFtMin2 = p.ffSpeedMph * 88;
    const ffDrift2     = integratedDrift(p.altExit, p.altOpen, ffRateFtMin2);
    const exitCenter   = offsetLL(openCtr.lat, openCtr.lng, -ffDrift2.dN, -ffDrift2.dE);

    // ── Canopy entry rings + opening ring ──
    if (state.layers.canopyRegions) {
      const hStep3     = canopyRange / 3;
      const ringColors = [
        {fill: 'rgba(255,160,40,1)', border: 'rgba(255,180,60,0.85)', fillOp: 0, bw: 2},
        {fill: 'rgba(255,160,40,1)', border: 'rgba(255,180,60,0.65)', fillOp: 0, bw: 2},
        {fill: 'rgba(255,160,40,1)', border: 'rgba(255,180,60,0.45)', fillOp: 0, bw: 2},
      ];

      [2, 1, 0].forEach(i => {
        const h      = hStep3 * (i + 1);
        const topAGL = topAltAGL + h;
        const botAGL = topAltAGL;
        const rc     = ringColors[i];
        const ctr    = drawZone(
          topAltAGL, h * p.glide,
          {top: topAGL, bot: botAGL, rate: dRate},
          rc.border, rc.fill, rc.fillOp, 1, rc.bw
        );
        const avg      = avgWindInBand(botAGL, topAGL);
        const altLabel = Math.round(topAltAGL + h).toLocaleString();
        zoneLabel(ctr, h * p.glide,
          `${altLabel}ft · ${avg.spd}kt`,
          rc.border.replace(/[\d.]+\)$/, '1)'),
          avg.dir);
      });

      // ── Opening altitude ring ──
      const openAvg = avgWindInBand(topAltAGL, p.altOpen);
      addL(L.circle([openCtr.lat, openCtr.lng], {
        radius: openRadiusFt * margin * 0.3048,
        color: 'rgba(255,210,80,0.95)', weight: 2.5,
        fill: false, interactive: false,
      }));
      zoneLabel(openCtr, openRadiusFt,
        `Open ${p.altOpen.toLocaleString()}ft · ${openAvg.spd}kt`,
        'rgba(255,220,100,1)', openAvg.dir);
    } // end canopyRegions

    // ── Exit ring ──
    if (state.layers.exitRegion) {
      const ffAvg = avgWindInBand(p.altOpen, p.altExit);
      addL(L.circle([exitCenter.lat, exitCenter.lng], {
        radius: openRadiusFt * margin * 0.3048,
        color: 'rgba(160,220,255,0.95)', weight: 2.5,
        fill: false, interactive: false, dashArray: '8 5',
      }));
      zoneLabel(exitCenter, openRadiusFt,
        `Exit ${p.altExit.toLocaleString()}ft · ${ffAvg.spd}kt`,
        'rgba(180,230,255,1)', ffAvg.dir);
    }

    // ── Jump run line ──
    if (state.layers.jumpRun) {
      const jrVec      = hdgVec(p.jrHdg);
      const jrRightVec = {n: jrVec.e, e: -jrVec.n}; // 90° right of heading

      // Use DZ reference zero point (if set) instead of landing target for offset/green/red calcs
      const dzZeroLatEl = document.getElementById('dz-zero-lat');
      const dzZeroLngEl = document.getElementById('dz-zero-lng');
      const dzZeroLat = dzZeroLatEl && dzZeroLatEl.value !== '' ? parseFloat(dzZeroLatEl.value) : NaN;
      const dzZeroLng = dzZeroLngEl && dzZeroLngEl.value !== '' ? parseFloat(dzZeroLngEl.value) : NaN;
      const dzRef = (isFinite(dzZeroLat) && isFinite(dzZeroLng))
        ? {lat: dzZeroLat, lng: dzZeroLng}
        : p.landing;

      // Natural offset = perpendicular distance from DZ reference point to the line through exit center
      const landToExitN  = (exitCenter.lat - dzRef.lat) * R_FT * D2R;
      const landToExitE  = (exitCenter.lng - dzRef.lng) * R_FT * Math.cos(dzRef.lat * D2R) * D2R;
      const calcOffsetFt = landToExitN * jrRightVec.n + landToExitE * jrRightVec.e;
      const calcOffsetNm = calcOffsetFt / 6076;

      const jrOffsetEl = document.getElementById('jr-offset');
      if (!state.manualJrOffset) {
        jrOffsetEl.value       = calcOffsetNm.toFixed(2);
        jrOffsetEl.style.color = 'var(--muted)';
      }

      const jrBase = state.manualJrOffset
        ? offsetLL(exitCenter.lat, exitCenter.lng,
            jrRightVec.n * ((parseFloat(jrOffsetEl.value) || 0) - calcOffsetNm) * 6076,
            jrRightVec.e * ((parseFloat(jrOffsetEl.value) || 0) - calcOffsetNm) * 6076)
        : {lat: exitCenter.lat, lng: exitCenter.lng};

      const exitR      = openRadiusFt * margin * 0.3048;
      const extFt      = (exitR / 0.3048) * 1.25;
      const jrUpwind   = offsetLL(jrBase.lat, jrBase.lng,  jrVec.n * extFt,  jrVec.e * extFt);
      const jrDownwind = offsetLL(jrBase.lat, jrBase.lng, -jrVec.n * extFt, -jrVec.e * extFt);

      addL(L.polyline([ll(jrDownwind), ll(jrUpwind)], {
        color: 'rgba(160,220,255,0.85)', weight: 2, dashArray: '8 5', interactive: false,
      }));

      // Direction chevron at center of jump run line
      const chevronSvg = `<svg width="14" height="14" viewBox="0 0 12 12" style="display:block;">
        <polyline points="3,10 6,2 9,10" fill="none" stroke="rgba(160,220,255,0.95)"
          stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
          transform="rotate(${p.jrHdg},6,6)"/>
      </svg>`;
      addL(L.marker(ll(jrBase), {
        icon: L.divIcon({html: chevronSvg, iconSize: [14, 14], iconAnchor: [7, 7], className: ''}),
        interactive: false, zIndexOffset: 43,
      }));

      // Ground speed + green/red light distances
      const wJr      = getWindAtAGL(p.altExit);
      const jrWC     = wJr.n * jrVec.n + wJr.e * jrVec.e;
      const jrTAS    = p.jrAirspeedKts * tasFactor(p.altExit);
      const jrGndSpd = Math.round(jrTAS + jrWC);
      const gsFps    = jrGndSpd * 6076 / 3600;
      const sepSec   = gsFps > 0 ? Math.ceil(p.exitSepFt / gsFps) : null;

      // Intersect jump run line with exit circle for green/red light distances
      const jrBaseToExitN = (exitCenter.lat - jrBase.lat) * R_FT * D2R;
      const jrBaseToExitE = (exitCenter.lng - jrBase.lng) * R_FT * Math.cos(jrBase.lat * D2R) * D2R;
      const exitRFt  = openRadiusFt * margin;
      const proj2    = jrBaseToExitN * jrVec.n + jrBaseToExitE * jrVec.e;
      const distSq2  = jrBaseToExitN ** 2 + jrBaseToExitE ** 2;
      const disc2    = proj2 ** 2 - (distSq2 - exitRFt ** 2);
      // Use DZ reference point for tRef (distance along jump run from DZ ref to base)
      const dzToBaseN = (dzRef.lat - jrBase.lat) * R_FT * D2R;
      const dzToBaseE = (dzRef.lng - jrBase.lng) * R_FT * Math.cos(jrBase.lat * D2R) * D2R;
      const tRef     = dzToBaseN * jrVec.n + dzToBaseE * jrVec.e;

      const greenEl = document.getElementById('green-light-override');
      const redEl   = document.getElementById('red-light-override');
      let greenTxt = '', redTxt = '';
      if (disc2 >= 0) {
        const t1 = proj2 - Math.sqrt(disc2);
        const t2 = proj2 + Math.sqrt(disc2);

        // Calculated values as signed nm from DZ ref
        const calcGreenNm = (t1 - tRef) / FT_PER_NM;
        const calcRedNm   = (t2 - tRef) / FT_PER_NM;

        // Update input fields if not manually set
        if (greenEl && !state.manualGreenLight) {
          greenEl.value       = calcGreenNm.toFixed(2);
          greenEl.style.color = 'var(--muted)';
        }
        if (redEl && !state.manualRedLight) {
          redEl.value       = calcRedNm.toFixed(2);
          redEl.style.color = 'var(--muted)';
        }

        // Use manual override or calculated value for label
        const activeGreenNm = state.manualGreenLight && greenEl && greenEl.value !== ''
          ? parseFloat(greenEl.value) : calcGreenNm;
        const activeRedNm   = state.manualRedLight   && redEl   && redEl.value   !== ''
          ? parseFloat(redEl.value)   : calcRedNm;

        const fmtNm = nm => {
          const word = nm >= 0 ? 'past' : 'prior';
          return `${Math.abs(nm).toFixed(1)}nm ${word}`;
        };
        greenTxt = ` · 🟢 ${fmtNm(activeGreenNm)}`;
        redTxt   = ` · 🔴 ${fmtNm(activeRedNm)}`;
      } else {
        // No intersection — clear fields if not manually set
        if (greenEl && !state.manualGreenLight) { greenEl.value = ''; greenEl.style.color = 'var(--muted)'; }
        if (redEl   && !state.manualRedLight)   { redEl.value   = ''; redEl.style.color   = 'var(--muted)'; }
      }

      const sepTxt          = sepSec ? ` · ${sepSec}s sep` : '';
      const displayOffsetNm = state.manualJrOffset ? parseFloat(jrOffsetEl.value) || 0 : calcOffsetNm;
      const offsetTxt       = `${displayOffsetNm >= 0 ? '+' : ''}${displayOffsetNm.toFixed(1)}nm`;
      const jrLabelPt       = offsetLL(jrDownwind.lat, jrDownwind.lng, -jrVec.n * 250, -jrVec.e * 250);

      addL(L.marker(ll(jrLabelPt), {
        icon: L.divIcon({
          html: `<div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;
            color:rgba(160,220,255,1);text-shadow:0 1px 5px #000,0 0 10px #000;
            white-space:nowrap;pointer-events:none;text-align:center;line-height:1.5;">
            Jump run ${Math.round(p.jrHdg)}° · ${jrGndSpd}kt GS · ${offsetTxt}${sepTxt}${greenTxt}${redTxt}
          </div>`,
          iconSize: [460, 34], iconAnchor: [230, 0], className: '',
        }),
        interactive: false, zIndexOffset: 45,
      }));
    } // end jumpRun

  } // end zones block

  // ── Shared leg label geometry ──
  function offsetMid(a, b, disp, perpFt) {
    const mid      = midLL(a, b);
    const trackLen = Math.sqrt(disp.dN ** 2 + disp.dE ** 2) || 1;
    const pN = -disp.dE / trackLen * perpFt;
    const pE =  disp.dN / trackLen * perpFt;
    return offsetLL(mid.lat, mid.lng, pN, pE);
  }
  const perpFt = 130;
  const side   = state.hand === 'left' ? 1 : -1;

  // ── Turn altitude labels ──
  if (state.layers.turnAltLabels) {
    const turnLabelIcon = (txt, color) => L.divIcon({
      html: `<div style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;
        color:${color};text-shadow:0 1px 5px #000,0 0 10px #000;white-space:nowrap;
        letter-spacing:0.04em;pointer-events:none;">${txt}</div>`,
      iconSize: [100, 20], iconAnchor: [-6, 10], className: '',
    });
    // Labels placed at the start of the turn arc that begins each leg's altitude band,
    // matching altB/altF which are at tBaseTurnStart/tFinalTurnStart respectively.
    // DW: if extra legs exist, the XL→DW arc starts at extraLegs[0].exitTurnStart; else entry.
    // Extra legs: the arc entering leg[i] starts at extraLegs[i+1].exitTurnStart (if it exists).
    const dwAltLabelPt = p.extraLegs?.length ? p.extraLegs[0].exitTurnStart : entry;
    addL(L.marker(ll(dwAltLabelPt),    {icon: turnLabelIcon(`${p.altE}ft AGL`, '#f4944d'), interactive: false, zIndexOffset: 60}));
    addL(L.marker(ll(tBaseTurnStart),  {icon: turnLabelIcon(`${p.altB}ft AGL`, '#4df4c8'), interactive: false, zIndexOffset: 60}));
    addL(L.marker(ll(tFinalTurnStart), {icon: turnLabelIcon(`${p.altF}ft AGL`, '#e8f44d'), interactive: false, zIndexOffset: 60}));
    p.extraLegs?.forEach((xl, xlIdx) => {
      const labelPt = xlIdx < p.extraLegs.length - 1 ? p.extraLegs[xlIdx + 1].exitTurnStart : xl.entry;
      addL(L.marker(ll(labelPt), {icon: turnLabelIcon(`${xl.altTop}ft AGL`, xl.color), interactive: false, zIndexOffset: 60}));
    });
  }

  // ── Leg distance / wind / timing labels ──
  // Each leg's label covers its own altitude band: its exit turn arc plus straight flight.
  // DW→Base arc belongs to Base; Base→Final arc belongs to Final.
  // Each extra leg's exit arc belongs to that extra leg (mirrors DW→Base attribution:
  // the turn altitude is consumed from the leg that executes the turn, so it shows there).
  // DW has no incoming arc — the lowest extra leg's exit turn is already shown on that leg.
  if (state.layers.legDistances) {
    const dwMid = offsetMid(entry,  tBaseTurnStart,  p.dDisp, side * perpFt);
    const bMid  = offsetMid(tBase,  tFinalTurnStart, p.bDisp, side * perpFt);
    const fMid  = offsetMid(tFinal, landing,         p.fDisp, side * perpFt);
    // Base: incoming arc = DW→Base turn
    const bTotalDist  = turnArcLen(p.turnDB) + dft(p.bDisp);
    const bTotalSec   = (p.turnDB?.tSec != null ? Math.round(p.turnDB.tSec) : 0) + p.tB_sec;
    // Final: incoming arc = Base→Final turn
    const fTotalDist  = turnArcLen(p.turnBF) + dft(p.fDisp);
    const fTotalSec   = (p.turnBF?.tSec != null ? Math.round(p.turnBF.tSec) : 0) + p.tF_sec;
    addL(L.marker(ll(dwMid), {icon: legLabel(p.dDisp, p.dWC, '#f4944d', p.tD_sec, null, null), interactive: false, zIndexOffset: 50}));
    addL(L.marker(ll(bMid),  {icon: legLabel(p.bDisp, p.bWC, '#4df4c8', p.tB_sec, bTotalDist,  bTotalSec),  interactive: false, zIndexOffset: 50}));
    addL(L.marker(ll(fMid),  {icon: legLabel(p.fDisp, p.fWC, '#e8f44d', p.tF_sec, fTotalDist,  fTotalSec),  interactive: false, zIndexOffset: 50}));
    p.extraLegs?.forEach((xl) => {
      const xlMid = offsetMid(xl.entry, xl.exitTurnStart, xl.disp, side * perpFt);
      // Each extra leg's total includes its own exit turn (the turn it performs when leaving)
      const xlTotalDist = turnArcLen(xl.turnInfo) + dft(xl.disp);
      const xlTotalSec  = (xl.turnTSec || 0) + xl.tSec;
      addL(L.marker(ll(xlMid), {icon: legLabel(xl.disp, xl.wc, xl.color, xl.tSec, xlTotalDist, xlTotalSec), interactive: false, zIndexOffset: 50}));
    });
  }

  // ── Heading labels (track + steered) ──
  if (state.layers.legHeadings) {
    // Track + steer heading labels on opposite perpendicular side from distance labels
    const dwMidH = offsetMid(entry,  tBaseTurnStart,  p.dDisp, -side * perpFt);
    const bMidH  = offsetMid(tBase,  tFinalTurnStart, p.bDisp, -side * perpFt);
    const fMidH  = offsetMid(tFinal, landing,         p.fDisp, -side * perpFt);
    addL(L.marker(ll(dwMidH), {icon: hdgLabelIcon(p.dwTrackHdg, p.dwHdg, dwDrift > DRIFT_THRESH, '#f4944d'), interactive: false, zIndexOffset: 50}));
    addL(L.marker(ll(bMidH),  {icon: hdgLabelIcon(p.bTrackHdg,  p.bHdg,  bDrift  > DRIFT_THRESH, '#4df4c8'), interactive: false, zIndexOffset: 50}));
    addL(L.marker(ll(fMidH),  {icon: hdgLabelIcon(p.fTrackHdg,  p.fHdgActual, fDrift > DRIFT_THRESH, '#e8f44d'), interactive: false, zIndexOffset: 50}));
    p.extraLegs?.forEach(xl => {
      const xlMidH = offsetMid(xl.entry, xl.exitTurnStart, xl.disp, -side * perpFt);
      addL(L.marker(ll(xlMidH), {icon: hdgLabelIcon(xl.trackHdg, xl.hdg, xl.drift > DRIFT_THRESH, xl.color), interactive: false, zIndexOffset: 50}));
    });
  }

  // ── Directional arrows on each leg (on the straight leg portion only) ──
  if (state.layers.legArrows) {
    addL(legChevron(entry,  tBaseTurnStart,  p.dwTrackHdg, '#f4944d'));
    addL(legChevron(tBase,  tFinalTurnStart, p.bTrackHdg,  '#4df4c8'));
    addL(legChevron(tFinal, landing,         p.fTrackHdg,  '#e8f44d'));
    p.extraLegs?.forEach(xl => addL(legChevron(xl.entry, xl.exitTurnStart, xl.trackHdg, xl.color)));
  }

  // ── Wind arrow at landing target ──
  const wSfc = getWindAtAGL(0), ws = vecLen(wSfc);
  if (ws > 0.5) {
    const velDeg    = (Math.atan2(wSfc.e, wSfc.n) * R2D + 360) % 360;
    const fromDeg   = (velDeg + 180) % 360;
    const upwindVec = normalize({n: -wSfc.n, e: -wSfc.e});
    const arrowPt   = offsetLL(state.target.lat, state.target.lng,
      upwindVec.n * 350 + hdgVec(fromDeg + 90).n * 200,
      upwindVec.e * 350 + hdgVec(fromDeg + 90).e * 200);
    const gustKts   = state.surfaceWind?.gustKts;
    const gustTxt   = gustKts != null ? ` G${gustKts}` : '';
    addL(L.marker(ll(arrowPt), {
      icon: L.divIcon({
        html: `<div style="display:flex;align-items:center;gap:4px;pointer-events:none;">
          <svg width="12" height="12" viewBox="0 0 14 14">
            <polygon points="7,1 12,13 7,10 2,13" fill="rgba(255,255,255,0.9)"
              transform="rotate(${velDeg},7,7)"/>
          </svg>
          <span style="font-family:'Space Mono',monospace;font-size:12px;color:#fff;
            text-shadow:0 0 5px #000,0 1px 4px #000;white-space:nowrap;">${Math.round(fromDeg)}°@${Math.round(ws)}kt${gustTxt}</span>
        </div>`,
        iconSize: [110, 14], iconAnchor: [55, 7], className: '',
      }),
      interactive: false, zIndexOffset: 200,
    }));
  }

  // fitBounds only on first draw per target — keeps map stable during slider rotation
  if (!state.fitDone) {
    const fitPts = [ll(entry), ll(tBase), ll(tFinal), ll(landing), ll(tBaseTurnStart), ll(tFinalTurnStart)];
    p.extraLegs?.forEach(xl => fitPts.push(ll(xl.entry)));
    map.fitBounds(L.latLngBounds(fitPts), {padding: [80, 80]});
    state.fitDone = true;
  }
}
