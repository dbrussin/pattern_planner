// ─── SEARCH ────────────────────────────────────────────────────────────────────
// Drop zone search (USPA database + Nominatim geocoding) and search bar UI.
// Depends on: storage (storageKey), ui (setStatus), app (map)

const DZ_CACHE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let dzList = null, dzIdx = -1; // dzList=null means still loading

// ── Load DZ list (from cache or network) ──────────────────────────────────────

(async () => {
  try {
    const raw = localStorage.getItem(storageKey('dz_list'));
    if (raw) {
      const stored = JSON.parse(raw);
      if (Date.now() - stored.ts < DZ_CACHE_MS && Array.isArray(stored.list) && stored.list.length > 0) {
        dzList = stored.list;
        return;
      }
    }
  } catch(e) {}
  try {
    const d = await (await fetch('https://raw.githubusercontent.com/OTGApps/USPADropzones/master/dropzones.geojson')).json();
    dzList = d.features
      .filter(f => f.geometry?.coordinates)
      .map(f => ({
        name:  f.properties.name  || '',
        city:  f.properties.city  || '',
        state: f.properties.state || '',
        lat:   f.geometry.coordinates[1],
        lng:   f.geometry.coordinates[0],
      }))
      .filter(d => d.name && d.lat && d.lng);
    try {
      localStorage.setItem(storageKey('dz_list'), JSON.stringify({list: dzList, ts: Date.now()}));
    } catch(e) {}
  } catch(e) { dzList = []; console.warn('DZ data failed', e); }
})();

// ── Search bar show/hide ──────────────────────────────────────────────────────

function toggleSearch() {
  const bar = document.getElementById('search-bar');
  if (bar.classList.contains('open')) collapseSearch();
  else expandSearch();
}

function collapseSearch() {
  document.getElementById('search-bar').classList.remove('open');
  document.getElementById('dz-dropdown').classList.remove('open');
  document.getElementById('dz-dropdown').innerHTML = '';
}

function expandSearch() {
  const el = document.getElementById('dz-search');
  el.value = '';
  document.getElementById('search-bar').classList.add('open');
  // Synchronous focus required for iOS keyboard to open
  el.focus();
  el.click();
}

function goToMyLocation() {
  if (!navigator.geolocation) { setStatus('Geolocation not supported'); return; }
  navigator.geolocation.getCurrentPosition(
    p => { map.setView([p.coords.latitude, p.coords.longitude], 14); collapseSearch(); },
    ()  => setStatus('Unable to get location')
  );
}

// ── Dropdown input handlers ───────────────────────────────────────────────────

const dzEl = document.getElementById('dz-search');
const dzDd = document.getElementById('dz-dropdown');

dzEl.addEventListener('input', () => {
  const q = dzEl.value.trim().toLowerCase();
  if (q.length < 2) { closeDd(); return; }
  if (dzList === null) { showDd([{name: 'Loading drop zones…', city: '', state: '', lat: null, lng: null}]); return; }
  const res = dzList
    .filter(d => d.name.toLowerCase().includes(q) || d.city.toLowerCase().includes(q) || d.state.toLowerCase().includes(q))
    .slice(0, 12);
  showDd(res.length ? res : [{name: `Search "${dzEl.value}"`, city: 'via location search', state: '', lat: null, lng: null, geo: true}]);
});

dzEl.addEventListener('keydown', e => {
  const items = dzDd.querySelectorAll('.dz-item');
  if (e.key === 'ArrowDown')  { e.preventDefault(); dzIdx = Math.min(dzIdx + 1, items.length - 1); hilite(items); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); dzIdx = Math.max(dzIdx - 1, 0); hilite(items); }
  else if (e.key === 'Enter')     { e.preventDefault(); if (dzIdx >= 0) items[dzIdx]?.click(); }
  else if (e.key === 'Escape')    { closeDd(); dzEl.blur(); }
});

// ── Dropdown render helpers ───────────────────────────────────────────────────

function hilite(items) { items.forEach((el, i) => el.classList.toggle('selected', i === dzIdx)); }

function showDd(results) {
  dzIdx = -1; dzDd.innerHTML = '';
  results.forEach(dz => {
    const el    = document.createElement('div'); el.className = 'dz-item';
    const nameEl = document.createElement('div'); nameEl.className = 'dz-name'; nameEl.textContent = dz.name;
    const locEl  = document.createElement('div'); locEl.className  = 'dz-loc';  locEl.textContent  = [dz.city, dz.state].filter(Boolean).join(', ');
    el.appendChild(nameEl); el.appendChild(locEl);
    el.addEventListener('click', () => pickDZ(dz));
    dzDd.appendChild(el);
  });
  dzDd.classList.add('open');
}

function closeDd() { dzDd.classList.remove('open'); dzDd.innerHTML = ''; }

async function pickDZ(dz) {
  closeDd();
  collapseSearch();
  if (dz.geo) {
    try {
      const r = await (await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(dzEl.value.trim())}&format=json&limit=5`)).json();
      if (!r.length) { setStatus('Location not found'); return; }
      if (r.length === 1) {
        dzEl.value = r[0].display_name.split(',').slice(0, 2).join(',');
        map.setView([+r[0].lat, +r[0].lon], 14);
      } else {
        showDd(r.map(x => ({
          name:  x.display_name.split(',')[0],
          city:  x.display_name.split(',').slice(1, 3).join(',').trim(),
          state: '',
          lat:   +x.lat,
          lng:   +x.lon,
        })));
      }
    } catch(e) { setStatus('Geocode failed'); }
    return;
  }
  dzEl.value = dz.name;
  map.setView([dz.lat, dz.lng], 15);
}
