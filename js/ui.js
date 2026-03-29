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
  if (!state.target) return;
  const cached = findCachedWinds(state.target.lat, state.target.lng);
  if (cached) {
    processWindData(cached.rawData, cached.fieldElevFt);
    calculate();
  } else {
    fetchWinds(true).then(calculate);
  }
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
  state.zPattern = checked;
  saveSettings();
  if (state.pattern) calculate();
}

function updatePerfSections() {
  ['dw', 'b', 'f'].forEach(leg => {
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
const legLastEdited = {dw: ['glide', 'speed'], b: ['glide', 'speed'], f: ['glide', 'speed']};

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
