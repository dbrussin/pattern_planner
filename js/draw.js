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

function legLabel(disp, wc, color, legSec) {
  const dist = dft(disp);
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
  const secLine = legSec != null ? `<div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:400;color:${color};opacity:0.75;text-shadow:${shadow};">${legSec}s</div>` : '';

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

// ── Main draw function ────────────────────────────────────────────────────────

function drawPattern() {
  clearPattern();
  const p = state.pattern; if (!p) return;
  const {entry, tBase, tFinal, landing, bSteered, fSteered, dwSteered, bDrift, fDrift, dwDrift} = p;
  const DRIFT_THRESH = state.driftThresh ?? 5;

  // Ground track lines (solid)
  addL(L.polyline([ll(entry),  ll(tBase)],   {color: '#f4944d', weight: 3, opacity: 0.9}));
  addL(L.polyline([ll(tBase),  ll(tFinal)],  {color: '#4df4c8', weight: 3, opacity: 0.9}));
  addL(L.polyline([ll(tFinal), ll(landing)], {color: '#e8f44d', weight: 3, opacity: 0.95}));

  // Steered heading lines (dashed, colored to match leg) when drift is significant
  if (dwDrift > DRIFT_THRESH) addL(L.polyline([ll(entry),  ll(dwSteered)], {color: 'rgba(244,148,77,0.6)',  weight: 2, dashArray: '6 4'}));
  if (bDrift  > DRIFT_THRESH) addL(L.polyline([ll(tBase),  ll(bSteered)],  {color: 'rgba(77,244,200,0.6)',  weight: 2, dashArray: '6 4'}));
  if (fDrift  > DRIFT_THRESH) addL(L.polyline([ll(tFinal), ll(fSteered)],  {color: 'rgba(232,244,77,0.6)',  weight: 2, dashArray: '6 4'}));

  // Turn point markers
  addL(L.marker(ll(entry),  {icon: pinIcon('#f4944d'), zIndexOffset: 100}));
  addL(L.marker(ll(tBase),  {icon: pinIcon('#4df4c8'), zIndexOffset: 100}));
  addL(L.marker(ll(tFinal), {icon: pinIcon('#e8f44d'), zIndexOffset: 100}));

  // Extra legs above downwind
  if (p.extraLegs?.length) {
    p.extraLegs.forEach(xl => {
      addL(L.polyline([ll(xl.entry), ll(xl.exit)], {color: xl.color, weight: 3, opacity: 0.9}));
      if (xl.drift > DRIFT_THRESH)
        addL(L.polyline([ll(xl.entry), ll(xl.steered)], {color: xl.color, weight: 2, opacity: 0.5, dashArray: '6 4'}));
      addL(L.marker(ll(xl.entry), {icon: pinIcon(xl.color), zIndexOffset: 100}));
    });
  }

  // ── Zones, jump run, labels ──
  {
    const dRate  = (p.cSpd / p.glide) * 101.269;
    const margin = 1 - p.safetyPct;

    // Draw one circle zone; returns center point
    function drawZone(centerAGL, radiusFt, driftAGL, borderColor, fillColor, fillOpacity, borderOpacity, borderWidth) {
      const drift = integratedDrift(driftAGL.top, driftAGL.bot, driftAGL.rate);
      const r     = radiusFt * margin * 0.3048; // metres, with safety margin
      const ctr   = offsetLL(entry.lat, entry.lng, -drift.dN, -drift.dE);
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
    const canopyRange  = p.altOpen - p.altE;
    const openDrift    = integratedDrift(p.altOpen, p.altE, dRate);
    const openRadiusFt = canopyRange * p.glide;
    const openCtr      = offsetLL(entry.lat, entry.lng, -openDrift.dN, -openDrift.dE);
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
        const topAGL = p.altE + h;
        const botAGL = p.altE;
        const rc     = ringColors[i];
        const ctr    = drawZone(
          p.altE, h * p.glide,
          {top: topAGL, bot: botAGL, rate: dRate},
          rc.border, rc.fill, rc.fillOp, 1, rc.bw
        );
        const avg      = avgWindInBand(botAGL, topAGL);
        const altLabel = Math.round(p.altE + h).toLocaleString();
        zoneLabel(ctr, h * p.glide,
          `${altLabel}ft · ${avg.spd}kt`,
          rc.border.replace(/[\d.]+\)$/, '1)'),
          avg.dir);
      });

      // ── Opening altitude ring ──
      const openAvg = avgWindInBand(p.altE, p.altOpen);
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

      // Natural offset = perpendicular distance from landing target to the line through exit center
      const landToExitN  = (exitCenter.lat - p.landing.lat) * R_FT * D2R;
      const landToExitE  = (exitCenter.lng - p.landing.lng) * R_FT * Math.cos(p.landing.lat * D2R) * D2R;
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
      const landToBaseN = (p.landing.lat - jrBase.lat) * R_FT * D2R;
      const landToBaseE = (p.landing.lng - jrBase.lng) * R_FT * Math.cos(jrBase.lat * D2R) * D2R;
      const tRef     = landToBaseN * jrVec.n + landToBaseE * jrVec.e;

      let greenTxt = '', redTxt = '';
      if (disc2 >= 0) {
        const t1      = proj2 - Math.sqrt(disc2);
        const t2      = proj2 + Math.sqrt(disc2);
        const fmtDist = t => {
          const dt   = t - tRef;
          const nm   = Math.abs(dt) / 6076;
          const word = dt >= 0 ? 'past' : 'prior';
          return `${nm.toFixed(1)}nm ${word}`;
        };
        greenTxt = ` · 🟢 ${fmtDist(t1)}`;
        redTxt   = ` · 🔴 ${fmtDist(t2)}`;
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
    addL(L.marker(ll(entry),  {icon: turnLabelIcon(`${p.altE}ft AGL`, '#f4944d'), interactive: false, zIndexOffset: 60}));
    addL(L.marker(ll(tBase),  {icon: turnLabelIcon(`${p.altB}ft AGL`, '#4df4c8'), interactive: false, zIndexOffset: 60}));
    addL(L.marker(ll(tFinal), {icon: turnLabelIcon(`${p.altF}ft AGL`, '#e8f44d'), interactive: false, zIndexOffset: 60}));
    p.extraLegs?.forEach(xl =>
      addL(L.marker(ll(xl.entry), {icon: turnLabelIcon(`${xl.altTop}ft AGL`, xl.color), interactive: false, zIndexOffset: 60})));
  }

  // ── Leg distance / wind / timing labels ──
  if (state.layers.legDistances) {
    const dwMid = offsetMid(entry,  tBase,   p.dDisp, side * perpFt);
    const bMid  = offsetMid(tBase,  tFinal,  p.bDisp, side * perpFt);
    const fMid  = offsetMid(tFinal, landing, p.fDisp, side * perpFt);
    addL(L.marker(ll(dwMid), {icon: legLabel(p.dDisp, p.dWC, '#f4944d', p.tD_sec), interactive: false, zIndexOffset: 50}));
    addL(L.marker(ll(bMid),  {icon: legLabel(p.bDisp, p.bWC, '#4df4c8', p.tB_sec), interactive: false, zIndexOffset: 50}));
    addL(L.marker(ll(fMid),  {icon: legLabel(p.fDisp, p.fWC, '#e8f44d', p.tF_sec), interactive: false, zIndexOffset: 50}));
    p.extraLegs?.forEach(xl => {
      const xlMid = offsetMid(xl.entry, xl.exit, xl.disp, side * perpFt);
      addL(L.marker(ll(xlMid), {icon: legLabel(xl.disp, xl.wc, xl.color, xl.tSec), interactive: false, zIndexOffset: 50}));
    });
  }

  // ── Heading labels (track + steered) ──
  if (state.layers.legHeadings) {
    // Track + steer heading labels on opposite perpendicular side from distance labels
    const dwMidH = offsetMid(entry,  tBase,   p.dDisp, -side * perpFt);
    const bMidH  = offsetMid(tBase,  tFinal,  p.bDisp, -side * perpFt);
    const fMidH  = offsetMid(tFinal, landing, p.fDisp, -side * perpFt);
    addL(L.marker(ll(dwMidH), {icon: hdgLabelIcon(p.dwTrackHdg, p.dwHdg, dwDrift > DRIFT_THRESH, '#f4944d'), interactive: false, zIndexOffset: 50}));
    addL(L.marker(ll(bMidH),  {icon: hdgLabelIcon(p.bTrackHdg,  p.bHdg,  bDrift  > DRIFT_THRESH, '#4df4c8'), interactive: false, zIndexOffset: 50}));
    addL(L.marker(ll(fMidH),  {icon: hdgLabelIcon(p.fTrackHdg,  p.fHdgActual, fDrift > DRIFT_THRESH, '#e8f44d'), interactive: false, zIndexOffset: 50}));
    p.extraLegs?.forEach(xl => {
      const xlMidH = offsetMid(xl.entry, xl.exit, xl.disp, -side * perpFt);
      addL(L.marker(ll(xlMidH), {icon: hdgLabelIcon(xl.trackHdg, xl.hdg, xl.drift > DRIFT_THRESH, xl.color), interactive: false, zIndexOffset: 50}));
    });
  }

  // ── Directional arrows on each leg ──
  if (state.layers.legArrows) {
    addL(legChevron(entry,  tBase,   p.dwTrackHdg, '#f4944d'));
    addL(legChevron(tBase,  tFinal,  p.bTrackHdg,  '#4df4c8'));
    addL(legChevron(tFinal, landing, p.fTrackHdg,  '#e8f44d'));
    p.extraLegs?.forEach(xl => addL(legChevron(xl.entry, xl.exit, xl.trackHdg, xl.color)));
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
    addL(L.marker(ll(arrowPt), {
      icon: L.divIcon({
        html: `<div style="display:flex;align-items:center;gap:4px;pointer-events:none;">
          <svg width="12" height="12" viewBox="0 0 14 14">
            <polygon points="7,1 12,13 7,10 2,13" fill="rgba(255,255,255,0.9)"
              transform="rotate(${velDeg},7,7)"/>
          </svg>
          <span style="font-family:'Space Mono',monospace;font-size:12px;color:#fff;
            text-shadow:0 0 5px #000,0 1px 4px #000;white-space:nowrap;">${Math.round(fromDeg)}°@${Math.round(ws)}kt</span>
        </div>`,
        iconSize: [90, 14], iconAnchor: [45, 7], className: '',
      }),
      interactive: false, zIndexOffset: 200,
    }));
  }

  // fitBounds only on first draw per target — keeps map stable during slider rotation
  if (!state.fitDone) {
    const fitPts = [ll(entry), ll(tBase), ll(tFinal), ll(landing)];
    p.extraLegs?.forEach(xl => fitPts.push(ll(xl.entry)));
    map.fitBounds(L.latLngBounds(fitPts), {padding: [80, 80]});
    state.fitDone = true;
  }
}
