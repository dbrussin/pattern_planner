// ── Full 96-hour forecast modal ───────────────────────────────────────────────
// Lazy-loaded: data is fetched only when the modal is first opened.
// Cached in memory for FORECAST_CACHE_MS to avoid redundant API calls.

const FORECAST_CACHE_MS = 30 * 60 * 1000;

let _fcCache = null; // { lat, lng, ts, rawData }

// ── Public: open / close / toggle ────────────────────────────────────────────

function openForecastModal() {
  const modal = document.getElementById('forecast-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  // Always start with details hidden
  const wrap = document.getElementById('forecast-table-wrap');
  if (wrap) wrap.classList.remove('ft-details-on');
  const btn = document.getElementById('fc-details-toggle');
  if (btn) btn.textContent = 'Show Details';

  if (!state.target) {
    _setFcStatus('No landing point set.');
    return;
  }

  const { lat, lng } = state.target;
  const now = Date.now();
  if (_fcCache && _fcCache.lat === lat && _fcCache.lng === lng && now - _fcCache.ts < FORECAST_CACHE_MS) {
    _renderForecastTable(_fcCache.rawData, state.fieldElevFt, _fcCache.ts);
    return;
  }

  _setFcStatus('Loading forecast…');
  if (wrap) wrap.innerHTML = '';
  _fetchFullForecast(lat, lng);
}

function closeForecastModal() {
  const modal = document.getElementById('forecast-modal');
  if (modal) modal.style.display = 'none';
}

function toggleFcDetails() {
  const wrap = document.getElementById('forecast-table-wrap');
  const btn  = document.getElementById('fc-details-toggle');
  const on   = wrap.classList.toggle('ft-details-on');
  if (btn) btn.textContent = on ? 'Hide Details' : 'Show Details';
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function _fetchFullForecast(lat, lng) {
  try {
    const plWindVars = PRESSURE_LEVELS.flatMap(p => [`windspeed_${p}hPa`, `winddirection_${p}hPa`]).join(',');
    const plHgtVars  = PRESSURE_LEVELS.map(p => `geopotential_height_${p}hPa`).join(',');
    const ccVars     = PRESSURE_LEVELS.map(p => `cloud_cover_${p}hPa`).join(',');
    const sfcVars    = 'temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation_probability,precipitation,is_day';

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&hourly=${plWindVars},${plHgtVars},${ccVars},${sfcVars}` +
      `&wind_speed_unit=kn&forecast_days=4&timezone=auto`;

    const rawData = await (await fetch(url)).json();
    if (!rawData?.hourly?.time?.length) {
      _setFcStatus('Forecast data unavailable for this location.');
      return;
    }

    _fcCache = { lat, lng, ts: Date.now(), rawData };
    _renderForecastTable(rawData, state.fieldElevFt, _fcCache.ts);
  } catch(e) {
    _setFcStatus(`Fetch failed: ${e.message}`);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function _renderForecastTable(rawData, fieldElevFt, ts) {
  const ageMin = Math.round((Date.now() - ts) / 60000);
  _setFcStatus(`Loaded ${ageMin < 1 ? 'just now' : ageMin + 'm ago'}`);

  const h      = rawData.hourly;
  const utcOff = rawData.utc_offset_seconds || 0;
  const times  = h.time;

  // Pressure levels ≤ 18,000 ft MSL and above ground, sorted low → high
  const plRows = [];
  for (const p of PRESSURE_LEVELS) {
    const hgtArr = h[`geopotential_height_${p}hPa`];
    if (!hgtArr) continue;
    const altMslFt = (hgtArr[0] ?? 0) * 3.28084;
    const altAglFt = Math.round(altMslFt - fieldElevFt);
    if (altAglFt < 0 || altMslFt > 18500) continue;
    plRows.push({ p, altAglFt });
  }
  plRows.sort((a, b) => a.altAglFt - b.altAglFt);

  const wrap = document.getElementById('forecast-table-wrap');
  const thead = _buildFcThead(times, utcOff, h.is_day);
  const tbody = _buildFcTbody(plRows, times, h);
  wrap.innerHTML = `<table class="forecast-table">${thead}${tbody}</table>`;
}

function _buildFcThead(times, utcOff, isDay) {
  const days = [];
  let curDay = '', curSpan = 0;
  for (const iso of times) {
    const d = _localDay(iso, utcOff);
    if (d === curDay) { curSpan++; }
    else { if (curDay) days.push({ label: curDay, span: curSpan }); curDay = d; curSpan = 1; }
  }
  if (curDay) days.push({ label: curDay, span: curSpan });

  let dayRow = '<tr><th class="ft-row-hdr ft-day-hdr"></th>';
  for (const d of days) dayRow += `<th class="ft-day-hdr" colspan="${d.span}">${d.label}</th>`;
  dayRow += '</tr>';

  let hrRow = '<tr><th class="ft-row-hdr">Alt AGL</th>';
  for (let i = 0; i < times.length; i++) {
    const cls = isDay?.[i] === 1 ? 'ft-hr-hdr ft-hdr-day' : 'ft-hr-hdr';
    hrRow += `<th class="${cls}">${_localHour(times[i], utcOff)}</th>`;
  }
  hrRow += '</tr>';

  return `<thead>${dayRow}${hrRow}</thead>`;
}

function _buildFcTbody(plRows, times, h) {
  return `<tbody>${_buildFcSfcRow(times, h)}${_buildFcPlRows(plRows, times, h)}</tbody>`;
}

function _buildFcSfcRow(times, h) {
  let row = '<tr><td class="ft-row-hdr ft-sfc-hdr">SFC</td>';
  for (let i = 0; i < times.length; i++) {
    const temp   = h.temperature_2m?.[i];
    const spd    = h.wind_speed_10m?.[i];
    const gust   = h.wind_gusts_10m?.[i];
    const dir    = h.wind_direction_10m?.[i];
    const pProb  = h.precipitation_probability?.[i];
    const precip = h.precipitation?.[i];

    row += `<td class="ft-sfc-cell">` +
      (temp  != null ? `<span class="ft-cell-temp">${Math.round(temp)}°</span>` : '') +
      (spd   != null ? `<span class="ft-cell-speed">${Math.round(spd)}kt</span>` : '') +
      (gust  != null && Math.round(gust) !== Math.round(spd ?? 0)
        ? `<span class="ft-cell-gust">G${Math.round(gust)}</span>` : '') +
      (dir   != null ? `<span class="ft-cell-dir">${Math.round(dir)}°</span>` : '') +
      (pProb != null ? `<span class="ft-cell-precip-prob">${Math.round(pProb)}%</span>` : '') +
      (precip != null && precip > 0 ? `<span class="ft-cell-precip">${precip.toFixed(1)}mm</span>` : '') +
      `</td>`;
  }
  return row + '</tr>';
}

function _buildFcPlRows(plRows, times, h) {
  let html = '';
  for (const row of plRows) {
    const label = row.altAglFt < 1000
      ? `${row.altAglFt}ft`
      : `${(row.altAglFt / 1000).toFixed(1)}k`;

    html += `<tr><td class="ft-row-hdr">${label}</td>`;
    for (let i = 0; i < times.length; i++) {
      const spd = h[`windspeed_${row.p}hPa`]?.[i];
      const dir = h[`winddirection_${row.p}hPa`]?.[i];
      const cc  = h[`cloud_cover_${row.p}hPa`]?.[i];
      const v   = cc != null ? Math.round(26 + 229 * (cc / 100)) : 26;
      const tc  = v >= 140 ? '#0f1014' : '#d8dde8';
      html +=
        `<td class="ft-pl-cell" style="background:rgb(${v},${v},${v});--ftc:${tc}">` +
        `<span class="ft-hidden ft-cell-speed">${spd != null ? Math.round(spd) + 'kt' : '—'}</span>` +
        `<span class="ft-hidden ft-cell-dir">${dir != null ? Math.round(dir) + '°' : ''}</span>` +
        `<span class="ft-hidden ft-cell-cloud">${cc != null ? '☁' + Math.round(cc) + '%' : ''}</span>` +
        `</td>`;
    }
    html += '</tr>';
  }
  return html;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setFcStatus(msg) {
  const el = document.getElementById('forecast-modal-status');
  if (el) el.textContent = msg;
}

function _localDay(isoStr, utcOffSec) {
  const ms  = Date.parse(isoStr) + utcOffSec * 1000;
  const d   = new Date(ms);
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
  return `${dow} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function _localHour(isoStr, utcOffSec) {
  const ms = Date.parse(isoStr) + utcOffSec * 1000;
  return String(new Date(ms).getUTCHours()).padStart(2, '0');
}
