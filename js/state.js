// ─── STATE ─────────────────────────────────────────────────────────────────────
// Central application state. All modules read/write this object directly.

const STORAGE_VERSION = '3';
const WAIVER_VERSION  = '1.0';

const state = {
  // ── Mode toggles (independent on/off; both can be active at once) ──
  // Future modes (e.g. movement planner) live as sub-options inside these top-level modes.
  modes: { canopy: true, freefall: false },

  // ── Shared state (mode-agnostic) ──
  target: null,
  fieldElevFt: 0,
  winds: [],
  surfaceWind: null,
  forecastOffset: 0,
  fitDone: false,
  driftThresh: 5,  // degrees — show steered heading line when crab/drift exceeds this
  manualDzZero: false,
  layers: { jumpRun: true, exitRegion: true, canopyRegions: true, turnAltLabels: true, legDistances: true, legHeadings: true, legArrows: true, freefallPaths: true, freefallLabels: true, legend: true },

  // ── Canopy mode state (canopy-specific inputs and result) ──
  canopy: {
    result: null,                                                       // populated by calculateCanopyPattern()
    hand: 'left',
    finalHeadingDeg: null,
    manualHeading: false,
    legModes:     Object.fromEntries(LEG_DEFS.map(l => [l.key, l.key === 'b' ? 'drift' : 'crab'])),
    zPattern: false,
    legCustomPerf: Object.fromEntries(LEG_DEFS.map(l => [l.key, false])),
    extraLegs: [],
    nextExtraLegIdx: 1,
    legHdgOverride: {dw: null, b: null, f: null},
  },

  // ── Jump run state (shared between canopy spot calc and freefall planner) ──
  jumpRun: {
    hdgDeg: null,
    manualHeading: false,
    manualOffset: false,
    manualGreenLight: false,
    manualRedLight: false,
  },

  // ── Freefall mode state (jump run planner / movement planner) ──
  // Group #1 is mandatory: cannot be removed, sets freefall speed for canopy calc.
  freefall: {
    result: null,                                                       // populated by calculateFreefallPlan()
    groups: [{ id: 'g1', name: 'Group 1', size: 4, type: 'FS', mvmt: 'R' }],
    nextGroupIdx: 2,
  },
};

// Input IDs that are persisted to localStorage on every change
const PERSIST_INPUTS = [
  'alt-enter', 'alt-base', 'alt-final',
  'alt-exit', 'alt-open',
  'jr-airspeed', 'exit-sep', 'safety-margin',
  'glide', 'canopy-speed', 'drift-thresh',
  'turn-bank',
  'dz-zero-lat', 'dz-zero-lng',
];
