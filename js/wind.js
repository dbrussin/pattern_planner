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
    const url = `https://api.open-meteo.com/v1/gfs?latitude=${lat}&longitude=${lng}&hourly=${plWindVars},${plHgtVars},${plTmpVars},${htVars},windspeed_10m,winddirection_10m&wind_speed_unit=kn&forecast_days=2&timezone=auto`;
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
  // Find base hour index by comparing UTC timestamps so the client's local
  // timezone doesn't affect which forecast hour is selected (BUG-5).
  const nowMs = Date.now();
  let hi = -1;
  if (d.utc_offset_seconds != null) {
    hi = d.hourly.time.reduce((best, t, i) => {
      const apiMs  = new Date(t).getTime() - d.utc_offset_seconds * 1000;
      const bestMs = new Date(d.hourly.time[best]).getTime() - d.utc_offset_seconds * 1000;
      return Math.abs(apiMs - nowMs) < Math.abs(bestMs - nowMs) ? i : best;
    }, 0);
  } else {
    // Fallback: nearest timestamp (works when client TZ matches API TZ)
    hi = d.hourly.time.reduce((best, t, i) =>
      Math.abs(new Date(t).getTime() - nowMs) < Math.abs(new Date(d.hourly.time[best]).getTime() - nowMs) ? i : best, 0);
  }
  hi = Math.max(0, Math.min(hi + (state.forecastOffset || 0), d.hourly.time.length - 1));

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
  const _rawDir = d.hourly.winddirection_10m?.[hi];
  const _rawSpd = d.hourly.windspeed_10m?.[hi];
  state.surfaceWind = {
    dirDeg:   _rawDir != null ? Math.round(_rawDir) : null,
    speedKts: _rawSpd != null ? Math.round(_rawSpd) : null,
  };
  state.fieldElevFt = fieldElevFt;

  // ── Build raw arrays for interpolation (keyed by MSL altitude) ──
  const rawWinds = state.surfaceWind.dirDeg != null
    ? [{altFt: fieldElevFt, dirDeg: state.surfaceWind.dirDeg, speedKts: state.surfaceWind.speedKts ?? 0}]
    : [];
  const rawTemp  = [];

  // Fixed-height-level winds (AGL → MSL), no temperature available
  const htAGLft = {80: 262, 120: 394, 180: 591};
  HEIGHT_LEVELS.forEach(hm => {
    const spd = d.hourly[`windspeed_${hm}m`]?.[hi];
    const dir = d.hourly[`winddirection_${hm}m`]?.[hi];
    if (spd != null && dir != null)
      rawWinds.push({altFt: state.fieldElevFt + htAGLft[hm], dirDeg: Math.round(dir), speedKts: Math.round(spd)});
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
      rawWinds.push({altFt: mslFt, dirDeg: Math.round(dir), speedKts: Math.round(spd)});
      if (tmp != null) rawTemp.push({altFt: mslFt, tempC: tmp});
      pressureRows.push({
        aglFt, altFt: aglFt, mslFt,
        dirDeg: Math.round(dir), speedKts: Math.round(spd),
        tempC: tmp !== null && tmp !== undefined ? Math.round(tmp * 10) / 10 : null,
        real: true,
        label: `${Math.round(aglFt / 100) * 100 === aglFt ? aglFt.toLocaleString() : '~' + Math.round(aglFt / 100) * 100}ft`,
        source: `${p}hPa`,
      });
    }
  });
  rawWinds.sort((a, b) => a.altFt - b.altFt);
  rawTemp.sort((a, b)  => a.altFt - b.altFt);

  // Temperature interpolation helper
  function interpTemp(mslFt) {
    if (!rawTemp.length) return null;
    if (mslFt <= rawTemp[0].altFt) return rawTemp[0].tempC;
    if (mslFt >= rawTemp[rawTemp.length - 1].altFt) return rawTemp[rawTemp.length - 1].tempC;
    for (let i = 0; i < rawTemp.length - 1; i++) {
      const lo = rawTemp[i], hi2 = rawTemp[i + 1];
      if (mslFt >= lo.altFt && mslFt <= hi2.altFt) {
        const t = (mslFt - lo.altFt) / (hi2.altFt - lo.altFt);
        return Math.round((lo.tempC + t * (hi2.tempC - lo.tempC)) * 10) / 10;
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

  // Fixed height-level rows (262/394/591ft AGL)
  HEIGHT_LEVELS.forEach(hm => {
    const spd = d.hourly[`windspeed_${hm}m`]?.[hi];
    const dir = d.hourly[`winddirection_${hm}m`]?.[hi];
    const agl = htAGLft[hm];
    if (spd != null && dir != null) {
      allRows.push({
        aglFt: agl, altFt: agl,
        dirDeg: Math.round(dir), speedKts: Math.round(spd),
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
  _sortedWindsCache = null; _sortedTempCache = null; // invalidate caches

  buildWindTable();
  if (!state.manualHeading && state.surfaceWind.dirDeg != null) { state.finalHeadingDeg = state.surfaceWind.dirDeg; updateHeadingDisplay(state.surfaceWind.dirDeg); }
  autoSetJumpRunHeading();
  updateWindPyramid();
  updateJrPyramid();
}

// ── Wind table UI ─────────────────────────────────────────────────────────────
// state.winds entries: {altFt, aglFt, dirDeg, speedKts, tempC, real, label, source}

function buildWindTable() {
  const c = document.getElementById('wind-rows');
  c.innerHTML = '';
  if (!state.winds || !state.winds.length) return;

  state.winds.forEach((w, i) => {
    const row = document.createElement('div');
    const cls = w.aglFt === 0 ? 'sfc' : w.real ? 'real' : 'interpolated';
    row.className = `wind-row ${cls}`;

    const altEl = document.createElement('div');
    altEl.className   = 'alt-label';
    altEl.textContent = w.label;

    const dirEl   = document.createElement('input');
    dirEl.type    = 'number'; dirEl.min = '0'; dirEl.max = '360'; dirEl.step = '1';
    dirEl.placeholder = '---';
    if (w.dirDeg !== null) dirEl.value = w.dirDeg;
    dirEl.addEventListener('change', () => updateWindByIdx(i, 'dirDeg', dirEl.value));

    const spdEl   = document.createElement('input');
    spdEl.type    = 'number'; spdEl.min = '0'; spdEl.max = '200'; spdEl.step = '1';
    spdEl.placeholder = '---';
    if (w.speedKts !== null) spdEl.value = w.speedKts;
    spdEl.addEventListener('change', () => updateWindByIdx(i, 'speedKts', spdEl.value));

    const tempEl = document.createElement('div');
    tempEl.className = 'temp-label';
    if (w.tempC !== null && w.tempC !== undefined) tempEl.textContent = Math.round(w.tempC) + '°';

    row.appendChild(altEl); row.appendChild(dirEl); row.appendChild(spdEl); row.appendChild(tempEl);
    c.appendChild(row);
  });
}

function updateWindByIdx(i, field, val) {
  if (!state.winds[i]) return;
  const parsed = val === '' ? null : parseFloat(val);
  if (val !== '' && isNaN(parsed)) return; // reject non-numeric input
  _sortedWindsCache = null; _sortedTempCache = null; // invalidate caches
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

function _decodeWx(wxStr) {
  if (!wxStr) return '';
  const INTENSITY = { '-': 'Light', '+': 'Heavy', 'VC': 'In vicinity' };
  const DESC      = { MI: 'Shallow', BC: 'Patches', PR: 'Partial', DR: 'Drifting', BL: 'Blowing', SH: 'Showers', TS: 'Thunderstorm', FZ: 'Freezing' };
  const PRECIP    = { DZ: 'Drizzle', RA: 'Rain', SN: 'Snow', SG: 'Snow grains', IC: 'Ice crystals', PL: 'Ice pellets', GR: 'Hail', GS: 'Small hail', UP: 'Unknown precip' };
  const OBSCUR    = { BR: 'Mist', FG: 'Fog', FU: 'Smoke', VA: 'Volcanic ash', DU: 'Dust', SA: 'Sand', HZ: 'Haze' };
  const OTHER     = { PO: 'Dust whirls', SQ: 'Squalls', FC: 'Funnel cloud / tornado', SS: 'Sandstorm', DS: 'Dust storm' };

  return wxStr.trim().split(/\s+/).map(grp => {
    let s = grp, parts = [];
    if (s.startsWith('VC'))        { parts.push(INTENSITY.VC); s = s.slice(2); }
    else if (s[0] === '-' || s[0] === '+') { parts.push(INTENSITY[s[0]]); s = s.slice(1); }
    for (const [c, n] of Object.entries(DESC))   { if (s.startsWith(c)) { parts.push(n); s = s.slice(c.length); break; } }
    for (const [c, n] of Object.entries(PRECIP)) { if (s.includes(c))   { parts.push(n); s = s.replace(c, ''); break; } }
    for (const [c, n] of Object.entries(OBSCUR)) { if (s.includes(c))   { parts.push(n); s = s.replace(c, ''); break; } }
    for (const [c, n] of Object.entries(OTHER))  { if (s.includes(c))   { parts.push(n); break; } }
    return parts.length ? parts.join(' ') : grp;
  }).join('; ');
}

function _renderMetar(m, distMi) {
  const COVER = { CLR: 'Clear', SKC: 'Clear', CAVOK: 'Clear', NSC: 'No sig cloud',
                  FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast', VV: 'Vert vis' };

  // Age
  const rt     = m.reportTime;
  const rtMs   = new Date(rt.includes('Z') || rt.includes('+') ? rt : rt.replace(' ', 'T') + 'Z').getTime();
  const ageMin = Math.round((Date.now() - rtMs) / 60000);
  const ageStr = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)}h ago`;

  // Time label in Zulu
  const rtDate = new Date(rtMs);
  const zuluStr = `${String(rtDate.getUTCHours()).padStart(2, '0')}${String(rtDate.getUTCMinutes()).padStart(2, '0')}Z`;

  // Wind
  let windStr = 'Calm';
  if (m.wdir != null && m.wspd != null && m.wspd > 0) {
    const dir = m.wdir === 'VRB' || m.wdir === 0 && m.wspd === 0
      ? 'Variable'
      : `${String(m.wdir).padStart(3, '0')}°`;
    windStr = `${dir} @ ${m.wspd} kts`;
    if (m.wgst) windStr += `, gusting ${m.wgst} kts`;
  } else if (m.wdir === 'VRB') {
    windStr = `Variable @ ${m.wspd ?? 0} kts`;
  }

  // Visibility
  let visStr = '--';
  if (m.visib != null) {
    const v = String(m.visib);
    visStr = v === '10+' ? '10+ miles' : `${v} mile${v === '1' ? '' : 's'}`;
  }

  // Sky
  let skyStr = 'Clear';
  if (m.clouds && m.clouds.length) {
    skyStr = m.clouds.map(c => {
      const name = COVER[c.cover] || c.cover;
      return c.base != null ? `${name} at ${c.base.toLocaleString()} ft` : name;
    }).join(' · ');
  }

  // Temp / dewpoint / RH
  let tempStr = '--';
  if (m.temp != null) {
    tempStr = `${Math.round(m.temp)}°C`;
    if (m.dewp != null) {
      const rh = Math.round(100
        * Math.exp((17.625 * m.dewp) / (243.04 + m.dewp))
        / Math.exp((17.625 * m.temp) / (243.04 + m.temp)));
      tempStr += ` / Dew ${Math.round(m.dewp)}°C  (${rh}% RH)`;
    }
  }

  // Altimeter (hPa → inHg)
  let altimStr = '--';
  if (m.altim != null) {
    const inHg = (m.altim / 33.8639).toFixed(2);
    altimStr = `${inHg} inHg  (${Math.round(m.altim)} hPa)`;
  }

  // WX phenomena
  const wxDecoded = m.wxString ? _decodeWx(m.wxString) : null;

  const isSpeci = m.metarType === 'SPECI';
  const distStr = distMi < 0.1 ? '<0.1 mi away' : `${distMi.toFixed(1)} mi away`;
  const stationName = m.name || '';

  const rows = [
    ['Wind',       windStr],
    ['Visibility', visStr],
    ...(wxDecoded ? [['Weather', wxDecoded]] : []),
    ['Sky',        skyStr],
    ['Temp / Dew', tempStr],
    ['Altimeter',  altimStr],
  ];

  const gridHTML = rows.map(([lbl, val]) =>
    `<div class="metar-lbl">${lbl}</div><div class="metar-val">${val}</div>`
  ).join('');

  return `
    <div class="metar-section-hdr">
      <span class="metar-section-tag">METAR${isSpeci ? ' <span class="metar-speci">SPECI</span>' : ''}</span>
      <span class="metar-dist-tag">${distStr}</span>
    </div>
    <div class="metar-id-row">
      <span class="metar-station-id">${m.icaoId}</span>
      <span class="metar-age">${zuluStr} · ${ageStr}</span>
    </div>
    ${stationName ? `<div class="metar-station-name">${stationName}</div>` : ''}
    <div class="metar-grid">${gridHTML}</div>
    <div class="metar-raw-obs">${m.rawOb || ''}</div>
  `;
}

async function fetchMetar(lat, lng) {
  const box = document.getElementById('metar-box');
  if (!box) return;
  try {
    // bbox: south,west,north,east — ~1.7 mi buffer each direction, then enforce ≤1 mi client-side
    const d    = 0.025;
    const dLon = d / Math.cos(lat * Math.PI / 180);
    const bbox = `${(lat - d).toFixed(4)},${(lng - dLon).toFixed(4)},${(lat + d).toFixed(4)},${(lng + dLon).toFixed(4)}`;
    const url  = `https://aviationweather.gov/api/data/metar?bbox=${bbox}&format=json&hours=1`;
    const data = await (await fetch(url)).json();
    if (!Array.isArray(data) || !data.length) { box.style.display = 'none'; return; }

    // Keep only the most recent observation per station, then pick closest
    const byStation = {};
    data.forEach(m => {
      const t = new Date(m.reportTime).getTime();
      if (!byStation[m.icaoId] || t > byStation[m.icaoId].t) byStation[m.icaoId] = { m, t };
    });
    const withDist = Object.values(byStation)
      .map(({ m }) => ({ m, dist: _metarDistMi(lat, lng, m.lat, m.lon) }))
      .sort((a, b) => a.dist - b.dist);
    const nearest = withDist[0];
    if (nearest.dist > 1.0) { box.style.display = 'none'; return; }

    box.innerHTML = _renderMetar(nearest.m, nearest.dist);
    box.style.display = 'block';
  } catch(e) {
    console.warn('METAR fetch failed', e);
    box.style.display = 'none';
  }
}

// ── Status age display ────────────────────────────────────────────────────────

function updateWindStatusAge(ts) {
  const sw      = state.surfaceWind;
  const ageMin  = Math.round((Date.now() - ts) / 60000);
  const ageStr  = ageMin < 1 ? 'just now' : `${ageMin}m ago`;
  const offsetStr = state.forecastOffset > 0 ? ` · +${state.forecastOffset}h forecast` : '';
  document.getElementById('fetch-status').textContent =
    `SFC: ${sw.dirDeg}° @ ${sw.speedKts}kt · Elev ${state.fieldElevFt}ft MSL\nLoaded ${ageStr}${offsetStr} · teal = real data · grey = interpolated`;
  const ageEl = document.getElementById('wind-loaded-age');
  if (ageEl) ageEl.textContent = `loaded ${ageStr}`;
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────
// Check every 60s; fetch fresh data if cache is stale and page is visible.

const _windRefreshInterval = setInterval(() => {
  if (!state.target || document.hidden) return;
  const cached = findCachedWinds(state.target.lat, state.target.lng);
  if (!cached) { fetchWinds().then(calculate).catch(e => console.error('Wind auto-refresh failed:', e)); return; }
  updateWindStatusAge(cached.ts);
  fetchMetar(state.target.lat, state.target.lng);
}, 60 * 1000);
