# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

Open `dz-pattern.html` directly in any modern web browser — no build step or install required. Works via `file://` protocol; no server needed.

## Architecture

The application is split across multiple files:

```
dz-pattern.html      — slim HTML shell (~485 lines); has ~250 inline style attrs (known debt)
css/app.css          — all styles; uses CSS custom properties for theming
js/config.js         — physical constants, API config, LEG_DEFS, EXTRA_LEG_COLORS, @typedef annotations
js/state.js          — global `state` object, PERSIST_INPUTS list, STORAGE_VERSION
js/storage.js        — localStorage persistence, wind cache, loadSettings()/saveSettings()
js/geometry.js       — spherical math, wind interpolation, TAS factor (ISA model)
js/wind.js           — fetchElevation(), fetchWinds(), processWindData(), buildWindTable()
js/calculate.js      — integratedDrift(), avgWindInBand(), calculate()
js/draw.js           — drawPattern() and all Leaflet polyline/marker helpers
js/ui-overlays.js    — setStatus(), toggleOverlay(), toggleLayer(), setHand(), showLegend()
js/ui-heading.js     — heading bar, forecast offset controls, jump run heading controls
js/ui-canopy.js      — updateCanopyCalc(), updateLegCanopyCalc(), getLegPerf(), setLegMode()
js/ui-legs.js        — renderLegs(), addExtraLeg(), removeExtraLeg(), leg alt/hdg handlers
js/search.js         — DZ search, Nominatim geocoding, goToMyLocation()
js/app.js            — map init, placeTarget(), waiver, init sequence
```

### Script Load Order

Scripts are loaded in this order at the bottom of `<body>` — order matters:

1. Leaflet CDN
2. `js/config.js`
3. `js/state.js`
4. `js/storage.js`
5. `js/geometry.js`
6. `js/wind.js`
7. `js/calculate.js`
8. `js/draw.js`
9. `js/ui-overlays.js` — overlay/layer/hand toggles, status pill
10. `js/ui-heading.js` — heading bar, forecast controls, jump run heading
11. `js/ui-canopy.js` — canopy calc, leg mode toggles; defines `legLastEdited`
12. `js/ui-legs.js` — leg card rendering; calls `renderLegs()` at load time
13. `js/search.js` — IIFE fetches USPA DZ list on load
14. `js/app.js` — runs `initStorage()`, `loadSettings()`, attaches event listeners

### Global Scope

All functions are in `window` scope (classic `<script>` tags, no ES modules). ES modules are intentionally avoided — they are blocked by CORS on `file://` URLs. Cross-file calls (e.g. `calculate()` → `drawPattern()`, `wind.js` → `calculate()`) are safe because they occur inside function bodies at runtime, after all scripts have loaded.

### State Management

A single `state` object (in `js/state.js`) holds all application state:

| Field | Type | Persisted | Description |
|-------|------|-----------|-------------|
| `hand` | `'left'\|'right'` | Yes | Pattern hand (left/right traffic) |
| `target` | `{lat, lng}\|null` | No | Landing target coordinates |
| `fieldElevFt` | `number` | Cached | Field elevation (ft MSL) |
| `finalHeadingDeg` | `number\|null` | Yes | Final approach heading (0-359) |
| `manualHeading` | `boolean` | Yes | Whether heading was manually set |
| `jumpRunHdgDeg` | `number\|null` | Yes | Jump run heading override |
| `manualJumpRun` | `boolean` | Yes | Whether jump run heading was manually set |
| `manualJrOffset` | `boolean` | Yes | Whether jump run offset was manually set |
| `winds` | `Array<{altFt, dirTrue, speedKt, tempC}>` | Cached | Wind data at altitude levels |
| `surfaceWind` | `{dir, speed}\|null` | No | Surface wind (lowest level) |
| `pattern` | `object\|null` | No | Computed pattern result (from `calculate()`) |
| `forecastOffset` | `number` | No | Hours offset for forecast slider (0-12) |
| `layers` | `object` | Yes | Map layer visibility flags |
| `driftThresh` | `number` | Yes | Degrees — show steered heading when crab/drift exceeds this |
| `legModes` | `object` | Yes | Per-leg `'crab'\|'drift'` keyed by leg key |
| `zPattern` | `boolean` | Yes | Z-pattern toggle |
| `legCustomPerf` | `object` | Yes | Per-leg custom canopy performance enabled |
| `extraLegs` | `Array<{id, defaultAlt, color}>` | Yes | Dynamically added legs above downwind |
| `legHdgOverride` | `object` | Yes | Per-leg heading overrides (null = auto) |

Settings are persisted to `localStorage` with prefix `pp_` and a version key (`pp_v`) to handle breaking changes. Wind and elevation data are cached with a 20-minute TTL using key format `pp_wc_{lat.toFixed(2)},{lng.toFixed(2)}`.

### localStorage Schema

All keys use the `pp_` prefix (via `storageKey(k)` helper in `storage.js`). A version mismatch in `pp_storage_version` wipes all `pp_` keys except `pp_waiver_version`.

| Key | Type | Description |
|-----|------|-------------|
| `pp_storage_version` | string | Storage schema version — wipes all settings on mismatch |
| `pp_waiver_version` | string | Waiver agreement version — preserved across storage resets |
| `pp_hand` | `'left'\|'right'` | Pattern hand (L/R traffic) |
| `pp_layers` | JSON object | Layer visibility flags (keys match `state.layers`) |
| `pp_leg_modes` | JSON object | Per-leg crab/drift mode (keys: `dw`, `b`, `f`, extra leg ids) |
| `pp_leg_custom` | JSON object | Per-leg custom performance enabled flags |
| `pp_z_pattern` | `'true'\|'false'` | Z-pattern toggle state |
| `pp_extra_legs` | JSON array | Extra leg metadata: `[{id, color, alt, hdg}]` |
| `pp_next_xl_idx` | string (number) | Counter for generating unique extra leg IDs |
| `pp_leg_hdg_override` | JSON object | Per-leg heading overrides (`null` = auto) |
| `pp_dz_list` | JSON `{list, ts}` | Cached USPA DZ list (30-day TTL) |
| `pp_wind_cache` | JSON object | Wind cache keyed by `lat,lng` grid (20-min TTL) |
| `pp_{id}` | string (number) | One entry per id in `PERSIST_INPUTS` (alt, canopy, jump run params) |
| `pp_{leg}_{field}` | string (number) | Per-leg canopy perf: `pp_dw_glide`, `pp_b_speed`, `pp_f_sink`, etc. |

**Cache key format**: `pp_wc_{lat.toFixed(2)},{lng.toFixed(2)}` — ~1.1 km grid cells.

**Version migration**: `initStorage()` in `storage.js` compares `pp_storage_version` to `STORAGE_VERSION` constant; on mismatch it wipes all `pp_*` keys (preserving `pp_waiver_version`) and writes the new version.

### Data Flow

1. User places a landing target on the Leaflet map
2. `fetchElevation()` retrieves field elevation from Open-Meteo
3. `fetchWinds()` pulls GFS wind data for 14 altitude levels (1,000–14,000 ft AGL)
4. `processWindData()` interpolates wind vectors for pattern altitudes
5. `calculate()` computes wind-adjusted headings, turn points, and distances for each pattern leg
6. Results are drawn as Leaflet polylines (downwind=orange, base=cyan, final=yellow)

### External Dependencies (all CDN/API, no install needed)

- **Leaflet.js 1.9.4** — interactive map rendering
- **Open-Meteo API** — GFS wind/temperature data and elevation
- **Nominatim (OpenStreetMap)** — drop zone name search
- **USPA GeoJSON** (GitHub raw) — pre-loaded drop zone locations
- **Map tiles** — Google Satellite, OpenStreetMap, ArcGIS World Imagery

### Key Function Groups

| Area | File | Functions |
|------|------|-----------|
| Wind fetching & processing | `wind.js` | `fetchWinds()`, `processWindData()`, `interpolateWind()`, `buildWindTable()` |
| Pattern calculation | `calculate.js` | `calculate()`, `integratedDrift()`, `avgWindInBand()` |
| Canopy performance | `ui-canopy.js` | `updateCanopyCalc()`, `updateLegCanopyCalc()`, `getLegPerf()` |
| Leg mode toggles | `ui-canopy.js` | `setLegMode()`, `toggleZPattern()`, `updatePerfSections()` |
| Map drawing | `draw.js` | Leaflet polylines for pattern legs, exit circle, jump run overlay |
| UI overlays & layers | `ui-overlays.js` | `toggleOverlay()`, `closeOverlay()`, `toggleLayer()`, `setHand()`, `setStatus()` |
| Heading & jump run controls | `ui-heading.js` | `onHeadingSlider()`, `updateWindPyramid()`, `autoSetJumpRunHeading()` |
| Leg card rendering | `ui-legs.js` | `renderLegs()`, `addExtraLeg()`, `removeExtraLeg()`, `onLegAlt()` |
| Orchestration | `app.js` | `placeTarget()`, map init, waiver, init sequence |
| Persistence | `storage.js` | All settings read/written via `localStorage`; wind cache has 20-min TTL |

## CSS Architecture

- All styles in `css/app.css`, organized by component with `/* ── SECTION ── */` comments
- **Known debt**: ~250 inline style declarations remain in `dz-pattern.html` (waiver modal, forecast controls, heading bar, help overlay). These should be extracted to named CSS classes.
- Button variants: `.zoom-btn`, `.map-icon-btn`, `.fetch-btn`, `.add-leg-btn`, `.leg-remove-btn`, `.leg-mode-btn` — share font-family/border-radius/cursor/transition but not yet consolidated to a base class
- No `@media` breakpoints — uses CSS `min()` for responsive overlay widths

### CSS Custom Properties (`:root`)

| Property | Value | Purpose |
|----------|-------|---------|
| `--bg` | `#0a0c0f` | Page background |
| `--panel` | `#12151aee` | Overlay panel background (semi-transparent) |
| `--panel2` | `#1a1e25` | Secondary panel / input background |
| `--border` | `#2a2f3a` | All borders and dividers |
| `--accent` | `#e8f44d` | Primary accent (yellow) — final leg, heading indicator |
| `--accent2` | `#4df4c8` | Secondary accent (teal) — base leg, jump run, winds |
| `--text` | `#d8dde8` | Primary text |
| `--muted` | `#5a6070` | Muted/secondary text, labels |
| `--final-color` | `#e8f44d` | Final leg polyline color |
| `--base-color` | `#4df4c8` | Base leg polyline color |
| `--downwind-color` | `#f4944d` | Downwind leg polyline color |
| `--header-h` | `48px` | Header bar height (used for map top offset) |
| `--heading-bar-h` | `52px` | Heading bar height (used for map bottom offset) |
| `--icon-bar-w` | `48px` | Icon bar width (used for overlay right offset) |

### CSS Class Naming Conventions

- Layout containers: `#header`, `#map`, `#icon-bar`, `#heading-bar`, `#zoom-bar`
- Overlay panels: `.overlay-panel`, `.overlay-header`, `.overlay-body`, `.overlay-close`
- Input groups: `.input-grid`, `.input-group` — shared across settings and leg cards
- Button families: `.zoom-btn`, `.map-icon-btn`, `.fetch-btn`, `.add-leg-btn`, `.leg-remove-btn`, `.leg-mode-btn`, `.layer-toggle`
- Wind table: `.wind-row`, `.wind-header`, `.alt-label`, `.temp-label`
- Leg details: `.leg-details`, `.leg-details-summary`, `.leg-details-arrow`, `.leg-details-body`
- Help overlay: `.help-section`, `.help-heading`
- Utility: `.field-note`, `.section-label`, `.hand-toggle`

## Common Modification Recipes

### Adding a new persisted setting
1. Add the HTML `<input>` with a unique `id` to `dz-pattern.html`
2. Add the `id` to `PERSIST_INPUTS` in `js/state.js`
3. Read it in `calculate()` or wherever needed via `document.getElementById(id).value`
4. `saveSettings()` / `loadSettings()` handle it automatically via the PERSIST_INPUTS loop

### Adding a new map layer toggle
1. Add a `<div class="layer-toggle">` row in the Layers section of `dz-pattern.html`
2. Add the layer key to `state.layers` in `js/state.js`
3. In `draw.js`, wrap the relevant drawing code in `if (state.layers.yourKey)`
4. Wire the toggle button's `onclick` to `toggleLayer('yourKey')`

### Adding a new pattern leg type
1. Add an entry to `LEG_DEFS` in `js/config.js` (key, label, color, altitude config)
2. The UI leg card is auto-generated by `renderLegs()` in `js/ui-legs.js`
3. Add calculation logic in `calculate.js` — follow the existing base/downwind pattern
4. Add drawing logic in `draw.js` — add polyline with the leg's color

### Changing an API endpoint
1. Update the URL in the relevant fetch function (`wind.js` for Open-Meteo, `search.js` for Nominatim)
2. If response format changes, update the parsing in `processWindData()` or search handler
3. Clear wind cache if schema changed: `localStorage` keys prefixed `pp_wc_`

## Known Technical Debt

- **Inline styles**: ~250 declarations in HTML should move to `css/app.css`. Priority targets: waiver modal (~60), forecast controls (~30), layers overlay (~20), jump run row (~20), help paragraphs (~20).
- **Duplicated canopy calc**: `updateCanopyCalc()` and `updateLegCanopyCalc()` share logic — could extract to a shared helper
- **Magic numbers**: Constants like `6076` (ft/nm), `101.269` (ft/min per kt), `200` (drift step ft), `0.5` (min wind speed threshold), `69` (statute miles per degree) should move to `config.js`
- **Silent error handling**: Many `try/catch` blocks silently swallow errors; network errors show generic messages
- **No input validation**: Numeric inputs rely on HTML `min`/`max` only; no JS clamping for out-of-range values
- **renderLegs() rebuilds all DOM**: Should add/remove individual cards instead of clearing innerHTML each time
- **Memory leaks**: Event listeners orphaned when `renderLegs()` clears innerHTML
- **NaN propagation**: `updateWindByIdx()` stores `parseFloat(val)` which can be NaN on non-numeric input

## Domain Glossary

| Term | Meaning |
|------|---------|
| **AGL** | Above Ground Level — altitude measured from field elevation |
| **MSL** | Mean Sea Level — absolute altitude |
| **TAS / IAS** | True Airspeed / Indicated Airspeed — TAS increases with altitude |
| **GFS** | Global Forecast System — NOAA weather model used via Open-Meteo |
| **Crab mode** | Aircraft points into wind to maintain ground track (heading ≠ track) |
| **Drift mode** | Aircraft points along track, wind pushes it sideways |
| **Z-pattern** | Downwind leg flies same direction as final (non-standard) |
| **DW / Base / Final** | The three standard pattern legs before landing |
| **Jump run** | Aircraft flight path over the DZ during exit |
| **Green/Red light** | Points on jump run where exit is allowed/prohibited |
| **Glide ratio** | Horizontal distance / vertical distance (e.g. 8:1) |
