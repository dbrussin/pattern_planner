// ─── STATE ─────────────────────────────────────────────────────────────────────
// Central application state. All modules read/write this object directly.

const STORAGE_VERSION = '2';
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
  layers: { jumpRun: true, exitRegion: true, canopyRegions: true, turnAltLabels: true, legDistances: true, legHeadings: true, legArrows: true, legend: true },

  // ── Canopy result + canopy-mode state ──
  // pattern: result of calculateCanopyPattern() — read by drawCanopyPattern()
  pattern: null,
  hand: 'left',
  finalHeadingDeg: null,
  manualHeading: false,
  // Per-leg modes: 'crab' | 'drift' — keyed by LEG_DEFS[].key; extra legs add entries dynamically
  legModes:     Object.fromEntries(LEG_DEFS.map(l => [l.key, l.key === 'b' ? 'drift' : 'crab'])),
  zPattern: false,  // Z pattern is independent of crab/drift
  // Per-leg custom canopy performance — keyed by LEG_DEFS[].key; extra legs add entries dynamically
  legCustomPerf: Object.fromEntries(LEG_DEFS.map(l => [l.key, false])),
  // Dynamically added extra legs above downwind: [{id, defaultAlt, color}]
  extraLegs: [],
  nextExtraLegIdx: 1,
  // Per-leg approach heading overrides: null = use computed heading
  legHdgOverride: {dw: null, b: null, f: null},

  // ── Jump run state (currently emitted by canopy calc; freefall jump-run planner
  //    will write to the same fields) ──
  jumpRunHdgDeg: null,
  manualJumpRun: false,
  manualJrOffset: false,
  manualGreenLight: false,
  manualRedLight: false,
  manualDzZero: false,

  // ── Freefall result + freefall-mode state (placeholder; populated by future
  //    calculateFreefallPlan() — jump run planner, movement planner, etc.) ──
  freefall: null,
};

// Input IDs that are persisted to localStorage on every change
const PERSIST_INPUTS = [
  'alt-enter', 'alt-base', 'alt-final',
  'alt-exit', 'alt-open', 'ff-speed',
  'jr-airspeed', 'exit-sep', 'safety-margin',
  'glide', 'canopy-speed', 'drift-thresh',
  'turn-bank',
  'dz-zero-lat', 'dz-zero-lng',
];
