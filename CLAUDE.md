# CLAUDE.md

Guidance for Claude Code working on Pattern Planner — a skydiving landing pattern visualization tool.

## Running the App

Open `dz-pattern.html` in any modern browser. No build step, no server — works via `file://`.

## Architecture

Single-page app: one HTML shell, one CSS file, 12 JS files loaded as classic `<script>` tags (no ES modules — blocked by CORS on `file://`). All functions live in `window` scope; cross-file calls are safe because they happen at runtime after all scripts load.

### File Map

```
dz-pattern.html      — HTML shell (~485 lines); no inline style attributes
css/app.css          — all styles; CSS custom properties for theming
js/config.js         — constants (R_FT, FT_PER_NM, etc.), LEG_DEFS, EXTRA_LEG_COLORS, debounce(), @typedef annotations
js/state.js          — global `state` object, PERSIST_INPUTS list, STORAGE_VERSION, WAIVER_VERSION
js/storage.js        — localStorage persistence (save/load/reset), wind cache, storageKey() helper
js/geometry.js       — spherical math (offsetLL, hdgVec, windVec), wind/temp interpolation, magDeclination(), tasFactor()
js/wind.js           — fetchElevation(), fetchWinds(), processWindData(), buildWindTable(), auto-refresh
js/calculate.js      — integratedDrift(), avgWindInBand(), calculate() (mode dispatcher), calculateCanopyPattern(), calculateFreefallPlan() (stub)
js/draw.js           — drawPattern() (mode dispatcher), drawCanopyPattern(), drawFreefallPlan() (stub), clearPattern(), Leaflet polyline/marker/label/zone helpers
js/ui-overlays.js    — setStatus(), toggleOverlay(), closeOverlay(), toggleLayer(), toggleMode(), setHand(), showLegend()
js/ui-heading.js     — heading bar, forecast offset, jump run heading, green/red light, DZ zero, landing lat/lng, mag declination
js/ui-canopy.js      — canopyThird(), updateCanopyCalc(), updateLegCanopyCalc(), getLegPerf(), setLegMode(), toggleZPattern()
js/ui-legs.js        — renderLegs() (uses shared _legHeader/_legAltField/_legPerfBlock helpers + .leg-* CSS classes), addExtraLeg(), removeExtraLeg(), leg alt/hdg handlers, heading overrides, altitude constraints
js/search.js         — DZ search (USPA GeoJSON + Nominatim geocoding), goToMyLocation()
js/app.js            — map init, placeTarget(), tile failover, invite code gate, waiver, pull-to-refresh, init sequence
```

### Script Load Order (must be preserved)

1. Leaflet CDN → 2. config → 3. state → 4. storage → 5. geometry → 6. wind → 7. calculate → 8. draw → 9. ui-overlays → 10. ui-heading → 11. ui-canopy → 12. ui-legs (calls `renderLegs()` at load) → 13. search (IIFE fetches DZ list) → 14. app (runs `initStorage()`, `loadSettings()`, attaches listeners)

### Mode System

The app supports multiple **independent** pattern modes — both can be on simultaneously, or either off. Sub-mode distinctions (e.g. movement planner) live as options nested inside their parent mode.

- **`state.modes.canopy`** (default on) — single-canopy landing pattern. Future: flocking / HAHO multi-canopy.
- **`state.modes.freefall`** (default off) — jump run planner, group spacing, movement planner. Currently a stub.

UX toggles live in the **Layers overlay** (`#overlay-labels`) under "Pattern Modes" — `mode-canopy`, `mode-freefall` buttons wired to `toggleMode(name)` in `js/ui-overlays.js`.

`calculate()` and `drawPattern()` are thin **additive dispatchers**: each runs every enabled mode's solver/renderer in sequence. Each mode owns its own state slot:

| Mode     | Solver                       | Renderer                | State slot       |
|----------|------------------------------|-------------------------|------------------|
| canopy   | `calculateCanopyPattern()`   | `drawCanopyPattern()`   | `state.pattern`  |
| freefall | `calculateFreefallPlan()`    | `drawFreefallPlan()`    | `state.freefall` |

To add a new mode: register a key in `state.modes`, add a row in the Layers overlay HTML, implement the solver and renderer, and dispatch to them from `calculate()` and `drawPattern()`.

### State

A single `state` object in `js/state.js` holds all app state, grouped into:

- **Mode toggles**: `modes.canopy`, `modes.freefall` (persisted)
- **Shared / mode-agnostic**: `target`, `winds`, `surfaceWind`, `forecastOffset`, `fieldElevFt`, `fitDone`, `driftThresh`, `layers`
- **Canopy result + canopy-mode state**: `pattern` (result), `hand`, `finalHeadingDeg`, `manualHeading`, `legModes`, `zPattern`, `legCustomPerf`, `extraLegs`, `nextExtraLegIdx`, `legHdgOverride`
- **Jump run** (currently emitted by canopy calc; freefall jump-run planner will write to the same fields): `jumpRunHdgDeg`, `manualJumpRun`, `manualJrOffset`, `manualGreenLight`, `manualRedLight`, `manualDzZero`
- **Freefall result** (placeholder): `freefall`

Settings persist to `localStorage` with `pp_` prefix via `storageKey()`. Wind data cached with 20-min TTL keyed by `lat.toFixed(2),lng.toFixed(2)`. `initStorage()` wipes all `pp_*` keys on `STORAGE_VERSION` mismatch (preserving `pp_waiver_version` and `pp_invite_verified`).

### Data Flow

1. Invite code gate → waiver agreement → `loadSettings()` restores persisted state (incl. mode toggles)
2. User taps map → `placeTarget()` → `fetchElevation()` → `fetchWinds()` (GFS via Open-Meteo)
3. `processWindData()` builds wind table at 1k ft intervals from surface to 14k AGL
4. `calculate()` dispatches to each enabled mode's solver; each writes its own state slot
5. `drawPattern()` dispatches to each enabled mode's renderer; clears layers once at the top

### External Dependencies (all CDN/API)

- **Leaflet.js 1.9.4** — map rendering
- **Open-Meteo API** — GFS wind/temp data and elevation
- **Nominatim (OSM)** — location search
- **USPA GeoJSON** (GitHub) — drop zone database (30-day cache)
- **Map tiles** — Google Satellite (primary), ArcGIS, OSM (failover chain)

## Common Modification Recipes

### Adding a new persisted setting
1. Add `<input>` with unique `id` to `dz-pattern.html`
2. Add the `id` to `PERSIST_INPUTS` in `js/state.js`
3. Read via `document.getElementById(id).value` in `calculate()` or wherever needed
4. `saveSettings()` / `loadSettings()` handle it automatically

### Adding a new map layer toggle
1. Add `<div class="layer-toggle" ...>` row in Layers section of HTML
2. Add layer key to `state.layers` in `js/state.js`
3. Wrap drawing code in `if (state.layers.yourKey)` in `draw.js`
4. Wire button `onclick` to `toggleLayer('yourKey')`

### Adding a new pattern leg type
1. Add entry to `LEG_DEFS` in `js/config.js`
2. `renderLegs()` in `ui-legs.js` auto-generates the UI card
3. Add calculation logic in `calculate.js`
4. Add drawing logic in `draw.js`

### Adding a new top-level mode
1. Add key to `state.modes` in `js/state.js` (default off for new modes)
2. Add a `<div class="layer-row">` row under "Pattern Modes" in the Layers overlay (`#overlay-labels` in `dz-pattern.html`); button id `mode-<key>`, `onclick="toggleMode('<key>')"`
3. Implement `calculate<Mode>()` solver and `draw<Mode>()` renderer; dispatch to them from `calculate()` (in `calculate.js`) and `drawPattern()` (in `draw.js`)
4. Add a state slot for the mode's result (e.g. `state.<mode>`) and clear it when the mode is off
5. Bump `STORAGE_VERSION` in `config.js` if the persisted shape changes

### Changing an API endpoint
1. Update URL in the fetch function (`wind.js` for Open-Meteo, `search.js` for Nominatim)
2. Update response parsing if format changed
3. Clear wind cache if schema changed (`pp_wc_*` keys)

## Token-Efficiency Guidance (for Claude Code)

Claude Code has a 10,000-token per-Read limit. Keep each source file comfortably under that budget:

- **No single file should exceed ~8,000 tokens** (~32 KB of code). Files currently at risk if extended: `dz-pattern.html`, `css/app.css`, `js/draw.js`, `js/calculate.js`, `js/ui-legs.js`, `js/wind.js`.
- **Prefer CSS classes over inline styles** in JS template literals. `renderLegs()` uses `.leg-card`, `.leg-header`, `.leg-field`, `.leg-num`, `.leg-perf` etc. from `css/app.css` — add a new class rather than inlining a `style="..."` attribute.
- **Prefer shared helpers over duplication.** In `renderLegs()` the fragment builders `_legHeader()`, `_legAltField()`, `_legPerfBlock()` are reused across standard and extra legs. Put new shared markup in helpers.
- **Keep comments terse.** A one-line hint that names the algorithm ("fixed-point iteration on turn-consumed altitudes") is more useful than 15 lines re-explaining it. Skip JSDoc prose on private helpers.
- **Shared CSS classes** for repeat patterns: `.pyramid` / `.pyramid-hit` (heading-bar, JR, final-hdg wind indicators); `.muted-input` (optional number inputs that start greyed out); `.is-hidden` (generic display:none modifier).
- If a file creeps past ~8k tokens, **split it** (like the old `ui.js` → `ui-overlays.js`, `ui-heading.js`, `ui-canopy.js`, `ui-legs.js`) rather than compacting aggressively.

## Known Technical Debt

- **Inline styles in draw.js**: Leaflet `divIcon` HTML contains inline styles (hard to avoid with Leaflet's API)
- **Silent error handling**: Some `try/catch` blocks swallow errors (e.g. `initStorage()`, `loadSettings()` outer catch)
- **No JS input validation**: Numeric inputs rely on HTML `min`/`max` only; no JS clamping
- **renderLegs() rebuilds all DOM**: Clears `innerHTML` each time instead of updating individual cards
- **Memory leaks**: Event listeners orphaned when `renderLegs()` clears `innerHTML`
- **Keyboard navigation**: After geocoding repopulates dropdown, `dzIdx` resets

### Resolved (do not re-report)
- ~~Magic numbers~~: All in `config.js`
- ~~Duplicated canopy calc~~: Shared `canopyThird()` in `ui-canopy.js`
- ~~NaN propagation~~: `updateWindByIdx()` rejects non-numeric input
- ~~Inline styles in `renderLegs()`~~: Replaced with `.leg-*` classes in `css/app.css`
- ~~Duplicate pyramid CSS~~: Consolidated into shared `.pyramid` / `.pyramid-hit` classes
- ~~Orphan `js/ui.js`~~: Deleted (functionality lives in `ui-overlays.js` / `ui-heading.js` / `ui-canopy.js` / `ui-legs.js`)

## CSS Notes

- All styles in `css/app.css`; organized by `/* ── SECTION ── */` comments
- Custom properties on `:root`: `--bg`, `--panel`, `--panel2`, `--border`, `--accent` (yellow), `--accent2` (teal), `--accent-alt` (green, altitude sliders), `--text`, `--muted`, leg colors (`--final-color`, `--base-color`, `--downwind-color`), layout sizes (`--header-h`, `--heading-bar-h`, `--icon-bar-w`)
- No `@media` breakpoints; uses `min()` for responsive widths; `@media (prefers-reduced-motion)` disables transitions
- **Leg-card classes** (used by `renderLegs()` in `ui-legs.js`): `.leg-card`, `.leg-header`, `.leg-color-dot`, `.leg-title`, `.leg-mode-group`, `.leg-mode-btn`, `.leg-field`, `.leg-field-label`, `.leg-slider-row`, `.leg-num`, `.leg-num--hdg`, `.leg-opt-row`, `.leg-opt-label`, `.leg-opt-row--disabled`, `.leg-perf`, `.leg-perf--open`, `.leg-perf-note`, `.leg-final-hdg-wrap`, `.leg-reset-btn`
- **Shared utilities**: `.pyramid` / `.pyramid-hit` (wind-direction indicator on range sliders), `.muted-input` (optional input displayed in muted color until typed into), `.is-hidden` (generic display:none)

## Domain Glossary

| Term | Meaning |
|------|---------|
| **AGL / MSL** | Above Ground Level / Mean Sea Level |
| **TAS / IAS** | True Airspeed / Indicated Airspeed — TAS increases with altitude |
| **GFS** | Global Forecast System (NOAA weather model via Open-Meteo) |
| **Crab mode** | Canopy points into wind to maintain ground track (heading ≠ track) |
| **Drift mode** | Canopy points along track, wind pushes it sideways |
| **Z-pattern** | Downwind leg flies same direction as final (non-standard) |
| **DW / Base / Final** | Three standard pattern legs before landing |
| **Jump run** | Aircraft flight path over DZ during exit |
| **Green/Red light** | Points on jump run where exit is allowed/prohibited |
| **Glide ratio** | Horizontal distance / vertical distance (e.g. 2.5:1) |
