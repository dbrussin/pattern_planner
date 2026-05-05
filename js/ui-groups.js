// ─── UI-GROUPS ─────────────────────────────────────────────────────────────────
// Jump run group management: render cards, add/remove, drag-drop reorder, persist.
// Group #1 (groups[0]) is mandatory and cannot be removed; its type drives
// the freefall speed used by the canopy exit-ring calculation.
// Depends on: config (GROUP_TYPES), state, storage, calculate

// Group type → freefall fall rate (mph) and average glide ratio (movement only).
// FS, Student, Tandem all fall belly at ~120 mph; VFS is head-down at ~170 mph;
// Movement (tracking/angle) is ~140 mph average vertical with 0.8:1 horizontal glide.
const GROUP_TYPES = {
  FS:       { label: 'FS',       fallMph: 120, glide: 0,    isMovement: false },
  VFS:      { label: 'VFS',      fallMph: 170, glide: 0,    isMovement: false },
  Movement: { label: 'Movement', fallMph: 140, glide: 0.8,  isMovement: true  },
  Student:  { label: 'Student',  fallMph: 120, glide: 0,    isMovement: false },
  Tandem:   { label: 'Tandem',   fallMph: 120, glide: 0,    isMovement: false },
};

// Default opening altitude per group type (ft AGL)
const DEFAULT_OPEN_ALT = { FS: 3000, VFS: 3500, Movement: 3500, Student: 3500, Tandem: 3500 };

// ── Drag-drop state ────────────────────────────────────────────────────────────
let _dragSrcId = null;

function _onDragStart(e, id) {
  _dragSrcId = id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function _onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.group-card.drag-over').forEach(el => el.classList.remove('drag-over'));
}

function _onDragOver(e, id) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (id !== _dragSrcId) {
    document.querySelectorAll('.group-card').forEach(el => el.classList.remove('drag-over'));
    e.currentTarget.classList.add('drag-over');
  }
}

function _onDrop(e, targetId) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (!_dragSrcId || _dragSrcId === targetId) return;

  const groups  = state.freefall.groups;
  const srcIdx  = groups.findIndex(g => g.id === _dragSrcId);
  const tgtIdx  = groups.findIndex(g => g.id === targetId);
  if (srcIdx === -1 || tgtIdx === -1) return;

  const [moved] = groups.splice(srcIdx, 1);
  groups.splice(tgtIdx, 0, moved);

  _dragSrcId = null;
  renderGroups();
  saveSettings();
  if (state.target) calculate();
}

// ── Group card rendering ───────────────────────────────────────────────────────

function renderGroups() {
  const container = document.getElementById('groups-container');
  if (!container) return;
  container.innerHTML = '';

  const groups = state.freefall.groups;

  groups.forEach((g, gi) => {
    const isMandatory = gi === 0;
    const isMvmt      = GROUP_TYPES[g.type]?.isMovement;
    const openAlt     = g.openAlt     ?? DEFAULT_OPEN_ALT[g.type] ?? 3000;
    const breakoffAlt = g.breakoffAlt ?? (openAlt + 1500);
    const vSpeedMph   = g.vSpeedMph   ?? GROUP_TYPES[g.type]?.fallMph ?? 120;

    const removeBtn = isMandatory
      ? ''
      : `<button class="leg-remove-btn" onclick="removeGroup('${g.id}')" title="Remove group">×</button>`;

    const mvmtRow = isMvmt ? `
      <div class="group-row">
        <span class="group-field-label">Movement</span>
        <div class="group-mvmt-group">
          <button class="group-mvmt-btn${g.mvmt === 'L' ? ' active' : ''}" onclick="setGroupMvmt('${g.id}','L')">← L</button>
          <button class="group-mvmt-btn${g.mvmt === 'R' ? ' active' : ''}" onclick="setGroupMvmt('${g.id}','R')">R →</button>
        </div>
      </div>` : '';

    const typeOpts = Object.keys(GROUP_TYPES).map(k =>
      `<option value="${k}"${k === g.type ? ' selected' : ''}>${GROUP_TYPES[k].label}</option>`
    ).join('');

    const mandatoryBadge = isMandatory
      ? `<span class="group-mandatory-badge">G1</span>`
      : '';

    const card = document.createElement('div');
    card.className = 'group-card';
    card.draggable = true;
    card.dataset.id = g.id;

    card.addEventListener('dragstart', e => _onDragStart(e, g.id));
    card.addEventListener('dragend',   e => _onDragEnd(e));
    card.addEventListener('dragover',  e => _onDragOver(e, g.id));
    card.addEventListener('drop',      e => _onDrop(e, g.id));

    card.innerHTML = `
      <div class="group-row">
        <span class="group-handle" title="Drag to reorder">⠿</span>
        ${mandatoryBadge}
        <input class="group-name-input" type="text" value="${g.name}" placeholder="Group name"
          oninput="setGroupField('${g.id}','name',this.value)">
        ${removeBtn}
      </div>
      <div class="group-row">
        <span class="group-field-label">Jumpers</span>
        <input class="group-num-input" type="number" min="1" max="20" step="1" value="${g.size}"
          oninput="setGroupField('${g.id}','size',this.value)">
        <span class="group-field-label">Type</span>
        <select class="group-type-select" onchange="setGroupField('${g.id}','type',this.value)">${typeOpts}</select>
      </div>
      ${mvmtRow}
      <div class="group-row group-row--compact">
        <span class="group-field-label">Vert speed</span>
        <input class="group-num-input" type="number" min="60" max="220" step="5" value="${vSpeedMph}"
          oninput="setGroupField('${g.id}','vSpeedMph',this.value)">
        <span class="group-field-label">mph</span>
      </div>
      <div class="group-row group-row--compact">
        <span class="group-field-label">Opening Alt</span>
        <input class="group-num-input group-alt-input" type="number" min="500" max="8000" step="100" value="${openAlt}"
          oninput="setGroupField('${g.id}','openAlt',this.value)">
        <span class="group-field-label">ft AGL</span>
      </div>
      <div class="group-row group-row--compact">
        <span class="group-field-label">Breakoff Alt</span>
        <input class="group-num-input group-alt-input" type="number" min="1000" max="20000" step="100" value="${breakoffAlt}"
          oninput="setGroupField('${g.id}','breakoffAlt',this.value)">
        <span class="group-field-label">ft AGL</span>
      </div>`;

    container.appendChild(card);
  });

  const resetBtn = document.createElement('button');
  resetBtn.className = 'leg-reset-btn';
  resetBtn.textContent = 'Reset Jump Run Groups';
  resetBtn.onclick = resetJumpRunGroups;
  container.appendChild(resetBtn);
}

function addGroup() {
  const idx     = state.freefall.nextGroupIdx++;
  const type    = 'FS';
  const openAlt = DEFAULT_OPEN_ALT[type] ?? 3000;
  state.freefall.groups.push({
    id: `g${idx}`, name: `Group ${idx}`, size: 4, type, mvmt: 'R',
    openAlt, breakoffAlt: openAlt + 1500, vSpeedMph: GROUP_TYPES[type].fallMph,
  });
  renderGroups();
  saveSettings();
  if (state.target) calculate();
}

function removeGroup(id) {
  if (state.freefall.groups[0]?.id === id) return; // group #1 is mandatory
  const i = state.freefall.groups.findIndex(g => g.id === id);
  if (i === -1) return;
  state.freefall.groups.splice(i, 1);
  if (state.freefall.groups.length <= 1) {
    state.freefall.nextGroupIdx = 2;
  } else {
    const maxIdx = Math.max(...state.freefall.groups.map(g => parseInt(g.id.replace('g', '')) || 0));
    state.freefall.nextGroupIdx = maxIdx + 1;
  }
  renderGroups();
  saveSettings();
  if (state.target) calculate();
}

function resetJumpRunGroups() {
  state.freefall.groups = [{
    id: 'g1', name: 'Group 1', size: 4, type: 'FS', mvmt: 'R',
    openAlt: 3000, breakoffAlt: 4500, vSpeedMph: 120,
  }];
  state.freefall.nextGroupIdx = 2;
  renderGroups();
  saveSettings();
  if (state.target) calculate();
}

function setGroupField(id, field, value) {
  const g = state.freefall.groups.find(x => x.id === id);
  if (!g) return;
  if (field === 'size') {
    g.size = Math.max(1, Math.min(20, parseInt(value) || 1));
  } else if (field === 'type') {
    const newType     = GROUP_TYPES[value] ? value : 'FS';
    const vWasDefault = (g.vSpeedMph === GROUP_TYPES[g.type]?.fallMph);
    const oWasDefault = (g.openAlt   === (DEFAULT_OPEN_ALT[g.type] ?? 3000));
    g.type = newType;
    if (vWasDefault)    g.vSpeedMph = GROUP_TYPES[newType].fallMph;
    if (oWasDefault) {
      g.openAlt     = DEFAULT_OPEN_ALT[newType] ?? 3000;
      g.breakoffAlt = g.openAlt + 1500;
    }
    renderGroups();
  } else if (field === 'name') {
    g.name = String(value).slice(0, 32);
  } else if (field === 'openAlt') {
    const prev = g.openAlt ?? DEFAULT_OPEN_ALT[g.type] ?? 3000;
    g.openAlt  = Math.max(500, Math.min(8000, parseInt(value) || 3000));
    // Shift breakoffAlt by same delta if it was at default
    const defaultBreakoff = prev + 1500;
    if (!g._breakoffManual && Math.abs((g.breakoffAlt ?? defaultBreakoff) - defaultBreakoff) < 50) {
      g.breakoffAlt = g.openAlt + 1500;
    }
  } else if (field === 'breakoffAlt') {
    g.breakoffAlt    = Math.max(1000, Math.min(20000, parseInt(value) || 4500));
    g._breakoffManual = true;
  } else if (field === 'vSpeedMph') {
    g.vSpeedMph = Math.max(60, Math.min(220, parseFloat(value) || 120));
  }
  saveSettings();
  if (state.target) calculate();
}

function setGroupMvmt(id, dir) {
  const g = state.freefall.groups.find(x => x.id === id);
  if (!g) return;
  g.mvmt = dir === 'L' ? 'L' : 'R';
  renderGroups();
  saveSettings();
  if (state.target) calculate();
}

renderGroups();
