// ─── UI-GROUPS ─────────────────────────────────────────────────────────────────
// Jump run group management: render cards, add/remove, persist state.
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

function renderGroups() {
  const container = document.getElementById('groups-container');
  if (!container) return;
  container.innerHTML = '';

  // Render newly added groups on top (highest index first); group #1 stays at the bottom.
  // Group #1 (groups[0]) is mandatory: no remove button.
  // Additional groups: only the most recently added one (highest idx) shows a remove button.
  const groups = state.freefall.groups;
  const extras = groups.slice(1);
  const lastExtraIdx = extras.length
    ? Math.max(...extras.map(g => parseInt(g.id.replace('g', '')) || 0))
    : -1;

  // Build display order: newest extras first, then group #1.
  const sortedExtras = [...extras].sort((a, b) =>
    (parseInt(b.id.replace('g', '')) || 0) - (parseInt(a.id.replace('g', '')) || 0)
  );
  const displayOrder = [...sortedExtras, groups[0]].filter(Boolean);

  displayOrder.forEach(g => {
    const isMandatory = g === groups[0];
    const groupNum    = parseInt(g.id.replace('g', '')) || 1;
    const isMvmt      = GROUP_TYPES[g.type]?.isMovement;
    const showRemove  = !isMandatory && groupNum === lastExtraIdx;

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
    const removeBtn = showRemove
      ? `<button class="leg-remove-btn" onclick="removeGroup('${g.id}')" title="Remove group">×</button>`
      : '';

    const card = document.createElement('div');
    card.className = 'group-card';
    card.innerHTML = `
      <div class="group-row">
        <span class="group-field-label">#${groupNum}</span>
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
      ${mvmtRow}`;
    container.appendChild(card);
  });

  // Reset button (mirrors Reset Pattern Legs)
  const resetBtn = document.createElement('button');
  resetBtn.className = 'leg-reset-btn';
  resetBtn.textContent = 'Reset Jump Run Groups';
  resetBtn.onclick = resetJumpRunGroups;
  container.appendChild(resetBtn);
}

function addGroup() {
  const idx = state.freefall.nextGroupIdx++;
  state.freefall.groups.push({
    id:   `g${idx}`,
    name: `Group ${idx}`,
    size: 4,
    type: 'FS',
    mvmt: 'R',
  });
  renderGroups();
  saveSettings();
  if (state.target) calculate();
}

function removeGroup(id) {
  // Group #1 is mandatory and cannot be removed.
  if (id === state.freefall.groups[0]?.id) return;
  const i = state.freefall.groups.findIndex(g => g.id === id);
  if (i === -1) return;
  state.freefall.groups.splice(i, 1);
  // Reset nextGroupIdx so that re-adding starts from 2 when only group #1 remains.
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
  state.freefall.groups = [{ id: 'g1', name: 'Group 1', size: 4, type: 'FS', mvmt: 'R' }];
  state.freefall.nextGroupIdx = 2;
  renderGroups();
  saveSettings();
  if (state.target) calculate();
}

function setGroupField(id, field, value) {
  const g = state.freefall.groups.find(x => x.id === id);
  if (!g) return;
  if (field === 'size') {
    const n = Math.max(1, Math.min(20, parseInt(value) || 1));
    g.size = n;
  } else if (field === 'type') {
    g.type = GROUP_TYPES[value] ? value : 'FS';
    renderGroups(); // movement row visibility may change
  } else if (field === 'name') {
    g.name = String(value).slice(0, 32);
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
