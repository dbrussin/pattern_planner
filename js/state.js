// ─── STATE ─────────────────────────────────────────────────────────────────────
// Central application state. All modules read/write this object directly.

const STORAGE_VERSION = '1';
const WAIVER_VERSION  = '1.0';

const state = {
  hand: 'left',
  target: null,
  fieldElevFt: 0,
  finalHeadingDeg: null,
  manualHeading: false,
  jumpRunHdgDeg: null,
  manualJumpRun: false,
  manualJrOffset: false,
  winds: [],
  surfaceWind: null,
  pattern: null,
  forecastOffset: 0,
  layers: { jumpRun: true, exitRegion: true, canopyRegions: true, turnAltLabels: true, legDistances: true, legHeadings: true, legArrows: true, legend: true },
  driftThresh: 5,  // degrees — show steered heading line when crab/drift exceeds this
  fitDone: false,
  // Per-leg modes: 'crab' | 'drift'
  legModes: { dw: 'crab', b: 'drift', f: 'crab' },
  zPattern: false,  // Z pattern is independent of crab/drift
  // Per-leg custom canopy performance
  legCustomPerf: { dw: false, b: false, f: false },
};

// Input IDs that are persisted to localStorage on every change
const PERSIST_INPUTS = [
  'alt-enter', 'alt-base', 'alt-final',
  'alt-exit', 'alt-open', 'ff-speed',
  'jr-airspeed', 'exit-sep', 'safety-margin',
  'glide', 'canopy-speed', 'drift-thresh',
];
