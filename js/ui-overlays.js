// ─── UI-OVERLAYS ───────────────────────────────────────────────────────────────
// Status pill, overlay panel toggles, legend, layer toggles, and hand toggle.
// Depends on: config, state, storage, calculate, draw

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
