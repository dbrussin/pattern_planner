// ─── UI-HEADING ────────────────────────────────────────────────────────────────
// Final approach heading bar, forecast offset controls, and jump run heading controls.
// Depends on: config, state, geometry, wind (processWindData, findCachedWinds, fetchWinds),
//             calculate, draw

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
  const settingsSl  = document.getElementById('settings-hdg-final-sl');
  const settingsInp = document.getElementById('settings-hdg-final');
  if (settingsSl)  settingsSl.value  = d;
  if (settingsInp) settingsInp.value = d;
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
  const settingsSl  = document.getElementById('settings-hdg-final-sl');
  const settingsInp = document.getElementById('settings-hdg-final');
  if (settingsSl)  settingsSl.value  = d;
  if (settingsInp) settingsInp.value = d;
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

  updateSettingsWindPyramid();
}

function updateSettingsWindPyramid() {
  const windHdg = state.surfaceWind?.dirDeg ?? null;
  const pyr     = document.getElementById('settings-wind-pyramid');
  const pyrHit  = document.getElementById('settings-wind-pyramid-hit');
  if (!pyr || !pyrHit) return;
  if (windHdg === null) { pyr.style.display = 'none'; pyrHit.style.display = 'none'; return; }
  const slider = document.getElementById('settings-hdg-final-sl');
  if (!slider) { pyr.style.display = 'none'; pyrHit.style.display = 'none'; return; }
  const trackW = slider.clientWidth;
  const thumbR = 14;
  const pct    = ((thumbR + (windHdg / 359) * (trackW - 2 * thumbR)) / trackW) * 100;
  pyr.style.left       = pct + '%';
  pyrHit.style.left    = pct + '%';
  pyr.style.display    = 'block';
  pyrHit.style.display = 'block';
}

function onSettingsFinalHdg(src) {
  const sl  = document.getElementById('settings-hdg-final-sl');
  const inp = document.getElementById('settings-hdg-final');
  if (!sl || !inp) return;
  if (src === 'slider') {
    inp.value = sl.value;
  } else {
    const d = ((parseInt(inp.value) || 0) + 360) % 360;
    inp.value = d;
    sl.value  = d;
  }
  const deg = parseInt(sl.value);
  state.manualHeading   = true;
  state.finalHeadingDeg = deg;
  document.getElementById('heading-bar-val').value    = deg;
  document.getElementById('heading-bar-slider').value = deg;
  updateWindPyramid();
  calculate();
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

// ── Green / Red light overrides ───────────────────────────────────────────────

function onGreenLightInput() {
  const el = document.getElementById('green-light-override');
  if (!el) return;
  if (el.value === '') {
    state.manualGreenLight = false;
    el.style.color = 'var(--muted)';
  } else {
    state.manualGreenLight = true;
    el.style.color = 'var(--text)';
  }
  if (state.pattern) calculate();
}

function onRedLightInput() {
  const el = document.getElementById('red-light-override');
  if (!el) return;
  if (el.value === '') {
    state.manualRedLight = false;
    el.style.color = 'var(--muted)';
  } else {
    state.manualRedLight = true;
    el.style.color = 'var(--text)';
  }
  if (state.pattern) calculate();
}

// ── DZ reference zero point ───────────────────────────────────────────────────

function onDzZeroInput() {
  state.manualDzZero = true;
  updateMagDeclination();
  saveSettings();
  if (state.pattern) calculate();
}

function updateMagDeclination() {
  const latEl = document.getElementById('dz-zero-lat');
  const lngEl = document.getElementById('dz-zero-lng');
  const outEl = document.getElementById('dz-mag-decl');
  if (!latEl || !lngEl || !outEl) return;
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lngEl.value);
  if (!isFinite(lat) || !isFinite(lon)) { outEl.textContent = '—'; return; }
  const d = magDeclination(lat, lon);
  outEl.textContent = (d >= 0 ? '+' : '') + d.toFixed(1) + '°';
}

// ── Landing spot lat/lon ──────────────────────────────────────────────────────

const _debouncedPlaceFromLatLng = debounce(function() {
  const lat = parseFloat(document.getElementById('landing-lat')?.value);
  const lng = parseFloat(document.getElementById('landing-lng')?.value);
  if (isFinite(lat) && isFinite(lng)) placeTarget(lat, lng);
}, 800);

function onLandingLatLngInput() {
  _debouncedPlaceFromLatLng();
}
