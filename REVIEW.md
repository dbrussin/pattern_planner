# Codebase Review — Pattern Planner

**Date**: 2026-03-31
**Scope**: Full codebase review covering HTML, CSS, JavaScript (11 files), and CLAUDE.md

---

## Executive Summary

The Pattern Planner is a well-structured skydiving pattern planning tool that runs entirely client-side with no build step. The architecture is clean, the help text is comprehensive, and the domain logic is sound. The main improvement areas are: **inline style extraction**, **error handling**, **CLAUDE.md enhancements** (to reduce AI cost), **input validation**, and **performance optimizations**.

---

## 1. Architecture & Organization

**Strengths:**
- Clean file separation by concern (config, state, storage, geometry, wind, calculate, draw, ui, search, app)
- Single `state` object is easy to reason about
- No build step needed — works from `file://`
- CSS custom properties enable consistent theming

**Issues:**
- **~250 inline style declarations** in `dz-pattern.html`, primarily in the waiver modal, forecast controls, heading bar, and help overlay. These should be extracted to `css/app.css` as named classes
- `ui.js` is the largest file and mixes heading logic, canopy calculations, leg rendering, overlay toggles, and jump run controls — consider splitting into `ui-legs.js`, `ui-canopy.js`, `ui-overlays.js`
- No consistent JSDoc across files — `geometry.js` is best documented, `storage.js` and `ui.js` are weakest

---

## 2. Bugs & Edge Cases

### Critical

| Issue | File | Lines | Description |
|-------|------|-------|-------------|
| Silent elevation failure | wind.js | 22-23 | If elevation API fails, defaults to 0 ft — all AGL calculations become wrong with no warning |
| NaN stored in wind state | wind.js | 304 | `parseFloat(val)` on non-numeric input stores NaN, breaking downstream calculations |
| Pull-to-refresh hangs | app.js | 137-142 | No `.catch()` on `fetchWinds(true)` — UI stays in "Refreshing" state on network error |
| Null DOM crashes | ui.js | 302-309 | `updateCanopyCalc()` accesses element `.value` without null checks |
| Crab mode silent fallback | calculate.js | 129-141 | When discriminant < 0, silently uses still-air glide instead of warning user |

### Moderate

| Issue | File | Description |
|-------|------|-------------|
| DZ list fetch failure | search.js:11-38 | On network failure, `dzList` becomes `[]` but UI shows "Loading drop zones..." forever (checks for `null`) |
| Forecast offset unbounded | wind.js:114 | `state.forecastOffset` could be negative or exceed available hours |
| Race condition | wind.js:42-50 | Concurrent `fetchWinds()` calls could return stale data despite AbortController |
| Memory leaks | ui.js:481, 834-840 | `renderLegs()` clears innerHTML but orphans event listeners attached in app.js |
| Keyboard nav broken | search.js:99-131 | After geocoding re-populates dropdown, `dzIdx` resets and arrow keys don't navigate |

---

## 3. Error Handling

The codebase has a pattern of **silent catch blocks** that hide failures from users:

```javascript
// Typical pattern (storage.js, search.js, wind.js):
try { ... } catch(e) { /* silent */ }
```

**Recommendations:**
1. **Network errors**: Show specific messages — "Wind data unavailable (network error)" vs. "Wind API returned invalid data"
2. **localStorage**: Warn user when quota is exceeded instead of silently failing
3. **Input validation**: Clamp numeric inputs on change, not just via HTML `min`/`max` attributes
4. **Geolocation**: Show "Location permission denied" or "Location timeout" instead of empty callback

---

## 4. Performance

| Area | Issue | Fix |
|------|-------|-----|
| `renderLegs()` | Rebuilds all leg DOM cards on every call (add/remove/toggle) | Add/remove individual cards or use virtual DOM diffing |
| Search filtering | Runs `Array.filter()` on every keystroke over full DZ list | Debounce input by 200ms |
| `saveSettings()` | Fires on every `input` event (each keystroke) | Debounce saves by 300ms |
| `drawPattern()` | Destroys and recreates all Leaflet layers each recalculation | Diff and update only changed layers |
| `setTimeout` for layout | Uses magic 50ms/300ms delays for layout-dependent work | Use `requestAnimationFrame()` |

---

## 5. Code Quality

### Magic Numbers
Extract these to named constants in `config.js`:

```javascript
// Currently scattered across files:
200           // integratedDrift step size (ft) — calculate.js:8
6076          // feet per nautical mile — calculate.js
// 101.269 (FT_MIN_PER_KT) — now in config.js; used in calculate.js and draw.js
0.5           // minimum wind speed threshold (kt) — calculate.js:99
20 * 60 * 1000  // wind cache TTL (ms) — storage.js:10
50            // minimum AGL for wind data (ft) — wind.js:160
69            // statute miles per degree latitude — geometry.js:27
```

### Duplicate Logic
- Canopy calculation (any-2-compute-3rd) appears twice: `updateCanopyCalc()` and `updateLegCanopyCalc()` — extract to shared function
- Input debounce pattern repeated in 3+ places — extract to `debounce()` utility
- Coordinate-to-feet conversion done differently in `geometry.js` vs `draw.js` — standardize

### Missing Documentation
- Crab mode quadratic formula (`calculate.js:129-141`) — needs physics explanation
- `tasFactor()` ISA atmosphere model (`geometry.js`) — needs reference citation
- `integratedDrift()` Riemann sum approach — explain step size choice
- localStorage key schema — document all `pp_*` keys and their formats

---

## 6. CSS & Styling

### Inline Style Extraction (High Impact)
The HTML has ~250 inline style declarations. Priority extraction targets:

1. **Waiver modal** (~60 inline declarations) → `.waiver-modal`, `.waiver-header`, `.waiver-section`, `.waiver-warning`
2. **Forecast controls** (~30 declarations) → `.forecast-ctrl`, `.forecast-btn`, `.forecast-label`
3. **Heading bar input** (~15 declarations) → `.heading-input`
4. **Help overlay paragraphs** (~20 declarations) → `.help-section`, `.help-paragraph`
5. **Jump run row** (~20 declarations) → `.jr-row`, `.jr-slider`

### CSS Consolidation
- Create `.btn-base` class for shared button properties (font-family, border-radius, cursor, transition) used by 8+ button variants
- Create `.input-field` base class for the 5+ input styling patterns
- Add `@media (prefers-reduced-motion: reduce)` to respect accessibility preferences

### Responsiveness Gaps
- No explicit `@media` breakpoints — relies on `min()` which is good but insufficient for landscape phones
- Touch targets are generally good (42x42px) but layer toggle buttons have no minimum height
- No `@media (orientation: landscape)` rules for reduced vertical space

---

## 7. Accessibility

| Issue | Severity | Fix |
|-------|----------|-----|
| Interactive `<div>`s without `role="button"` | High | Add `role="button"` and `tabindex="0"` to clickable divs (search icon, icon bar, layer toggles, zoom controls) |
| Waiver modal lacks `role="dialog"` | High | Add `role="dialog"` and `aria-modal="true"` |
| No `aria-label` on icon-only buttons | Medium | Add labels: `aria-label="Toggle labels"` etc. |
| No focus management on overlay open/close | Medium | Trap focus inside open overlays |
| Range inputs lack `aria-valuenow` | Low | Bind dynamically on change |
| No `prefers-reduced-motion` support | Low | Wrap transitions in media query |

---

## 8. Help Text Assessment

**Verdict: Excellent.** The help overlay is comprehensive, covering:
- Getting started, final heading, pattern legs, additional legs
- Canopy performance (glide ratio, speed, sink rate)
- Safety regions (canopy drift, opening, exit)
- Jump run (offset, green/red lights, separation)
- Winds aloft (data source, forecast slider, interpolation)
- Display options, settings persistence, disclaimer

**Suggested improvements:**
1. Add a **glossary section** for skydiving terminology (crab, drift, Z-pattern, DW/base/final) — helps non-skydivers contributing to code
2. Add **context-sensitive help** (small `?` icons next to complex inputs that show tooltips)
3. Split the long help panel into **tabbed sections** for easier navigation
4. Add **visual examples** — even simple ASCII diagrams of left-hand vs right-hand patterns would help

---

## 9. Security

- **Low risk overall** — no user authentication, no server, no database
- **localStorage data not validated on restore** — a user could craft malicious localStorage values that cause NaN propagation or logic errors. Add schema validation in `loadSettings()`
- **Nominatim API calls** encode user input correctly via `encodeURIComponent()`
- **No CSP headers** — not applicable for `file://` but worth adding if ever served via HTTP
- **XSS**: DOM manipulation uses `textContent` for user input (safe) but Leaflet `divIcon` HTML is built from computed values — low risk since values are numeric

---

## 10. Recommendations to Lower Claude Code Cost

These changes reduce the tokens Claude needs to read/understand the codebase:

### 10a. Enhance CLAUDE.md (Highest Impact)

Every time Claude Code works on this project, it reads CLAUDE.md. A more detailed file means less exploratory file reading. Add these sections:

**CSS & Styling Guide:**
- List of CSS custom properties and their purposes
- Note that ~250 inline styles exist in the HTML (so Claude doesn't "discover" and re-report this)
- Naming conventions for classes

**localStorage Schema:**
- All `pp_*` keys, their types, and valid values
- Cache key format: `pp_wc_{lat.toFixed(2)},{lng.toFixed(2)}`
- Version migration strategy

**Common Modification Recipes:**
- "To add a new setting": which files to touch, in what order
- "To add a new map layer": where to register, how to wire toggle
- "To add a new pattern leg type": state, calculate, draw, ui touchpoints
- "To change an API endpoint": config.js + wind.js + relevant cache keys

**State Object Shape:**
- Document every field in `state` with type and valid values
- Mark which fields are persisted vs. ephemeral

**Known Issues / Technical Debt:**
- List the inline styles problem so Claude doesn't re-discover it
- Note the duplicated canopy calc logic
- Note the magic numbers that need extraction
- Document the initialization order dependency

**Domain Glossary:**
- Crab vs. drift mode
- Pattern legs (downwind, base, final)
- Z-pattern
- AGL vs MSL
- TAS vs IAS
- GFS (Global Forecast System)

### 10b. Add JSDoc to Key Functions

JSDoc lets Claude understand function contracts without reading implementations:

```javascript
/**
 * Compute integrated wind drift during descent through an altitude band.
 * @param {number} topAgl - Top of band (ft AGL)
 * @param {number} botAgl - Bottom of band (ft AGL)
 * @param {number} descentRate - Vertical speed (ft/min, positive down)
 * @returns {{dN: number, dE: number}} Drift in feet (north, east)
 */
function integratedDrift(topAgl, botAgl, descentRate) { ... }
```

Priority functions for JSDoc: `integratedDrift`, `avgWindInBand`, `calculate`, `tasFactor`, `interpolateWind`, `processWindData`, `drawPattern`, `placeTarget`, `loadSettings`, `saveSettings`.

### 10c. Extract Inline Styles to CSS

The 250 inline styles force Claude to parse dense HTML on every read. Moving them to `app.css` with named classes makes the HTML readable at a glance and reduces tokens per file read.

### 10d. Split ui.js

At ~920 lines, `ui.js` is the largest file. Claude must read all of it even when only working on one feature. Split into:
- `js/ui-overlays.js` — `toggleOverlay()`, `toggleSearch()`, layer toggles
- `js/ui-legs.js` — `renderLegs()`, `addExtraLeg()`, `removeExtraLeg()`, leg mode/alt handlers
- `js/ui-canopy.js` — `updateCanopyCalc()`, `updateLegCanopyCalc()`, `getLegPerf()`
- `js/ui-heading.js` — heading bar, slider, jump run heading controls

### 10e. Add Type Annotations via JSDoc

Even without TypeScript, `@typedef` and `@param` annotations let Claude infer types without tracing through code:

```javascript
/** @typedef {{lat: number, lng: number}} LatLng */
/** @typedef {{dir: number, speed: number}} Wind */
/** @typedef {{dN: number, dE: number}} Displacement */
```

---

## Priority Summary

| Priority | Action | Impact |
|----------|--------|--------|
| 1 | Enhance CLAUDE.md with sections listed in 10a | Reduces Claude cost ~30-40% per session |
| 2 | Add JSDoc to top 10 functions | Reduces code exploration time |
| 3 | Fix critical bugs (elevation fallback, NaN storage, pull-to-refresh hang) | Correctness |
| 4 | Extract inline styles to CSS | Reduces HTML token count, improves maintainability |
| 5 | Split ui.js into 4 focused files | Reduces per-task file reads |
| 6 | Add error handling to network calls | User experience |
| 7 | Extract magic numbers to config.js | Maintainability |
| 8 | Add accessibility attributes | Compliance, usability |
| 9 | Performance optimizations (debounce, incremental DOM) | Responsiveness |
| 10 | CSS consolidation and responsive breakpoints | Mobile experience |
