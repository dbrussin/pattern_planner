// ─── UI-LEGS ───────────────────────────────────────────────────────────────────
// Leg card rendering, altitude slider sync, extra leg management, and heading overrides.
// Depends on: config, state, storage, ui-canopy (legLastEdited), calculate

// ── Leg cards (data-driven from LEG_DEFS in config.js) ────────────────────────

// Shared HTML fragment builders (keep token-light templates DRY)
function _legAltField(id, label, def, min, max, step) {
  return `
      <div class="leg-field">
        <label class="leg-field-label">${label}</label>
        <div class="leg-slider-row">
          <input type="range" id="${id}-sl" class="alt-slider" min="${min}" max="${max}" step="${step}" value="${def}" oninput="onLegAlt('${id}','slider')">
          <input type="number" id="${id}" class="leg-num" min="${min}" max="${max}" step="${step}" value="${def}" oninput="onLegAlt('${id}','input')" onblur="onLegAlt('${id}','blur')">
        </div>
      </div>`;
}
function _legPerfBlock(key, openCls) {
  return `
          <div class="leg-opt-row">
            <label class="leg-opt-label">Custom performance</label>
            <input type="checkbox" id="${key}-custom-perf"${openCls ? ' checked' : ''} onchange="updatePerfSections()">
          </div>
          <div id="${key}-perf" class="leg-perf${openCls ? ' leg-perf--open' : ''}">
            <div class="input-grid">
              <div class="input-group"><label for="${key}-glide">Glide (:1)</label><input type="number" id="${key}-glide" value="2.5" min="1" max="10" step="0.1" oninput="onLegCanopyInput('${key}','glide')"></div>
              <div class="input-group"><label for="${key}-speed">Horiz (kts)</label><input type="number" id="${key}-speed" value="28" min="10" max="60" step="0.5" oninput="onLegCanopyInput('${key}','speed')"></div>
              <div class="input-group"><label for="${key}-sink">Vert (kts)</label><input type="number" id="${key}-sink" value="" min="1" max="30" step="0.1" placeholder="calc" oninput="onLegCanopyInput('${key}','sink')" data-allow-empty="true"></div>
            </div>
            <div id="${key}-perf-note" class="field-note leg-perf-note"></div>
          </div>`;
}
function _legHeader(id, label, color, extraBtns = '') {
  const mode = state.legModes[id] || 'crab';
  return `
      <div class="leg-header">
        <div class="leg-color-dot" style="background:${color}"></div>
        <span class="leg-title">${label}</span>
        <div class="leg-mode-group">
          <button id="${id}-crab"  class="leg-mode-btn${mode === 'crab'  ? ' active' : ''}" onclick="setLegMode('${id}','crab')">Crab</button>
          <button id="${id}-drift" class="leg-mode-btn${mode === 'drift' ? ' active' : ''}" onclick="setLegMode('${id}','drift')">Drift</button>
        </div>
        ${extraBtns}
      </div>`;
}

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
    const removeBtn = xl.id === lifoId
      ? `<button class="leg-remove-btn" onclick="removeExtraLeg('${xl.id}')" title="Remove leg">×</button>`
      : '';
    const cp       = !!state.legCustomPerf[xl.id];
    const detOpen  = cp ? 'open' : '';
    const legNum   = parseInt(xl.id.replace('xl', '')) + 3;
    const nomHdg   = xl.nomHdg ?? 0;

    const card = document.createElement('div');
    card.className = 'leg-card';
    card.innerHTML = `${_legHeader(xl.id, `Leg ${legNum}`, xl.color, removeBtn)}
      ${_legAltField(`alt-${xl.id}`, 'Alt (ft AGL)', xl.defaultAlt, 200, 5000, 50)}
      <div class="leg-field">
        <label class="leg-field-label">Approach hdg</label>
        <div class="leg-slider-row">
          <input type="range" id="hdg-sl-${xl.id}" class="hdg-slider" min="0" max="359" step="1" value="${nomHdg}" oninput="onExtraLegHdg('${xl.id}','slider')">
          <input type="number" id="hdg-${xl.id}" class="leg-num leg-num--hdg" min="0" max="359" step="1" value="${nomHdg}" oninput="onExtraLegHdg('${xl.id}','input')">
        </div>
      </div>
      <details id="leg-details-${xl.id}" class="leg-details" ${detOpen}>
        <summary class="leg-details-summary"><span class="leg-details-arrow">▸</span>More options</summary>
        <div class="leg-details-body">${_legPerfBlock(xl.id, cp)}
        </div>
      </details>`;
    container.appendChild(card);
  });

  // ── Standard legs (Downwind, Base, Final) ──
  // Z-pattern option only shown on downwind, and only when no extra legs exist
  // Final leg uses the dedicated Final Hdg slider — clear any legacy override
  if (state.legHdgOverride?.f != null) { state.legHdgOverride.f = null; }
  const _barVal = parseFloat(document.getElementById('heading-bar-val')?.value);
  const initialFinalHdg = Math.round(
    state.finalHeadingDeg ??
    (!isNaN(_barVal) ? _barVal : null) ??
    state.surfaceWind?.dirDeg ??
    0
  );
  LEG_DEFS.forEach(def => {
    const { key, label, color, altId, altLabel, altDefault, altMin, altMax, altStep } = def;

    const showZ     = !hasExtras && key === 'dw';
    const cp        = !!state.legCustomPerf[key];
    const hdgOverride = state.legHdgOverride?.[key] ?? null;
    const hdgOvrOn  = hdgOverride != null;
    const hdgVal    = hdgOverride ?? 0;
    const zDisabled = showZ && hdgOvrOn;
    const detOpen   = (cp || (showZ && state.zPattern) || hdgOvrOn) ? 'open' : '';

    const zRow = showZ ? `
          <div id="dw-z-row" class="leg-opt-row${zDisabled ? ' leg-opt-row--disabled' : ''}">
            <label class="leg-opt-label">Z pattern (downwind same direction as final)</label>
            <input type="checkbox" id="dw-z-check"${state.zPattern ? ' checked' : ''}${zDisabled ? ' disabled' : ''} onchange="toggleZPattern(this.checked)">
          </div>` : '';

    const finalHdgRow = key === 'f' ? `
      <div class="leg-field">
        <label class="leg-field-label">Final Hdg</label>
        <div class="leg-slider-row">
          <div class="leg-final-hdg-wrap">
            <input type="range" id="settings-hdg-final-sl" class="hdg-slider" min="0" max="359" step="1" value="${initialFinalHdg}" oninput="onSettingsFinalHdg('slider')">
            <div id="settings-wind-pyramid" class="pyramid"></div>
            <div id="settings-wind-pyramid-hit" class="pyramid-hit" onclick="snapToWind()" title="Snap to into-wind heading"></div>
          </div>
          <input type="number" id="settings-hdg-final" class="leg-num leg-num--hdg" min="0" max="359" step="1" value="${initialFinalHdg}" oninput="onSettingsFinalHdg('input')">
        </div>
      </div>` : '';

    const hdgOverrideRow = key !== 'f' ? `
          <div id="${key}-hdg-override-wrap" class="leg-field">
            <div class="leg-opt-row">
              <label class="leg-opt-label">Override approach hdg</label>
              <input type="checkbox" id="${key}-hdg-check"${hdgOvrOn ? ' checked' : ''} onchange="onLegHdgOverrideToggle('${key}',this.checked)">
            </div>
            <div id="${key}-hdg-row" class="leg-slider-row${hdgOvrOn ? '' : ' is-hidden'}">
              <input type="range" id="${key}-hdg-sl" class="hdg-slider" min="0" max="359" step="1" value="${hdgVal}" oninput="onStdLegHdg('${key}','slider')">
              <input type="number" id="${key}-hdg" class="leg-num leg-num--hdg" min="0" max="359" step="1" value="${hdgVal}" oninput="onStdLegHdg('${key}','input')">
            </div>
          </div>` : '';

    const card = document.createElement('div');
    card.className = 'leg-card';
    card.innerHTML = `${_legHeader(key, label, color)}
      ${_legAltField(altId, altLabel, altDefault, altMin, altMax, altStep)}
      ${finalHdgRow}
      <details id="leg-details-${key}" class="leg-details" ${detOpen}>
        <summary class="leg-details-summary"><span class="leg-details-arrow">▸</span>More options</summary>
        <div class="leg-details-body">${hdgOverrideRow}${zRow}${_legPerfBlock(key, cp)}
        </div>
      </details>`;
    container.appendChild(card);
  });

  // Reset to defaults button
  const resetBtn = document.createElement('button');
  resetBtn.className = 'leg-reset-btn';
  resetBtn.textContent = 'Reset Pattern Legs';
  resetBtn.onclick = resetPatternLegs;
  container.appendChild(resetBtn);

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

  // Refresh slider min/max to reflect current valid ranges
  updateAllSliderRanges();
  // Pyramid position depends on clientWidth — defer until after layout
  requestAnimationFrame(updateSettingsWindPyramid);
}

// ── Leg altitude slider sync ──────────────────────────────────────────────────

// Returns the valid [min, max] altitude range for a leg input, using the same
// ordering as the render (extra legs sorted by defaultAlt descending) so that
// constraint neighbours always match what the user sees on screen.
function getLegAltConstraints(numId) {
  const MIN_GAP  = 100;
  const altEnter = parseFloat(document.getElementById('alt-enter')?.value) || 900;
  const altBase  = parseFloat(document.getElementById('alt-base')?.value)  || 600;
  const altFinal = parseFloat(document.getElementById('alt-final')?.value) || 300;
  const altOpen  = parseFloat(document.getElementById('alt-open')?.value)  || 3000;
  const altExit  = parseFloat(document.getElementById('alt-exit')?.value)  || 13500;
  // Ceiling for the highest canopy leg: must stay below opening altitude
  const topMax   = altOpen - MIN_GAP;

  // Extra legs in display order: highest defaultAlt first (same sort as renderLegs)
  const displayOrder = [...(state.extraLegs || [])].sort((a, b) => b.defaultAlt - a.defaultAlt);
  const getAlt = xl => parseFloat(document.getElementById(`alt-${xl.id}`)?.value) ?? xl.defaultAlt;

  if (numId === 'alt-final') return { min: 100, max: Math.max(100, altBase - MIN_GAP) };
  if (numId === 'alt-base')  return { min: altFinal + MIN_GAP, max: Math.max(altFinal + MIN_GAP, altEnter - MIN_GAP) };
  if (numId === 'alt-enter') {
    // Lowest displayed extra leg (last in displayOrder) sets our ceiling; otherwise opening alt does
    const lowestXL = displayOrder.length > 0 ? getAlt(displayOrder[displayOrder.length - 1]) : Infinity;
    const maxVal   = isFinite(lowestXL) ? lowestXL - MIN_GAP : topMax;
    return { min: altBase + MIN_GAP, max: Math.max(altBase + MIN_GAP, maxVal) };
  }
  if (numId === 'alt-open') {
    // Highest canopy alt: max of alt-enter and any extra leg
    const highestXL = displayOrder.length > 0 ? getAlt(displayOrder[0]) : -Infinity;
    const highestLeg = isFinite(highestXL) ? Math.max(altEnter, highestXL) : altEnter;
    return { min: highestLeg + MIN_GAP, max: Math.max(highestLeg + MIN_GAP, altExit - MIN_GAP) };
  }
  if (numId === 'alt-exit') {
    return { min: altOpen + MIN_GAP, max: 25000 };
  }
  if (numId.startsWith('alt-xl')) {
    const xlId = numId.replace('alt-', '');
    const idx  = displayOrder.findIndex(xl => xl.id === xlId);
    if (idx === -1) return null;
    // displayOrder[0] = highest leg. idx-1 = leg above (higher alt), idx+1 = leg below (lower alt)
    const maxVal = idx === 0                      ? topMax                              : getAlt(displayOrder[idx - 1]) - MIN_GAP;
    const minVal = idx === displayOrder.length - 1 ? altEnter + MIN_GAP : getAlt(displayOrder[idx + 1]) + MIN_GAP;
    return { min: minVal, max: Math.max(minVal, maxVal) };
  }
  return null;
}

// Update the min/max attributes of every altitude slider to reflect current
// valid ranges, and clamp any values that are now out of bounds.
function updateAllSliderRanges() {
  const legIds = ['alt-final', 'alt-base', 'alt-enter'];
  legIds.forEach(id => applySliderRange(id));
  (state.extraLegs || []).forEach(xl => applySliderRange(`alt-${xl.id}`));
  // Jump run altitudes participate in the same constraint chain
  applySliderRange('alt-open');
  applySliderRange('alt-exit');
}

function applySliderRange(numId) {
  const c   = getLegAltConstraints(numId);
  const sl  = document.getElementById(numId + '-sl');
  const num = document.getElementById(numId);
  if (!c || !sl || !num) return;
  sl.min = c.min;
  sl.max = c.max;
  const v       = parseFloat(num.value);
  const clamped = Math.max(c.min, Math.min(c.max, v));
  if (!isNaN(clamped) && clamped !== v && document.activeElement !== num) { num.value = clamped; sl.value = clamped; }
}

function onLegAlt(numId, src) {
  const sl  = document.getElementById(numId + '-sl');
  const num = document.getElementById(numId);
  if (!sl || !num) return;
  if (src === 'slider') {
    num.value = sl.value; num.style.color = 'var(--text)';
    applySliderRange(numId);
    updateAllSliderRanges();
    saveSettings();
    if (state.target) calculate();
  } else if (src === 'blur') {
    // On blur: apply clamping, refresh adjacent ranges, save
    applySliderRange(numId);
    updateAllSliderRanges();
    saveSettings();
    if (state.target) calculate();
  } else {
    // On input (typing): sync slider position only — defer clamping to blur
    // so partial values don't get overwritten mid-keystroke
    sl.value = num.value;
    if (state.target) calculate();
  }
}

// ── Jump run alt cross-field enforcement ──────────────────────────────────────

function onExitAltChange() {
  applySliderRange('alt-exit');
  updateAllSliderRanges();
  calculate();
}

function onOpenAltChange() {
  applySliderRange('alt-open');
  updateAllSliderRanges();
  calculate();
}

// ── Extra leg heading sync ────────────────────────────────────────────────────

function onExtraLegHdg(id, src) {
  const sl  = document.getElementById(`hdg-sl-${id}`);
  const inp = document.getElementById(`hdg-${id}`);
  if (!sl || !inp) return;
  if (src === 'slider') {
    inp.value = sl.value;
  } else {
    const d = ((parseInt(inp.value) || 0) + 360) % 360;
    inp.value = d;
    sl.value  = d;
  }
  const xl = state.extraLegs.find(x => x.id === id);
  if (xl) xl.nomHdg = parseInt(inp.value) || 0;
  saveSettings();
  if (state.pattern) calculate();
}

// ── Reset pattern legs to defaults ────────────────────────────────────────────

function resetPatternLegs() {
  // Clean up state for all extra legs
  state.extraLegs.forEach(xl => {
    delete state.legModes[xl.id];
    delete state.legCustomPerf[xl.id];
    delete legLastEdited[xl.id];
    if (state.legHdgOverride) delete state.legHdgOverride[xl.id];
  });
  state.extraLegs       = [];
  state.nextExtraLegIdx = 1;

  // Reset standard leg altitudes to defaults
  LEG_DEFS.forEach(def => {
    const el   = document.getElementById(def.altId);
    const slEl = document.getElementById(def.altId + '-sl');
    if (el)   el.value   = def.altDefault;
    if (slEl) slEl.value = def.altDefault;
    if (state.legHdgOverride) state.legHdgOverride[def.key] = null;
  });

  // Reset leg modes and pattern options to defaults
  state.legModes      = Object.fromEntries(LEG_DEFS.map(l => [l.key, l.key === 'b' ? 'drift' : 'crab']));
  state.zPattern      = false;
  state.legCustomPerf = Object.fromEntries(LEG_DEFS.map(l => [l.key, false]));

  // Reset heading to auto-compute from wind
  state.manualHeading   = false;
  state.finalHeadingDeg = null;

  renderLegs();
  // Sync heading bar to current wind direction AFTER renderLegs() rebuilds the DOM,
  // so the snapshot-restore doesn't capture and re-apply the stale manual heading.
  if (state.surfaceWind?.dirDeg != null) updateHeadingDisplay(state.surfaceWind.dirDeg);
  // Collapse all expandable sections and explicitly reset checkbox/visibility state
  document.querySelectorAll('#legs-container details').forEach(d => { d.open = false; });
  LEG_DEFS.forEach(def => {
    const key = def.key;
    const hdgCheck = document.getElementById(`${key}-hdg-check`);
    if (hdgCheck) hdgCheck.checked = false;
    const hdgRow = document.getElementById(`${key}-hdg-row`);
    if (hdgRow) hdgRow.style.display = 'none';
    const cpCheck = document.getElementById(`${key}-custom-perf`);
    if (cpCheck) cpCheck.checked = false;
    const perf = document.getElementById(`${key}-perf`);
    if (perf) perf.style.display = 'none';
  });
  const zCheck = document.getElementById('dw-z-check');
  if (zCheck) zCheck.checked = false;
  saveSettings();
  if (state.target) calculate();
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

  // Default approach heading: directly downwind at leg altitude (into-wind = opposite)
  // Fall back to 90° rotation from previous leg if winds are calm or unavailable.
  const w = getWindAtAGL(newAlt);
  const windSpd = vecLen(w);
  let nomHdg;
  if (windSpd > MIN_WIND_SPD_KT) {
    // Wind vector {n,e} points in direction wind blows TO — fly that direction = downwind
    nomHdg = Math.round((Math.atan2(w.e, w.n) * R2D + 360) % 360);
  } else {
    // Calm winds: fall back to 90° rotation from previous leg
    const sign = state.hand === 'left' ? 1 : -1;
    let prevNomHdg;
    if (state.extraLegs.length > 0) {
      const lastXl = state.extraLegs[state.extraLegs.length - 1];
      const hdgInp = document.getElementById(`hdg-${lastXl.id}`);
      prevNomHdg = hdgInp ? (parseInt(hdgInp.value) || lastXl.nomHdg || 0) : (lastXl.nomHdg || 0);
    } else {
      prevNomHdg = state.pattern?.dwTrackHdg ?? ((state.pattern?.fHdg ?? 0) + 180) % 360;
    }
    nomHdg = Math.round((prevNomHdg + sign * 90 + 3600) % 360);
  }

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
  if (src === 'slider') {
    inp.value = sl.value;
  } else {
    const d = ((parseInt(inp.value) || 0) + 360) % 360;
    inp.value = d;
    sl.value  = d;
  }
  if (!state.legHdgOverride) state.legHdgOverride = {};
  state.legHdgOverride[key] = parseInt(inp.value) || 0;
  saveSettings();
  if (state.pattern) calculate();
}

function onLegHdgOverrideToggle(key, checked) {
  if (!state.legHdgOverride) state.legHdgOverride = {};
  if (checked) {
    // Seed with a value that produces no immediate jump: crab mode consumes the
    // override as TRACK, drift mode consumes it as STEER. Pick accordingly.
    let defaultHdg = 0;
    if (state.pattern) {
      if (key === 'dw') {
        defaultHdg = state.legModes.dw === 'crab'
          ? Math.round(state.pattern.dwTrackHdg ?? (state.pattern.fHdg + 180) % 360)
          : Math.round(state.pattern.dwHdg       ?? (state.pattern.fHdg + 180) % 360);
      } else if (key === 'b') {
        defaultHdg = state.legModes.b === 'crab'
          ? Math.round(state.pattern.bTrackHdg ?? state.pattern.bHdg ?? 0)
          : Math.round(state.pattern.bHdg       ?? state.pattern.bTrackHdg ?? 0);
      } else if (key === 'f') {
        defaultHdg = Math.round(state.pattern.fTrackHdg ?? state.pattern.fHdgActual ?? 0);
      }
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
