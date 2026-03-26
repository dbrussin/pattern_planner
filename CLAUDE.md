# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

Open `dz-pattern.html` directly in any modern web browser — no build step or install required. All code is self-contained in that single file.

## Architecture

The entire application lives in `dz-pattern.html` (~2500 lines), structured as:

- **Lines 1–266**: Embedded CSS
- **Lines 267–728**: HTML (header, map container, overlays, UI panels)
- **Lines 729–2505**: Embedded JavaScript

### State Management

A single `state` object (line ~732) holds all application state: navigation settings, wind data, canopy performance, pattern altitudes, map layer visibility, and localStorage-backed caches.

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

| Area | Functions |
|------|-----------|
| Wind fetching & processing | `fetchWinds()`, `processWindData()`, `interpolateWind()`, `buildWindTable()` |
| Pattern calculation | `calculate()` — computes crab/drift headings and turn points for all legs |
| Canopy performance | Per-leg glide ratio / airspeed / sink rate (any 2 compute the 3rd) |
| Map drawing | Leaflet polylines for pattern legs, exit circle, jump run overlay |
| UI / overlays | `toggleOverlay()`, `placeTarget()`, `onHeadingSlider()`, `toggleSearch()` |
| Persistence | All settings read/written via `localStorage`; wind cache has 20-min TTL |
