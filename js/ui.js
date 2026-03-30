// ─── UI ────────────────────────────────────────────────────────────────────────
// User interaction handlers: overlays, heading bar, leg modes, canopy performance,
// jump run controls, layer toggles, hand toggle, legend, and status display.
// Depends on: config, state, storage, geometry, calculate

// ── Status pill ───────────────────────────────────────────────────────────────

function setStatus(msg, persist = false) {
  const el = document.getElementById('status-pill');
  el.textContent = msg; el.classList.add('visible');
  if (setStatus._t) clearTimeout(setStatus._t);
  if (!persist) setStatus._t = setTimeout(() => el.classList.remove('visible'), 3500);
}

// ── Overlay panels ────────────────────────────────────────────────────────────

function toggleOverlay(name) {
  const panel  = document.getElementById(`overlay-${name}`);
  const btn    = document.getElementById(`btn-${name}`);
  const isOpen = panel.classList.contains('open');
  document.querySelectorAll('.overlay-panel').forEach(p => p.classList.remove('open'));
  document.querySelectorAll('.map-icon-btn').forEach(b => b.classList.remove('active'));
  if (!isOpen) {
    panel.classList.add('open');
    if (btn) btn.classList.add('active');
    setTimeout(() => { updateWindPyramid(); updateJrPyramid(); }, 50);
  }
}

function closeOverlay(name) {
  document.getElementById(`overlay-${name}`).classList.remove('open');
  const btn = document.getElementById(`btn-${name}`);
  if (btn) btn.classList.remove('active');
}

// ── Legend reveal ─────────────────────────────────────────────────────────────

function showLegend() {
  if (state.layers.legend) document.getElementById('map-legend').classList.add('visible');
}

// ── Final approach heading ────────────────────────────────────────────────────

function onHeadingSlider(v) {
  state.manualHeading    = true;
  state.finalHeadingDeg  = parseInt(v);
  updateHeadingDisplay(parseInt(v));
  calculate();
}

function onForecastOffsetChange(v) {
  state.forecastOffset = parseInt(v) || 0;
  const lbl = document.getElementById('forecast-offset-label');
  if (lbl) lbl.textContent = state.forecastOffset === 0 ? 'Now' : `+${state.forecastOffset}h`;
  // Sync the winds overlay slider
  const slider = document.getElementById('forecast-offset');
  if (slider) slider.value = state.forecastOffset;
  if (!state.target) return;
  const cached = findCachedWinds(state.target.lat, state.target.lng);
  if (cached) {
    processWindData(cached.rawData, cached.fieldElevFt);
    calculate();
  } else {
    fetchWinds(true).then(calculate);
  }
}

function adjustForecastOffset(delta) {
  const newVal = Math.max(0, Math.min(12, (state.forecastOffset || 0) + delta));
  if (newVal === state.forecastOffset) return;
  onForecastOffsetChange(newVal);
}

function jumpForecastToNow() {
  if (state.forecastOffset === 0) return;
  onForecastOffsetChange(0);
}

function snapToWind() {
  const dir = state.surfaceWind?.dirDeg ?? null;
  if (dir !== null) {
    state.manualHeading   = false;
    state.finalHeadingDeg = dir;
    updateHeadingDisplay(dir);
    calculate();
  }
}

function resetHeading() { snapToWind(); }

function updateHeadingDisplay(deg) {
  const d = Math.round(((deg % 360) + 360) % 360);
  document.getElementById('heading-bar-val').value    = d;
  document.getElementById('heading-bar-slider').value = d;
  updateWindPyramid(); updateJrPyramid();
}

let _headingInputTimer = null;

function onHeadingInput(v) {
  if (v === '' || v === null) return;
  const d = ((parseInt(v) % 360) + 360) % 360;
  if (isNaN(d)) return;
  state.manualHeading   = true;
  state.finalHeadingDeg = d;
  document.getElementById('heading-bar-slider').value = d;
  updateWindPyramid();
  clearTimeout(_headingInputTimer);
  _headingInputTimer = setTimeout(calculate, 150);
}

function onHeadingBlur() {
  if (state.finalHeadingDeg !== null)
    document.getElementById('heading-bar-val').value = Math.round(state.finalHeadingDeg);
}

function updateWindPyramid() {
  const windHdg = state.surfaceWind?.dirDeg ?? null;
  const pyr     = document.getElementById('wind-pyramid');
  const pyrHit  = document.getElementById('wind-pyramid-hit');
  if (windHdg === null) { pyr.style.display = 'none'; pyrHit.style.display = 'none'; return; }

  const slider = document.getElementById('heading-bar-slider');
  const trackW = slider.clientWidth;
  const thumbR = 14;
  const pxPos  = thumbR + (windHdg / 359) * (trackW - 2 * thumbR);
  const pct    = (pxPos / trackW) * 100;

  pyr.style.left       = pct + '%';
  pyrHit.style.left    = pct + '%';
  pyr.style.display    = 'block';
  pyrHit.style.display = 'block';
}

// ── Leg modes (crab / drift / Z) ─────────────────────────────────────────────

function setLegMode(leg, mode) {
  state.legModes[leg] = mode;
  ['crab', 'drift', 'z'].forEach(m => {
    const btn = document.getElementById(`${leg}-${m}`);
    if (btn) btn.classList.toggle('active', m === mode);
  });
  saveSettings();
  if (state.pattern) calculate();
}

function toggleZPattern(checked) {
  if (checked && state.legHdgOverride?.dw != null) {
    state.legHdgOverride.dw = null;
    const cb = document.getElementById('dw-hdg-check');
    if (cb) cb.checked = false;
    const row = document.getElementById('dw-hdg-row');
    if (row) row.style.display = 'none';
  }
  state.zPattern = checked;
  saveSettings();
  if (state.pattern) calculate();
}

function updatePerfSections() {
  const allLegKeys = [...LEG_DEFS.map(l => l.key), ...state.extraLegs.map(xl => xl.id)];
  allLegKeys.forEach(leg => {
    const cb      = document.getElementById(`${leg}-custom-perf`);
    const section = document.getElementById(`${leg}-perf`);
    if (!cb || !section) return;
    const wasOpen = section.style.display !== 'none';
    const isOpen  = cb.checked;
    state.legCustomPerf[leg]  = isOpen;
    section.style.display     = isOpen ? 'block' : 'none';
    // Only seed from global defaults when newly enabling — not on re-renders
    if (isOpen && !wasOpen) {
      const glideEl = document.getElementById(`${leg}-glide`);
      const speedEl = document.getElementById(`${leg}-speed`);
      const sinkEl  = document.getElementById(`${leg}-sink`);
      if (glideEl) { glideEl.value = document.getElementById('glide').value || '2.5'; glideEl.style.color = 'var(--text)'; }
      if (speedEl) { speedEl.value = document.getElementById('canopy-speed').value || '28'; speedEl.style.color = 'var(--text)'; }
      if (sinkEl)  { sinkEl.value = ''; sinkEl.style.color = 'var(--muted)'; }
      legLastEdited[leg] = ['glide', 'speed'];
      updateLegCanopyCalc(leg);
    }
  });
  saveSettings();
  if (state.pattern) calculate();
}

// Per-leg canopy three-way calc
const legLastEdited = Object.fromEntries(LEG_DEFS.map(l => [l.key, ['glide', 'speed']]));

function onLegCanopyInput(leg, field) {
  const le = legLastEdited[leg];
  if (!le.includes(field)) legLastEdited[leg] = [le[1], field];
  else legLastEdited[leg] = le.filter(f => f !== field).concat(field);
  updateLegCanopyCalc(leg);
  calculate();
}

function updateLegCanopyCalc(leg) {
  const g       = parseFloat(document.getElementById(`${leg}-glide`)?.value);
  const s       = parseFloat(document.getElementById(`${leg}-speed`)?.value);
  const k       = parseFloat(document.getElementById(`${leg}-sink`)?.value);
  const noteEl  = document.getElementById(`${leg}-perf-note`);
  const [a, b_] = legLastEdited[leg];
  const third   = ['glide', 'speed', 'sink'].find(f => f !== a && f !== b_);
  const sinkEl  = document.getElementById(`${leg}-sink`);
  const speedEl = document.getElementById(`${leg}-speed`);
  const glideEl = document.getElementById(`${leg}-glide`);

  if (third === 'sink' && !isNaN(g) && !isNaN(s)) {
    const calc = Math.round((s / g) * 10) / 10;
    sinkEl.value = calc; sinkEl.style.color = 'var(--muted)';
    if (noteEl) noteEl.textContent = `Calculated vertical: ${calc} kts`;
  } else if (third === 'speed' && !isNaN(g) && !isNaN(k)) {
    const calc = Math.round(k * g * 10) / 10;
    speedEl.value = calc; speedEl.style.color = 'var(--muted)';
    if (noteEl) noteEl.textContent = `Calculated horiz: ${calc} kts`;
  } else if (third === 'glide' && !isNaN(s) && !isNaN(k)) {
    const calc = Math.round((s / k) * 10) / 10;
    glideEl.value = calc; glideEl.style.color = 'var(--muted)';
    if (noteEl) noteEl.textContent = `Calculated glide: ${calc}:1`;
  } else if (noteEl) noteEl.textContent = '';

  [['glide', glideEl], ['speed', speedEl], ['sink', sinkEl]].forEach(([f, el]) => {
    if (el && legLastEdited[leg].includes(f)) el.style.color = 'var(--text)';
  });
}

// Returns {glide, cSpd} for a given leg, using per-leg override if enabled
function getLegPerf(leg) {
  const defaultGlide = parseFloat(document.getElementById('glide').value) || 2.5;
  const defaultSpd   = parseFloat(document.getElementById('canopy-speed').value) || 28;
  if (!state.legCustomPerf[leg]) return {glide: defaultGlide, cSpd: defaultSpd};
  const g = parseFloat(document.getElementById(`${leg}-glide`)?.value);
  const s = parseFloat(document.getElementById(`${leg}-speed`)?.value);
  return {
    glide: isNaN(g) ? defaultGlide : g,
    cSpd:  isNaN(s) ? defaultSpd   : s,
  };
}

// ── Global canopy performance (any two → third calculated) ───────────────────

let canopyLastEdited = ['glide', 'speed']; // default: glide + speed → sink calculated

function onCanopyInput(field) {
  if (!canopyLastEdited.includes(field)) {
    canopyLastEdited = [canopyLastEdited[1], field];
  } else {
    canopyLastEdited = canopyLastEdited.filter(f => f !== field).concat(field);
  }
  updateCanopyCalc();
  calculate();
}

function updateCanopyCalc() {
  const glideEl = document.getElementById('glide');
  const speedEl = document.getElementById('canopy-speed');
  const sinkEl  = document.getElementById('canopy-sink');
  const noteEl  = document.getElementById('canopy-calc-note');

  const g = parseFloat(glideEl.value);
  const s = parseFloat(speedEl.value);
  const k = parseFloat(sinkEl.value);

  // Relationship: vertical_kts = horizontal_kts / glide_ratio
  const [a, b] = canopyLastEdited;
  const third  = ['glide', 'speed', 'sink'].find(f => f !== a && f !== b);

  if (third === 'sink' && !isNaN(g) && !isNaN(s)) {
    const calc = Math.round((s / g) * 10) / 10;
    sinkEl.value       = calc;
    sinkEl.style.color = 'var(--muted)';
    if (noteEl) noteEl.textContent = `Calculated vertical speed: ${calc} kts`;
  } else if (third === 'speed' && !isNaN(g) && !isNaN(k)) {
    const calc = Math.round(k * g * 10) / 10;
    speedEl.value       = calc;
    speedEl.style.color = 'var(--muted)';
    if (noteEl) noteEl.textContent = `Calculated horiz speed: ${calc} kts`;
  } else if (third === 'glide' && !isNaN(s) && !isNaN(k)) {
    const calc = Math.round((s / k) * 10) / 10;
    glideEl.value       = calc;
    glideEl.style.color = 'var(--muted)';
    if (noteEl) noteEl.textContent = `Calculated glide: ${calc}:1`;
  } else {
    if (noteEl) noteEl.textContent = '';
  }
  [['glide', glideEl], ['speed', speedEl], ['sink', sinkEl]].forEach(([f, el]) => {
    if (canopyLastEdited.includes(f)) el.style.color = 'var(--text)';
  });
}

// ── Jump run heading ──────────────────────────────────────────────────────────

function onJumpRunSlider(v) {
  state.manualJumpRun = true;
  state.jumpRunHdgDeg = parseInt(v);
  updateJumpRunDisplay(parseInt(v));
  calculate();
}

function onJrOffsetInput() {
  const el = document.getElementById('jr-offset');
  if (el.value === '' || el.value === null) {
    state.manualJrOffset = false;
    el.style.color = 'var(--muted)';
  } else {
    state.manualJrOffset = true;
    el.style.color = 'var(--text)';
  }
  calculate();
}

function resetJrOffset() {
  state.manualJrOffset = false;
  const el = document.getElementById('jr-offset');
  el.value       = '';
  el.style.color = 'var(--muted)';
  calculate();
}

function snapJumpRunToWind() {
  state.manualJumpRun = false;
  state.jumpRunHdgDeg = null;
  calculate();
}

function updateJumpRunDisplay(deg) {
  document.getElementById('jr-hdg-display').value = Math.round(deg);
  document.getElementById('jr-hdg-slider').value  = Math.round(deg);
  updateJrPyramid();
}

let _jrHdgInputTimer = null;

function onJrHdgInput(v) {
  if (v === '' || v === null) return;
  const d = ((parseInt(v) % 360) + 360) % 360;
  if (isNaN(d)) return;
  state.manualJumpRun = true;
  state.jumpRunHdgDeg = d;
  document.getElementById('jr-hdg-slider').value = d;
  updateJrPyramid();
  clearTimeout(_jrHdgInputTimer);
  _jrHdgInputTimer = setTimeout(calculate, 150);
}

function onJrHdgBlur() {
  if (state.jumpRunHdgDeg !== null)
    document.getElementById('jr-hdg-display').value = Math.round(state.jumpRunHdgDeg);
}

function updateJrPyramid() {
  const wExit  = getWindAtAGL(parseFloat(document.getElementById('alt-exit').value) || 13500);
  const pyr    = document.getElementById('jr-wind-pyramid');
  const pyrHit = document.getElementById('jr-wind-pyramid-hit');
  if (!pyr || vecLen(wExit) < 0.1) {
    if (pyr)    pyr.style.display    = 'none';
    if (pyrHit) pyrHit.style.display = 'none';
    return;
  }
  const windVelDir  = (Math.atan2(wExit.e, wExit.n) * R2D + 360) % 360;
  const intoWindHdg = (windVelDir + 180) % 360;
  const slider  = document.getElementById('jr-hdg-slider');
  const trackW  = slider.clientWidth;
  const thumbR  = 14;
  const pct     = ((thumbR + (intoWindHdg / 359) * (trackW - 2 * thumbR)) / trackW) * 100;
  pyr.style.left       = pct + '%';
  pyrHit.style.left    = pct + '%';
  pyr.style.display    = 'block';
  pyrHit.style.display = 'block';
}

function autoSetJumpRunHeading() {
  if (!state.manualJumpRun) {
    const altExit = parseFloat(document.getElementById('alt-exit').value) || 13500;
    const wExit   = getWindAtAGL(altExit);
    if (vecLen(wExit) > 0.1) {
      const windVelDir = (Math.atan2(wExit.e, wExit.n) * R2D + 360) % 360;
      const dir        = Math.round((windVelDir + 180) % 360);
      state.jumpRunHdgDeg = dir;
      updateJumpRunDisplay(dir);
    }
  }
}

function onDriftThreshChange(v) {
  state.driftThresh = parseInt(v) || 0;
  if (state.pattern) drawPattern();
}

// ── Layer toggles ─────────────────────────────────────────────────────────────

function toggleLayer(name) {
  state.layers[name] = !state.layers[name];
  const el = document.getElementById(`layer-${name}`);
  if (el) {
    el.classList.toggle('active', state.layers[name]);
    el.textContent = state.layers[name] ? 'On' : 'Off';
  }
  if (name === 'legend') {
    const leg = document.getElementById('map-legend');
    if (leg) leg.classList.toggle('visible', state.layers[name] && !!state.target);
    saveSettings();
    return;
  }
  saveSettings();
  if (state.pattern) drawPattern();
}

// ── Hand (L/R) toggle ─────────────────────────────────────────────────────────

function setHand(h) {
  state.hand = h;
  document.getElementById('btn-left').classList.toggle('active',  h === 'left');
  document.getElementById('btn-right').classList.toggle('active', h === 'right');
  saveSettings();
  if (state.pattern) calculate();
}

// ── Leg cards (data-driven from LEG_DEFS in config.js) ────────────────────────

function renderLegs() {
  const container = document.getElementById('legs-container');
  if (!container) return;

  // Snapshot current input values and checkbox/details states before wiping DOM
  const snap = {};
  container.querySelectorAll('input[id]').forEach(el => {
    snap[el.id] = { value: el.value, checked: el.checked, color: el.style.color || '' };
  });
  container.querySelectorAll('details[id]').forEach(el => {
    snap[el.id] = { open: el.open };
  });

  container.innerHTML = '';

  // ── Extra legs (highest altitude first = flight order) ──
  const lifoId       = state.extraLegs[state.extraLegs.length - 1]?.id;
  const hasExtras    = state.extraLegs.length > 0;
  const extrasSorted = [...state.extraLegs].sort((a, b) => b.defaultAlt - a.defaultAlt);
  extrasSorted.forEach(xl => {
    const mode        = state.legModes[xl.id] || 'crab';
    const crabActive  = mode === 'crab'  ? ' active' : '';
    const driftActive = mode === 'drift' ? ' active' : '';
    const removeBtn   = xl.id === lifoId
      ? `<button class="leg-remove-btn" onclick="removeExtraLeg('${xl.id}')" title="Remove leg">×</button>`
      : '';
    const cpChecked   = state.legCustomPerf[xl.id]  ? 'checked' : '';
    const perfDisp    = state.legCustomPerf[xl.id]  ? 'block'   : 'none';
    const detOpen     = state.legCustomPerf[xl.id]  ? 'open'    : '';
    const legNum      = parseInt(xl.id.replace('xl', '')) + 3;
    const nomHdg      = xl.nomHdg ?? 0;

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--panel2);border-radius:6px;padding:8px 10px;border:1px solid var(--border);';
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${xl.color};flex-shrink:0;"></div>
        <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text);flex:1;">Leg ${legNum}</span>
        <div style="display:flex;border:1px solid var(--border);border-radius:3px;overflow:hidden;">
          <button id="${xl.id}-crab"  class="leg-mode-btn${crabActive}"  onclick="setLegMode('${xl.id}','crab')">Crab</button>
          <button id="${xl.id}-drift" class="leg-mode-btn${driftActive}" onclick="setLegMode('${xl.id}','drift')">Drift</button>
        </div>
        ${removeBtn}
      </div>
      <div style="margin-bottom:6px;">
        <label style="font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:4px;">Alt (ft AGL)</label>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="range" id="alt-${xl.id}-sl" min="200" max="5000" step="50" value="${xl.defaultAlt}" style="flex:1;min-width:0;accent-color:var(--accent);" oninput="onLegAlt('alt-${xl.id}','slider')">
          <input type="number" id="alt-${xl.id}" value="${xl.defaultAlt}" min="200" max="5000" step="50" style="font-family:'Space Mono',monospace;font-size:14px;color:var(--text);background:transparent;border:none;border-bottom:1px solid var(--border);width:56px;text-align:center;padding:2px 0;flex-shrink:0;" oninput="onLegAlt('alt-${xl.id}','input')">
        </div>
      </div>
      <div style="margin-bottom:6px;">
        <label style="font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);white-space:nowrap;flex-shrink:0;margin-bottom:4px;display:block;">Approach hdg</label>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="range" id="hdg-sl-${xl.id}" min="0" max="359" step="1" value="${nomHdg}" style="flex:1;min-width:0;accent-color:var(--accent2);" oninput="onExtraLegHdg('${xl.id}','slider')">
          <input type="number" id="hdg-${xl.id}" value="${nomHdg}" min="0" max="359" step="1" style="font-family:'Space Mono',monospace;font-size:14px;color:var(--accent2);background:transparent;border:none;border-bottom:1px solid var(--border);width:46px;text-align:center;padding:2px 0;flex-shrink:0;" oninput="onExtraLegHdg('${xl.id}','input')">
        </div>
      </div>
      <details id="leg-details-${xl.id}" class="leg-details" ${detOpen}>
        <summary class="leg-details-summary"><span class="leg-details-arrow">▸</span>More options</summary>
        <div class="leg-details-body">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <label style="font-size:12px;color:var(--muted);flex:1;">Custom performance</label>
            <input type="checkbox" id="${xl.id}-custom-perf" ${cpChecked} onchange="updatePerfSections()">
          </div>
          <div id="${xl.id}-perf" style="display:${perfDisp};margin-top:4px;">
            <div class="input-grid">
              <div class="input-group"><label for="${xl.id}-glide">Glide (:1)</label><input type="number" id="${xl.id}-glide" value="2.5" min="1" max="10" step="0.1" oninput="onLegCanopyInput('${xl.id}','glide')"></div>
              <div class="input-group"><label for="${xl.id}-speed">Horiz (kts)</label><input type="number" id="${xl.id}-speed" value="28" min="10" max="60" step="0.5" oninput="onLegCanopyInput('${xl.id}','speed')"></div>
              <div class="input-group"><label for="${xl.id}-sink">Vert (kts)</label><input type="number" id="${xl.id}-sink" value="" min="1" max="30" step="0.1" placeholder="calc" oninput="onLegCanopyInput('${xl.id}','sink')"></div>
            </div>
            <div id="${xl.id}-perf-note" class="field-note" style="margin-top:4px;min-height:1em;"></div>
          </div>
        </div>
      </details>
    `;
    container.appendChild(card);
  });

  // ── Standard legs (Downwind, Base, Final) ──
  // Z-pattern option only shown on downwind, and only when no extra legs exist
  LEG_DEFS.forEach(def => {
    const { key, label, color, altId, altLabel, altDefault, altMin, altMax, altStep } = def;
    const mode        = state.legModes[key];
    const crabActive  = mode === 'crab'  ? ' active' : '';
    const driftActive = mode === 'drift' ? ' active' : '';

    const showZ     = !hasExtras && key === 'dw';
    const zChecked  = showZ && state.zPattern ? 'checked' : '';
    const cpChecked = state.legCustomPerf[key]  ? 'checked' : '';
    const perfDisp  = state.legCustomPerf[key]  ? 'block'   : 'none';

    const hdgOverride        = state.legHdgOverride?.[key] ?? null;
    const hdgOverrideChecked = hdgOverride != null ? 'checked' : '';
    const hdgOverrideDisp    = hdgOverride != null ? 'flex'    : 'none';
    const hdgVal             = hdgOverride ?? 0;
    const zDisabled          = showZ && hdgOverride != null;
    const detOpen            = (state.legCustomPerf[key] || (showZ && state.zPattern) || hdgOverride != null) ? 'open' : '';

    const zRow = showZ ? `
      <div id="dw-z-row" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;${zDisabled ? 'opacity:0.4;pointer-events:none;' : ''}">
        <label style="font-size:12px;color:var(--muted);flex:1;">Z pattern (downwind same direction as final)</label>
        <input type="checkbox" id="dw-z-check" ${zChecked} ${zDisabled ? 'disabled' : ''} onchange="toggleZPattern(this.checked)">
      </div>` : '';

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--panel2);border-radius:6px;padding:8px 10px;border:1px solid var(--border);';
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0;"></div>
        <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text);flex:1;">${label}</span>
        <div style="display:flex;border:1px solid var(--border);border-radius:3px;overflow:hidden;">
          <button id="${key}-crab"  class="leg-mode-btn${crabActive}"  onclick="setLegMode('${key}','crab')">Crab</button>
          <button id="${key}-drift" class="leg-mode-btn${driftActive}" onclick="setLegMode('${key}','drift')">Drift</button>
        </div>
      </div>
      <div style="margin-bottom:6px;">
        <label style="font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:4px;">${altLabel}</label>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="range" id="${altId}-sl" min="${altMin}" max="${altMax}" step="${altStep}" value="${altDefault}" style="flex:1;min-width:0;accent-color:var(--accent);" oninput="onLegAlt('${altId}','slider')">
          <input type="number" id="${altId}" value="${altDefault}" min="${altMin}" max="${altMax}" step="${altStep}" style="font-family:'Space Mono',monospace;font-size:14px;color:var(--text);background:transparent;border:none;border-bottom:1px solid var(--border);width:56px;text-align:center;padding:2px 0;flex-shrink:0;" oninput="onLegAlt('${altId}','input')">
        </div>
      </div>
      <details id="leg-details-${key}" class="leg-details" ${detOpen}>
        <summary class="leg-details-summary"><span class="leg-details-arrow">▸</span>More options</summary>
        <div class="leg-details-body">
          <div id="${key}-hdg-override-wrap" style="margin-bottom:4px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
              <label style="font-size:12px;color:var(--muted);flex:1;">Override approach hdg</label>
              <input type="checkbox" id="${key}-hdg-check" ${hdgOverrideChecked} onchange="onLegHdgOverrideToggle('${key}',this.checked)">
            </div>
            <div id="${key}-hdg-row" style="display:${hdgOverrideDisp};align-items:center;gap:6px;margin-bottom:4px;">
              <input type="range" id="${key}-hdg-sl" min="0" max="359" step="1" value="${hdgVal}" style="flex:1;min-width:0;accent-color:var(--accent2);" oninput="onStdLegHdg('${key}','slider')">
              <input type="number" id="${key}-hdg" value="${hdgVal}" min="0" max="359" step="1" style="font-family:'Space Mono',monospace;font-size:14px;color:var(--accent2);background:transparent;border:none;border-bottom:1px solid var(--border);width:46px;text-align:center;padding:2px 0;flex-shrink:0;" oninput="onStdLegHdg('${key}','input')">
            </div>
          </div>
          ${zRow}
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <label style="font-size:12px;color:var(--muted);flex:1;">Custom performance</label>
            <input type="checkbox" id="${key}-custom-perf" ${cpChecked} onchange="updatePerfSections()">
          </div>
          <div id="${key}-perf" style="display:${perfDisp};margin-top:4px;">
            <div class="input-grid">
              <div class="input-group"><label for="${key}-glide">Glide (:1)</label><input type="number" id="${key}-glide" value="2.5" min="1" max="10" step="0.1" oninput="onLegCanopyInput('${key}','glide')"></div>
              <div class="input-group"><label for="${key}-speed">Horiz (kts)</label><input type="number" id="${key}-speed" value="28" min="10" max="60" step="0.5" oninput="onLegCanopyInput('${key}','speed')"></div>
              <div class="input-group"><label for="${key}-sink">Vert (kts)</label><input type="number" id="${key}-sink" value="" min="1" max="30" step="0.1" placeholder="calc" oninput="onLegCanopyInput('${key}','sink')"></div>
            </div>
            <div id="${key}-perf-note" class="field-note" style="margin-top:4px;min-height:1em;"></div>
          </div>
        </div>
      </details>
    `;
    container.appendChild(card);
  });

  // Restore snapshotted values/states into newly created elements
  Object.entries(snap).forEach(([id, s]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'DETAILS')       el.open    = s.open;
    else if (el.type === 'checkbox')    el.checked = s.checked;
    else if (s.value !== undefined && s.value !== '') {
      el.value       = s.value;
      if (s.color) el.style.color = s.color;
    }
  });
}

// ── Leg altitude slider sync ──────────────────────────────────────────────────

function onLegAlt(numId, src) {
  const sl  = document.getElementById(numId + '-sl');
  const num = document.getElementById(numId);
  if (!sl || !num) return;
  if (src === 'slider') { num.value = sl.value; num.style.color = 'var(--text)'; }
  else                  { sl.value  = num.value; }
  saveSettings();
  if (state.target) calculate();
}

// ── Extra leg heading sync ────────────────────────────────────────────────────

function onExtraLegHdg(id, src) {
  const sl  = document.getElementById(`hdg-sl-${id}`);
  const inp = document.getElementById(`hdg-${id}`);
  if (!sl || !inp) return;
  if (src === 'slider') { inp.value = sl.value; }
  else                  { sl.value  = ((parseInt(inp.value) || 0) + 360) % 360; }
  const xl = state.extraLegs.find(x => x.id === id);
  if (xl) xl.nomHdg = parseInt(inp.value) || 0;
  saveSettings();
  if (state.pattern) calculate();
}

// ── Add / remove extra legs ────────────────────────────────────────────────────

function addExtraLeg() {
  // Default altitude: highest existing alt + 300, capped at 5000
  const existingAlts = state.extraLegs.map(xl => {
    const el = document.getElementById(`alt-${xl.id}`);
    return el ? (parseFloat(el.value) || xl.defaultAlt) : xl.defaultAlt;
  });
  const baseAlt  = existingAlts.length
    ? Math.max(...existingAlts)
    : (parseFloat(document.getElementById('alt-enter')?.value) || 900);
  const newAlt   = Math.min(baseAlt + 300, 5000);

  const idx   = state.nextExtraLegIdx++;
  const id    = `xl${idx}`;
  const color = EXTRA_LEG_COLORS[(idx - 1) % EXTRA_LEG_COLORS.length];

  // Default approach heading: 90° rotation from previous leg in circuit direction
  const sign = state.hand === 'left' ? 1 : -1;
  let prevNomHdg;
  if (state.extraLegs.length > 0) {
    const lastXl = state.extraLegs[state.extraLegs.length - 1];
    const hdgInp = document.getElementById(`hdg-${lastXl.id}`);
    prevNomHdg = hdgInp ? (parseInt(hdgInp.value) || lastXl.nomHdg || 0) : (lastXl.nomHdg || 0);
  } else {
    prevNomHdg = state.pattern?.dwTrackHdg ?? ((state.pattern?.fHdg ?? 0) + 180) % 360;
  }
  const nomHdg = Math.round((prevNomHdg + sign * 90 + 3600) % 360);

  state.extraLegs.push({ id, defaultAlt: newAlt, color, nomHdg });
  state.legModes[id]      = 'crab';
  state.legCustomPerf[id] = false;
  if (!legLastEdited[id]) legLastEdited[id] = ['glide', 'speed'];

  renderLegs();

  // Set altitude + heading for the newly created inputs (snap won't have them yet)
  const newEl = document.getElementById(`alt-${id}`);
  if (newEl) newEl.value = newAlt;
  const newSlEl = document.getElementById(`alt-${id}-sl`);
  if (newSlEl) newSlEl.value = newAlt;
  const hdgEl = document.getElementById(`hdg-${id}`);
  if (hdgEl) hdgEl.value = nomHdg;
  const hdgSlEl = document.getElementById(`hdg-sl-${id}`);
  if (hdgSlEl) hdgSlEl.value = nomHdg;

  // Attach save listeners to any new inputs not yet covered
  document.querySelectorAll('#legs-container input').forEach(el => {
    if (!el._ppSave) {
      el.addEventListener('change', saveSettings);
      el.addEventListener('input',  saveSettings);
      el._ppSave = true;
    }
  });

  saveSettings();
  if (state.target) calculate();
}

function removeExtraLeg(id) {
  const idx = state.extraLegs.findIndex(xl => xl.id === id);
  if (idx === -1) return;
  state.extraLegs.splice(idx, 1);
  delete state.legModes[id];
  delete state.legCustomPerf[id];
  delete legLastEdited[id];
  state.nextExtraLegIdx = parseInt(id.replace('xl', ''));
  renderLegs();
  saveSettings();
  if (state.target) calculate();
}

// ── Standard leg heading override ─────────────────────────────────────────────

function onStdLegHdg(key, src) {
  const sl  = document.getElementById(`${key}-hdg-sl`);
  const inp = document.getElementById(`${key}-hdg`);
  if (!sl || !inp) return;
  if (src === 'slider') inp.value = sl.value;
  else sl.value = ((parseInt(inp.value) || 0) + 360) % 360;
  if (!state.legHdgOverride) state.legHdgOverride = {};
  state.legHdgOverride[key] = parseInt(inp.value) || 0;
  saveSettings();
  if (state.pattern) calculate();
}

function onLegHdgOverrideToggle(key, checked) {
  if (!state.legHdgOverride) state.legHdgOverride = {};
  if (checked) {
    // Pre-populate with current computed track heading
    let defaultHdg = 0;
    if (state.pattern) {
      if      (key === 'dw') defaultHdg = Math.round(state.pattern.dwTrackHdg ?? (state.pattern.fHdg + 180) % 360 ?? 180);
      else if (key === 'b')  defaultHdg = Math.round(state.pattern.bTrackHdg  ?? state.pattern.bHdg  ?? 0);
      else if (key === 'f')  defaultHdg = Math.round(state.pattern.fTrackHdg  ?? state.pattern.fHdgActual ?? 0);
    }
    state.legHdgOverride[key] = defaultHdg;
    const row = document.getElementById(`${key}-hdg-row`);
    if (row) row.style.display = 'flex';
    const sl  = document.getElementById(`${key}-hdg-sl`);
    const inp = document.getElementById(`${key}-hdg`);
    if (sl)  sl.value  = defaultHdg;
    if (inp) inp.value = defaultHdg;
    // Downwind: if Z pattern is on, turn it off (conflict)
    if (key === 'dw' && state.zPattern) {
      state.zPattern = false;
      const zCb = document.getElementById('dw-z-check');
      if (zCb) zCb.checked = false;
    }
    updateZRowState();
  } else {
    state.legHdgOverride[key] = null;
    const row = document.getElementById(`${key}-hdg-row`);
    if (row) row.style.display = 'none';
    if (key === 'dw') updateZRowState();
  }
  saveSettings();
  if (state.pattern) calculate();
}

function updateZRowState() {
  const zRow = document.getElementById('dw-z-row');
  if (!zRow) return;
  const disabled = state.legHdgOverride?.dw != null;
  zRow.style.opacity       = disabled ? '0.4' : '';
  zRow.style.pointerEvents = disabled ? 'none' : '';
  const zCb = document.getElementById('dw-z-check');
  if (zCb) zCb.disabled = disabled;
}

// Render leg cards immediately — must run before app.js calls loadSettings()
renderLegs();
