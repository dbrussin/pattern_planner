// ─── UI-CANOPY ─────────────────────────────────────────────────────────────────
// Canopy performance three-way calculator (global and per-leg).
// Depends on: config, state, storage, calculate

// Per-leg canopy three-way calc — tracks which two fields were most recently edited
const legLastEdited = Object.fromEntries(LEG_DEFS.map(l => [l.key, ['glide', 'speed']]));

// ── Leg mode toggles ──────────────────────────────────────────────────────────

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

// ── Per-leg custom performance section toggles ────────────────────────────────

function updatePerfSections() {
  const allLegKeys = [...LEG_DEFS.map(l => l.key), ...state.extraLegs.map(xl => xl.id)];
  allLegKeys.forEach(leg => {
    const cb      = document.getElementById(`${leg}-custom-perf`);
    const section = document.getElementById(`${leg}-perf`);
    if (!cb || !section) return;
    //const wasOpen = section.style.display !== 'none';
    const wasOpen = !!state.legCustomPerf[leg];
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

  const calc = canopyThird(g, s, k, third);
  if (calc !== null) {
    const labels = {sink: `Calculated vertical: ${calc} kts`, speed: `Calculated horiz: ${calc} kts`, glide: `Calculated glide: ${calc}:1`};
    const elMap  = {sink: sinkEl, speed: speedEl, glide: glideEl};
    if (elMap[third]) { elMap[third].value = calc; elMap[third].style.color = 'var(--muted)'; }
    if (noteEl) noteEl.textContent = labels[third];
  } else if (noteEl) noteEl.textContent = '';

  [['glide', glideEl], ['speed', speedEl], ['sink', sinkEl]].forEach(([f, el]) => {
    if (el && legLastEdited[leg].includes(f)) el.style.color = 'var(--text)';
  });
}

/**
 * Returns {glide, cSpd} for a given leg, using per-leg override if enabled.
 * Falls back to global canopy defaults when custom performance is not active.
 * @param {string} leg - Leg key (e.g. 'dw', 'b', 'f', or extra leg id)
 * @returns {{glide: number, cSpd: number}} Glide ratio and horizontal canopy speed (kts)
 */
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

// ── Shared three-way canopy performance solver ────────────────────────────────

/**
 * Compute the third canopy performance value given any two.
 * Relationship: vertical_kts = horizontal_kts / glide_ratio
 * @param {number} g - Glide ratio (NaN = not provided)
 * @param {number} s - Horizontal speed kts (NaN = not provided)
 * @param {number} k - Vertical speed kts (NaN = not provided)
 * @param {string} third - The field to compute ('glide' | 'speed' | 'sink')
 * @returns {number|null} Computed value rounded to 1 decimal, or null if inputs insufficient
 */
function canopyThird(g, s, k, third) {
  if (third === 'sink'  && !isNaN(g) && !isNaN(s)) return Math.round((s / g) * 10) / 10;
  if (third === 'speed' && !isNaN(g) && !isNaN(k)) return Math.round(k * g * 10) / 10;
  if (third === 'glide' && !isNaN(s) && !isNaN(k)) return Math.round((s / k) * 10) / 10;
  return null;
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
  if (!glideEl || !speedEl || !sinkEl) return;

  const g = parseFloat(glideEl.value);
  const s = parseFloat(speedEl.value);
  const k = parseFloat(sinkEl.value);

  const [a, b] = canopyLastEdited;
  const third  = ['glide', 'speed', 'sink'].find(f => f !== a && f !== b);
  const calc   = canopyThird(g, s, k, third);

  if (calc !== null) {
    const labels = {sink: `Calculated vertical speed: ${calc} kts`, speed: `Calculated horiz speed: ${calc} kts`, glide: `Calculated glide: ${calc}:1`};
    const elMap  = {sink: sinkEl, speed: speedEl, glide: glideEl};
    elMap[third].value       = calc;
    elMap[third].style.color = 'var(--muted)';
    if (noteEl) noteEl.textContent = labels[third];
  } else {
    if (noteEl) noteEl.textContent = '';
  }
  [['glide', glideEl], ['speed', speedEl], ['sink', sinkEl]].forEach(([f, el]) => {
    if (canopyLastEdited.includes(f)) el.style.color = 'var(--text)';
  });
}
