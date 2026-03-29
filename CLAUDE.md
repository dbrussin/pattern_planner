# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

Open `dz-pattern.html` directly in any modern web browser — no build step or install required. Works via `file://` protocol; no server needed.

## Architecture

The application is split across multiple files:

```
dz-pattern.html      — slim HTML shell (~485 lines); no inline CSS or JS
css/app.css          — all styles (extracted from original <style> block)
js/config.js         — physical constants and API config
js/state.js          — global `state` object and PERSIST_INPUTS list
js/storage.js        — localStorage persistence, wind cache, loadSettings()
js/geometry.js       — spherical math, wind interpolation helpers
js/wind.js           — fetchElevation(), fetchWinds(), processWindData(), buildWindTable()
js/calculate.js      — integratedDrift(), avgWindInBand(), calculate()
js/draw.js           — drawPattern() and all Leaflet polyline/marker helpers
js/ui.js             — heading bar, leg config, canopy inputs, jump run controls, toggleLayer()
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
9. `js/ui.js`
10. `js/search.js`
11. `js/app.js`

### Global Scope

All functions are in `window` scope (classic `<script>` tags, no ES modules). ES modules are intentionally avoided — they are blocked by CORS on `file://` URLs. Cross-file calls (e.g. `calculate()` → `drawPattern()`, `wind.js` → `calculate()`) are safe because they occur inside function bodies at runtime, after all scripts have loaded.

### State Management

A single `state` object (in `js/state.js`) holds all application state: navigation settings, wind data, canopy performance, pattern altitudes, map layer visibility, and localStorage-backed caches.

Settings are persisted to `localStorage` with a version key to handle breaking changes. Wind and elevation data are cached with a 20-minute TTL.

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
| Canopy performance | `ui.js` | Per-leg glide ratio / airspeed / sink rate (any 2 compute the 3rd) |
| Map drawing | `draw.js` | Leaflet polylines for pattern legs, exit circle, jump run overlay |
| UI / overlays | `ui.js` | `toggleOverlay()`, `onHeadingSlider()`, `toggleSearch()` |
| Orchestration | `app.js` | `placeTarget()`, map init, waiver, init sequence |
| Persistence | `storage.js` | All settings read/written via `localStorage`; wind cache has 20-min TTL |
