// ─── WIND ──────────────────────────────────────────────────────────────────────
// Wind and elevation fetching, processing, and table display.
// Depends on: config, state, geometry (interpObj, _sortedWindsCache), storage

// Geopotential height conversion: 1 gpm ≈ 1 m MSL for practical purposes
// (true geopotential height differs from geometric by <0.3% below 30,000ft)
function geopotentialToFtMSL(gpm) { return Math.round(gpm * 3.28084); }

let _fetchInProgress      = false;
let _fetchAbortController = null;

// ── Elevation fetch ───────────────────────────────────────────────────────────

async function fetchElevation(lat, lng) {
  // Check if wind cache already has elevation for this location
  const cached = findCachedWinds(lat, lng);
  if (cached?.fieldElevFt != null) {
    state.fieldElevFt = cached.fieldElevFt;
    return;
  }
  try {
    const d = await (await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`)).json();
    if (d.elevation?.[0] != null) state.fieldElevFt = Math.round(d.elevation[0] * 3.28084);
    else setStatus('Elevation unavailable — AGL altitudes may be inaccurate');
  } catch(e) {
    console.warn('Elevation fetch failed', e);
    setStatus('Elevation unavailable — AGL altitudes may be inaccurate');
  }
}

// ── Wind fetch ────────────────────────────────────────────────────────────────

async function fetchWinds(forceRefresh = false) {
  if (!state.target) return;
  if (_fetchInProgress) {
    // Cancel the previous request and allow the new one to proceed
    _fetchAbortController?.abort();
    _fetchInProgress = false;
  }

  // Check cache — key-only lookup, no distance check needed
  if (!forceRefresh) {
    const cached = findCachedWinds(state.target.lat, state.target.lng);
    if (cached) {
      if (cached.fieldElevFt != null) state.fieldElevFt = cached.fieldElevFt;
      processWindData(cached.rawData, cached.fieldElevFt);
      updateWindStatusAge(cached.ts);
      setStatus(`Winds from cache · SFC ${state.surfaceWind?.dirDeg ?? '?'}°@${state.surfaceWind?.speedKts ?? '?'}kt`);
      fetchMetar(state.target.lat, state.target.lng);
      return;
    }
  }

  const btn = document.getElementById('fetch-btn');
  _fetchInProgress      = true;
  _fetchAbortController = new AbortController();
  const signal          = _fetchAbortController.signal;
  btn.disabled = true; btn.textContent = '⏳ Fetching…';

  try {
    const {lat, lng} = state.target;
    const plWindVars = PRESSURE_LEVELS.flatMap(p => [`windspeed_${p}hPa`, `winddirection_${p}hPa`]).join(',');
    const plHgtVars  = PRESSURE_LEVELS.map(p  => `geopotential_height_${p}hPa`).join(',');
    const plTmpVars  = PRESSURE_LEVELS.map(p  => `temperature_${p}hPa`).join(',');
    const htVars     = HEIGHT_LEVELS.flatMap(h => [`windspeed_${h}m`, `winddirection_${h}m`]).join(',');

    // forecast_days=2 ensures +12h is always available regardless of current hour
    // minutely_15 gives fresher 10m/80m readings than the hourly forecast for 'now'.
    const m15Vars = 'windspeed_10m,winddirection_10m,windgusts_10m,windspeed_80m,winddirection_80m';
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=${plWindVars},${plHgtVars},${plTmpVars},${htVars},windspeed_10m,winddirection_10m,windgusts_10m&minutely_15=${m15Vars}&wind_speed_unit=kn&forecast_days=2&timezone=auto`;
    const rawData = await (await fetch(url, {signal})).json();

    if (!rawData?.hourly?.time?.length) {
      document.getElementById('fetch-status').textContent = 'Wind data unavailable for this location';
      setStatus('Wind data unavailable');
      return;
    }
    const fieldElevFt = state.fieldElevFt || 0;
    const ts          = Date.now();
    saveWindCache(lat, lng, {rawData, fieldElevFt, ts});
    state.fieldElevFt = fieldElevFt;

    processWindData(rawData, fieldElevFt);
    updateWindStatusAge(ts);
    setStatus(`Winds loaded · SFC ${state.surfaceWind.dirDeg ?? '?'}°@${state.surfaceWind.speedKts ?? '?'}kt`);
    fetchMetar(lat, lng);
  } catch(e) {
    if (e.name === 'AbortError') return; // superseded by a newer request
    document.getElementById('fetch-status').textContent = `Fetch failed: ${e.message}`;
    setStatus('Wind fetch failed');
    console.error(e);
  } finally {
    _fetchInProgress = false;
    btn.disabled     = false;
    btn.textContent  = '⬇ Refresh Winds';
  }
}

// ── Wind data processing ──────────────────────────────────────────────────────

// Slot key of the hi/mi most recently rendered by processWindData, so the 60s
// auto-refresh tick can skip work when the nearest slot hasn't advanced.
let _lastProcessedSlotKey = null;

/**
 * Pick the hourly (hi) and nearest 15-min (mi) slot indices for 'now' from a
 * cached or freshly-fetched Open-Meteo response. Pure — no side effects — so
 * the auto-refresh tick can peek at slot boundaries without disturbing state.
 * `mi` is -1 when viewing a future forecast offset (minutely_15 unused) or
 * when the response has no minutely_15 block.
 * @param {object} d - Parsed Open-Meteo forecast response
 * @returns {{hi:number, mi:number}}
 */
function _pickForecastIndices(d) {
  const nowMs   = Date.now();
  const hasOff  = d.utc_offset_seconds != null;
  const nearest = (arr) => hasOff
    ? arr.reduce((best, t, i) => {
        const apiMs  = new Date(t + 'Z').getTime() - d.utc_offset_seconds * 1000;
        const bestMs = new Date(arr[best] + 'Z').getTime() - d.utc_offset_seconds * 1000;
        return Math.abs(apiMs - nowMs) < Math.abs(bestMs - nowMs) ? i : best;
      }, 0)
    : arr.reduce((best, t, i) =>
        Math.abs(new Date(t).getTime() - nowMs) < Math.abs(new Date(arr[best]).getTime() - nowMs) ? i : best, 0);

  let hi = nearest(d.hourly.time);
  hi = Math.max(0, Math.min(hi + (state.forecastOffset || 0), d.hourly.time.length - 1));
  const mi = ((state.forecastOffset || 0) === 0 && d.minutely_15?.time?.length)
    ? nearest(d.minutely_15.time)
    : -1;
  return { hi, mi };
}

/**
 * Process raw GFS API response into state.winds and surface wind display.
 * Selects the nearest forecast hour (adjusted by state.forecastOffset), builds
 * interpolated display rows at every 1 k ft from 1–14 k ft AGL, rebuilds the
 * wind table, and updates heading/jump run displays. No network needed — operates
 * on cached rawData returned from fetchWinds().
 * @param {object} d - Raw GFS API hourly response (contains time array + wind/height/temp fields)
 * @param {number} fieldElevFt - Field elevation MSL (ft); converts pressure-level altitudes to AGL
 */
function processWindData(d, fieldElevFt) {
  // Find base hour index (hi) and nearest 15-min slot (mi, only when viewing
  // 'now') so 10m/80m readings can come from the fresher minutely_15 stream.
  // Comparing timestamps via UTC keeps the client's local timezone irrelevant
  // to which forecast hour is selected (BUG-5).
  const { hi, mi } = _pickForecastIndices(d);

  // Pick freshest available value for a given variable name: prefers minutely_15
  // slot when active (forecastOffset === 0), falls back to the hourly slot.
  const liveVal = (varName) => {
    if (mi >= 0 && d.minutely_15?.[varName]?.[mi] != null) return d.minutely_15[varName][mi];
    return d.hourly[varName]?.[hi];
  };

  // Update header forecast time label
  const effectiveDate = new Date(d.hourly.time[hi]);
  const timeLabel     = document.getElementById('forecast-time-label');
  const headerCtrl    = document.getElementById('forecast-header-ctrl');
  if (timeLabel) {
    const hh    = String(effectiveDate.getHours()).padStart(2, '0');
    const mo    = effectiveDate.toLocaleString('en', {month: 'short'});
    const dd    = effectiveDate.getDate();
    const isNow = (state.forecastOffset || 0) === 0;
    timeLabel.textContent = isNow ? `${mo} ${dd}  ${hh}:00` : `+${state.forecastOffset}h  ${mo} ${dd}  ${hh}:00`;
    timeLabel.style.color = isNow ? 'var(--muted)' : 'var(--accent2)';
  }
  if (headerCtrl) headerCtrl.style.display = 'flex';

  // Surface wind — guard against null API values (Math.round(null) = 0 is misleading)
  const _rawDir  = liveVal('winddirection_10m');
  const _rawSpd  = liveVal('windspeed_10m');
  const _rawGust = liveVal('windgusts_10m');
  state.surfaceWind = {
    dirDeg:   _rawDir  != null ? Math.round(_rawDir)  : null,
    speedKts: _rawSpd  != null ? Math.round(_rawSpd)  : null,
    gustKts:  _rawGust != null ? Math.round(_rawGust) : null,
  };
  state.fieldElevFt = fieldElevFt;

  // ── Build raw arrays for interpolation (keyed by MSL altitude) ──
  const rawWinds = state.surfaceWind.dirDeg != null
    ? [{altFt: fieldElevFt, dirDeg: state.surfaceWind.dirDeg, speedKts: state.surfaceWind.speedKts ?? 0}]
    : [];
  const rawTemp  = [];

  // Fixed-height-level winds (AGL → MSL), no temperature available
  // Store unrounded values — rounding happens at display time only.
  const htAGLft = {80: 262};
  HEIGHT_LEVELS.forEach(hm => {
    const spd = liveVal(`windspeed_${hm}m`);
    const dir = liveVal(`winddirection_${hm}m`);
    if (spd != null && dir != null)
      rawWinds.push({altFt: state.fieldElevFt + htAGLft[hm], dirDeg: dir, speedKts: spd});
  });

  // Pressure level winds + temperature at actual geopotential altitude
  const pressureRows = [];
  PRESSURE_LEVELS.forEach(p => {
    const spd = d.hourly[`windspeed_${p}hPa`]?.[hi];
    const dir = d.hourly[`winddirection_${p}hPa`]?.[hi];
    const hgt = d.hourly[`geopotential_height_${p}hPa`]?.[hi];
    const tmp = d.hourly[`temperature_${p}hPa`]?.[hi];
    if (spd != null && dir != null && hgt != null) {
      const mslFt = geopotentialToFtMSL(hgt);
      const aglFt = mslFt - state.fieldElevFt;
      if (aglFt < MIN_AGL_FT) return; // below or at ground level, skip
      rawWinds.push({altFt: mslFt, dirDeg: dir, speedKts: spd});
      if (tmp != null) rawTemp.push({altFt: mslFt, tempC: tmp});
      pressureRows.push({
        aglFt, altFt: aglFt, mslFt,
        dirDeg: dir, speedKts: spd,
        tempC: tmp ?? null,
        real: true,
        label: `${Math.round(aglFt / 100) * 100 === aglFt ? aglFt.toLocaleString() : '~' + Math.round(aglFt / 100) * 100}ft`,
        source: `${p}hPa`,
      });
    }
  });
  rawWinds.sort((a, b) => a.altFt - b.altFt);
  rawTemp.sort((a, b)  => a.altFt - b.altFt);

  // Temperature interpolation helper — returns unrounded °C; display rounds.
  function interpTemp(mslFt) {
    if (!rawTemp.length) return null;
    if (mslFt <= rawTemp[0].altFt) return rawTemp[0].tempC;
    if (mslFt >= rawTemp[rawTemp.length - 1].altFt) return rawTemp[rawTemp.length - 1].tempC;
    for (let i = 0; i < rawTemp.length - 1; i++) {
      const lo = rawTemp[i], hi2 = rawTemp[i + 1];
      if (mslFt >= lo.altFt && mslFt <= hi2.altFt) {
        const t = (mslFt - lo.altFt) / (hi2.altFt - lo.altFt);
        return lo.tempC + t * (hi2.tempC - lo.tempC);
      }
    }
    return null;
  }

  // ── Build display rows ──
  const allRows = [];

  // SFC row
  allRows.push({
    aglFt: 0, altFt: 0,
    dirDeg: state.surfaceWind.dirDeg, speedKts: state.surfaceWind.speedKts,
    tempC: interpTemp(state.fieldElevFt),
    real: true, label: 'SFC', source: '10m',
  });

  // Fixed height-level rows (262ft AGL) — stored unrounded
  HEIGHT_LEVELS.forEach(hm => {
    const spd = liveVal(`windspeed_${hm}m`);
    const dir = liveVal(`winddirection_${hm}m`);
    const agl = htAGLft[hm];
    if (spd != null && dir != null) {
      allRows.push({
        aglFt: agl, altFt: agl,
        dirDeg: dir, speedKts: spd,
        tempC: interpTemp(state.fieldElevFt + agl),
        real: true, label: `${agl}ft`, source: `${hm}m AGL`,
      });
    }
  });

  // Pressure level real data rows
  allRows.push(...pressureRows);
  allRows.sort((a, b) => a.aglFt - b.aglFt);

  // Interpolated rows at every 1k ft from 1k to 14k
  // Skip if a real row is within 100ft
  INTERP_ALTS_FT.forEach(agl => {
    const nearby = allRows.find(r => Math.abs(r.aglFt - agl) < 100);
    if (nearby) return;
    const msl     = agl + state.fieldElevFt;
    const wInterp = interpObj(rawWinds, msl);
    allRows.push({
      aglFt: agl, altFt: agl,
      dirDeg: wInterp.dirDeg, speedKts: wInterp.speedKts,
      tempC: interpTemp(msl),
      real: false,
      label: (agl / 1000).toFixed(1).replace(/\.0$/, '') + 'k',
      source: 'interpolated',
    });
  });

  // Final sort
  allRows.sort((a, b) => a.aglFt - b.aglFt);

  // Clean up pressure level labels — use k-suffix above 1000ft
  allRows.forEach(r => {
    if (r.source && r.source.endsWith('hPa')) {
      const ft = Math.round(r.aglFt / 100) * 100;
      r.label = r.aglFt < 1000
        ? Math.round(r.aglFt) + 'ft'
        : ft >= 1000
          ? (ft / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
          : ft + 'ft';
    }
  });

  state.winds = allRows;
  invalidateWindCaches();

  buildWindTable();
  if (!state.canopy.manualHeading && state.surfaceWind.dirDeg != null) { state.canopy.finalHeadingDeg = state.surfaceWind.dirDeg; updateHeadingDisplay(state.surfaceWind.dirDeg); }
  autoSetJumpRunHeading();
  updateWindPyramid();
  updateJrPyramid();

  _lastProcessedSlotKey = `${hi}|${mi}|${state.forecastOffset || 0}`;
}

// ── Wind table UI ─────────────────────────────────────────────────────────────
// state.winds entries: {altFt, aglFt, dirDeg, speedKts, tempC, real, label, source}

function buildWindTable() {
  const c = document.getElementById('wind-rows');
  c.innerHTML = '';
  if (!state.winds || !state.winds.length) return;

  state.winds.forEach((w, i) => {
    const row = document.createElement('div');
    const cls = w.real ? 'real' : 'interpolated';
    row.className = `wind-row ${cls}`;

    const altEl = document.createElement('div');
    altEl.className   = 'alt-label';
    altEl.textContent = w.label;

    const dirEl   = document.createElement('input');
    dirEl.type    = 'number'; dirEl.min = '0'; dirEl.max = '360'; dirEl.step = '1';
    dirEl.placeholder = '---';
    if (w.dirDeg != null) dirEl.value = Math.round(w.dirDeg);
    dirEl.addEventListener('change', () => updateWindByIdx(i, 'dirDeg', dirEl.value));

    const spdEl   = document.createElement('input');
    spdEl.type    = 'number'; spdEl.min = '0'; spdEl.max = '200'; spdEl.step = '1';
    spdEl.placeholder = '---';
    if (w.speedKts != null) spdEl.value = Math.round(w.speedKts);
    spdEl.addEventListener('change', () => updateWindByIdx(i, 'speedKts', spdEl.value));

    const tempEl = document.createElement('div');
    tempEl.className = 'temp-label';
    if (w.tempC !== null && w.tempC !== undefined) tempEl.textContent = Math.round(w.tempC) + '°';

    row.appendChild(altEl);
    row.appendChild(dirEl);
    // SFC row: wrap SPD input with a yellow gust overlay (display-only, hidden on focus)
    if (i === 0 && state.surfaceWind?.gustKts > 0) {
      const spdWrap = document.createElement('div');
      spdWrap.className = 'wind-spd-wrap';
      spdEl.classList.add('wind-spd-with-gust');
      const gustSpan = document.createElement('span');
      gustSpan.className = 'wind-gust-inline';
      gustSpan.textContent = `G${state.surfaceWind.gustKts}`;
      spdWrap.appendChild(spdEl);
      spdWrap.appendChild(gustSpan);
      row.appendChild(spdWrap);
    } else {
      row.appendChild(spdEl);
    }
    row.appendChild(tempEl);
    c.appendChild(row);
  });
}

function updateWindByIdx(i, field, val) {
  if (!state.winds[i]) return;
  const parsed = val === '' ? null : parseFloat(val);
  if (val !== '' && isNaN(parsed)) return; // reject non-numeric input
  invalidateWindCaches();
  state.winds[i][field] = parsed;
  if (state.winds[i].aglFt === 0) {
    if (!state.surfaceWind) state.surfaceWind = {dirDeg: null, speedKts: null};
    state.surfaceWind[field] = state.winds[i][field];
  }
  calculate();
}

// ── METAR fetch + display ─────────────────────────────────────────────────────

function _metarDistMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _renderNWSObs(p, stId, stName, distMi) {
  const COVER = { CLR: 'Clear', SKC: 'Clear', NSC: 'No sig cloud', CAVOK: 'Clear',
                  FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast', VV: 'Vert vis' };

  // Age / time
  const tsMs   = new Date(p.timestamp).getTime();
  const ageMin = Math.round((Date.now() - tsMs) / 60000);
  const ageStr = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)}h ago`;
  const zuluStr = new Date(tsMs).toISOString().slice(11, 16) + 'Z';

  // Wind — NWS wind speed in km/h → kts
  const wdirDeg = p.windDirection?.value;
  const wspdKmh = p.windSpeed?.value;
  const wgstKmh = p.windGust?.value;
  const wspdKts = wspdKmh != null ? Math.round(wspdKmh / 1.852) : null;
  const wgstKts = wgstKmh != null ? Math.round(wgstKmh / 1.852) : null;
  let windStr = 'Calm';
  if (wdirDeg != null && wspdKts != null && wspdKts > 0) {
    windStr = `${String(Math.round(wdirDeg)).padStart(3, '0')}° @ ${wspdKts} kts`;
    if (wgstKts) windStr += `, gusting ${wgstKts} kts`;
  }

  // Visibility — NWS in meters → miles
  const visM   = p.visibility?.value;
  const visStr = visM == null ? '--'
    : visM >= 16000 ? '10+ miles'
    : `${(visM / 1609.34).toFixed(1)} miles`;

  // Sky / cloud layers — NWS base in meters → ft
  let skyStr = 'Clear';
  if (p.cloudLayers?.length) {
    skyStr = p.cloudLayers.map(c => {
      const name   = COVER[c.amount] || c.amount;
      const baseFt = c.base?.value != null ? Math.round(c.base.value * 3.28084 / 100) * 100 : null;
      return baseFt != null ? `${name} at ${baseFt.toLocaleString()} ft` : name;
    }).join(' · ');
  }

  // Temp / dewpoint / RH
  const tempC = p.temperature?.value;
  const dewpC = p.dewpoint?.value;
  let tempStr = '--';
  if (tempC != null) {
    tempStr = `${Math.round(tempC)}°C`;
    if (dewpC != null) {
      const rh = Math.round(100
        * Math.exp((17.625 * dewpC) / (243.04 + dewpC))
        / Math.exp((17.625 * tempC) / (243.04 + tempC)));
      tempStr += ` / Dew ${Math.round(dewpC)}°C  (${rh}% RH)`;
    }
  }

  // Altimeter — NWS sea-level pressure in Pa → inHg / hPa
  const pPa = p.seaLevelPressure?.value ?? p.barometricPressure?.value;
  let altimStr = '--';
  if (pPa != null) {
    altimStr = `${(pPa / 3386.389).toFixed(2)} inHg  (${Math.round(pPa / 100)} hPa)`;
  }

  // Present weather — NWS decoded objects
  let wxStr = null;
  if (p.presentWeather?.length) {
    wxStr = p.presentWeather.map(w => {
      const parts = [];
      if (w.intensity) parts.push(w.intensity[0].toUpperCase() + w.intensity.slice(1));
      if (w.modifier)  parts.push(w.modifier);
      if (w.weather)   parts.push(w.weather[0].toUpperCase() + w.weather.slice(1));
      return parts.length ? parts.join(' ') : (w.rawString || '');
    }).filter(Boolean).join('; ');
  } else if (p.textDescription) {
    wxStr = p.textDescription;
  }

  const distStr = distMi < 0.1 ? '<0.1 mi away' : `${distMi.toFixed(1)} mi away`;
  const rows = [
    ['Wind',       windStr],
    ['Visibility', visStr],
    ...(wxStr ? [['Weather', wxStr]] : []),
    ['Sky',        skyStr],
    ['Temp / Dew', tempStr],
    ['Altimeter',  altimStr],
  ];
  const gridHTML = rows.map(([l, v]) =>
    `<div class="metar-lbl">${l}</div><div class="metar-val">${v}</div>`
  ).join('');

  return `
    <div class="metar-section-hdr">
      <span class="metar-section-tag">METAR</span>
      <span class="metar-dist-tag">${distStr}</span>
    </div>
    <div class="metar-id-row">
      <span class="metar-station-id">${stId}</span>
      <span class="metar-age">${zuluStr} · ${ageStr}</span>
    </div>
    ${stName ? `<div class="metar-station-name">${stName}</div>` : ''}
    <div class="metar-grid">${gridHTML}</div>
    ${p.rawMessage ? `<div class="metar-raw-obs">${p.rawMessage}</div>` : ''}
  `;
}

async function fetchMetar(lat, lng) {
  // Uses NWS API (api.weather.gov) which sends Access-Control-Allow-Origin: *
  // Step 1: /points/{lat},{lon} → get observation stations URL for this gridpoint
  // Step 2: fetch that stations URL → sorted list of nearby ASOS/AWOS stations
  // Step 3: /stations/{id}/observations/latest → decoded obs + raw METAR string
  const box = document.getElementById('metar-box');
  if (!box) return;
  try {
    const ptUrl  = `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`;
    const ptData = await (await fetch(ptUrl)).json();
    const stationsUrl = ptData?.properties?.observationStations;
    if (!stationsUrl) { box.style.display = 'none'; return; }

    const stData = await (await fetch(`${stationsUrl}?limit=10`)).json();
    if (!stData?.features?.length) { box.style.display = 'none'; return; }

    // GeoJSON coords are [lon, lat] — find nearest within 10 statute mile
    const withDist = stData.features
      .map(f => ({ f, dist: _metarDistMi(lat, lng, f.geometry.coordinates[1], f.geometry.coordinates[0]) }))
      .sort((a, b) => a.dist - b.dist);
    const nearest = withDist[0];
    if (nearest.dist > 10.0) { box.style.display = 'none'; return; }

    const stId   = nearest.f.properties.stationIdentifier;
    const stName = nearest.f.properties.name;
    const obs    = await (await fetch(`https://api.weather.gov/stations/${stId}/observations/latest`)).json();
    if (!obs?.properties?.timestamp) { box.style.display = 'none'; return; }

    box.innerHTML = _renderNWSObs(obs.properties, stId, stName, nearest.dist);
    box.style.display = 'block';
  } catch(e) {
    console.warn('METAR fetch failed', e);
    box.style.display = 'none';
  }
}

// ── Status age display ────────────────────────────────────────────────────────

function updateWindStatusAge(ts) {
  const ageMin    = Math.round((Date.now() - ts) / 60000);
  const ageStr    = ageMin < 1 ? 'just now' : `${ageMin}m ago`;
  const offsetStr = state.forecastOffset > 0 ? ` · +${state.forecastOffset}h forecast` : '';

  document.getElementById('fetch-status').textContent = '';
  const metaEl = document.getElementById('wind-tray-meta');
  if (metaEl) metaEl.textContent = `Elev ${state.fieldElevFt}ft MSL · Loaded ${ageStr}${offsetStr}`;

  const fBtn = document.getElementById('view-forecast-btn');
  if (fBtn) fBtn.disabled = false;

  const ageEl = document.getElementById('wind-loaded-age');
  if (ageEl) ageEl.textContent = `loaded ${ageStr}`;
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────
// Check every 60s and on tab-visibility change; fetch fresh data if cache is
// stale, otherwise re-run processWindData whenever the nearest hourly (hi) or
// minutely_15 (mi) slot has advanced so the 15-min readings don't go stale
// for up to 20 min while the tab sits open.

function checkWindRefresh() {
  if (!state.target || document.hidden) return;
  const cached = findCachedWinds(state.target.lat, state.target.lng);
  if (!cached) { fetchWinds().then(calculate).catch(e => console.error('Wind auto-refresh failed:', e)); return; }
  updateWindStatusAge(cached.ts);
  fetchMetar(state.target.lat, state.target.lng);

  const { hi, mi } = _pickForecastIndices(cached.rawData);
  const key = `${hi}|${mi}|${state.forecastOffset || 0}`;
  if (key !== _lastProcessedSlotKey) {
    processWindData(cached.rawData, cached.fieldElevFt);
    calculate();
  }
}

const _windRefreshInterval = setInterval(checkWindRefresh, 60 * 1000);

// Fire immediately whenever the page regains the user's attention. Redundant
// listeners give defense-in-depth across desktop/mobile browser quirks:
//   visibilitychange — primary: tab switch, OS app switch (iOS/Android), sleep/wake
//   pageshow(persisted) — bfcache restore (iOS Safari after long background)
//   focus — desktop window focus without visibility change (cmd-tab with window
//           partially visible); harmless belt-and-suspenders on mobile too
// checkWindRefresh is idempotent — re-entry with an unchanged slot key no-ops.
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkWindRefresh(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) checkWindRefresh(); });
window.addEventListener('focus', checkWindRefresh);
