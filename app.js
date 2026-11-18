const DATA_URL = './buildings.json';
const PAGE_SIZE = 30;
const LECCO_CENTER = [45.8566, 9.3977];

const state = {
  snapshot: null,
  filtered: [],
  page: 1,
  selectedId: null,
  map: null,
  markers: new Map(),
  recordsByAddress: new Map(),
  geocodeCache: JSON.parse(localStorage.getItem('leccoCenedGeocodes') || '{}'),
  geocodeQueue: Promise.resolve(),
};

const el = (id) => document.getElementById(id);
const controls = {
  search: el('searchInput'),
  use: el('useFilter'),
  energyClass: el('classFilter'),
  pvOnly: el('pvOnly'),
  latestOnly: el('latestOnly'),
};

function number(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(value);
}

function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit' }).format(date);
}

function pct(value) {
  return `${number(value * 100, 1)}%`;
}

function classTone(energyClass) {
  if (/^A/.test(energyClass)) return 'a';
  if (/^[FG]/.test(energyClass)) return 'low';
  return 'mid';
}

function buildingType(record) {
  if (record.residential) return 'Residential';
  if (record.nonResidential) return 'Non-residential';
  return 'Unclassified';
}

function addressKey(record) {
  return record.normalizedAddress || record.address || record.id;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function latestPerAddress(records) {
  const byAddress = new Map();
  records.forEach((record) => {
    const key = addressKey(record);
    const current = byAddress.get(key);
    if (!current || String(record.certificateDate) > String(current.certificateDate)) byAddress.set(key, record);
  });
  return [...byAddress.values()];
}

function filterRecords() {
  const query = controls.search.value.trim().toUpperCase();
  const use = controls.use.value;
  const classGroup = controls.energyClass.value;
  let records = state.snapshot.records.filter((record) => {
    const haystack = `${record.address} ${record.normalizedAddress} ${record.id}`.toUpperCase();
    if (query && !haystack.includes(query)) return false;
    if (use === 'residential' && !record.residential) return false;
    if (use === 'nonResidential' && !record.nonResidential) return false;
    if (use === 'public' && !(record.publicProperty || record.publicUse)) return false;
    if (classGroup === 'A' && !/^A/.test(record.energyClass)) return false;
    if (classGroup === 'B-C' && !/^[BC]/.test(record.energyClass)) return false;
    if (classGroup === 'D-E' && !/^[DE]/.test(record.energyClass)) return false;
    if (classGroup === 'F-G' && !/^[FG]/.test(record.energyClass)) return false;
    if (controls.pvOnly.checked && !record.hasPv) return false;
    return true;
  });
  if (controls.latestOnly.checked) records = latestPerAddress(records);
  records.sort((a, b) => a.normalizedAddress.localeCompare(b.normalizedAddress, 'it'));
  state.filtered = records;
  state.page = Math.min(state.page, Math.max(1, Math.ceil(records.length / PAGE_SIZE)));
  renderAll();
}

function renderKpis() {
  const records = state.filtered;
  const uniqueAddresses = new Set(records.map((record) => record.normalizedAddress)).size;
  const residential = records.filter((record) => record.residential).length;
  const pv = records.filter((record) => record.hasPv).length;
  el('resultCount').textContent = number(records.length);
  el('kpiRecords').textContent = number(records.length);
  el('kpiAddresses').textContent = number(uniqueAddresses);
  el('kpiResidential').textContent = records.length ? pct(residential / records.length) : '—';
  el('kpiPv').textContent = number(pv);
  el('locateVisible').textContent = `Locate all ${number(uniqueAddresses)} addresses`;
}

function renderBars(targetId, entries, total) {
  const max = Math.max(...entries.map((entry) => entry.value), 1);
  el(targetId).innerHTML = entries.map((entry) => `
    <div class="bar-row">
      <span>${escapeHtml(entry.label)}</span>
      <div class="bar-track"><div class="bar-fill ${entry.tone || ''}" style="width:${(entry.value / max) * 100}%"></div></div>
      <span class="bar-value" title="${total ? pct(entry.value / total) : ''}">${number(entry.value)}</span>
    </div>`).join('');
}

function renderCharts() {
  const classes = ['A4', 'A3', 'A2', 'A1', 'B', 'C', 'D', 'E', 'F', 'G'];
  const classCounts = Object.fromEntries(classes.map((key) => [key, 0]));
  state.filtered.forEach((record) => { classCounts[record.energyClass] = (classCounts[record.energyClass] || 0) + 1; });
  renderBars('classChart', classes.map((key) => ({ label: key, value: classCounts[key], tone: classTone(key) })), state.filtered.length);

  const bands = [
    { label: '< 100', min: -Infinity, max: 100, tone: '' },
    { label: '100–200', min: 100, max: 200, tone: '' },
    { label: '200–300', min: 200, max: 300, tone: 'warn' },
    { label: '300–500', min: 300, max: 500, tone: 'warn' },
    { label: '≥ 500', min: 500, max: Infinity, tone: 'low' },
  ];
  const entries = bands.map((band) => ({ ...band, value: state.filtered.filter((record) => record.epNonRenewable >= band.min && record.epNonRenewable < band.max).length }));
  renderBars('epChart', entries, state.filtered.length);
}

function renderTable() {
  const pages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * PAGE_SIZE;
  const rows = state.filtered.slice(start, start + PAGE_SIZE);
  el('recordsBody').innerHTML = rows.map((record) => `
    <tr data-id="${escapeHtml(record.id)}" class="${record.id === state.selectedId ? 'active' : ''}" tabindex="0">
      <td><strong>${escapeHtml(record.address)}</strong><br><small>${escapeHtml(record.id)}</small></td>
      <td>${buildingType(record)}${record.publicProperty ? '<br><small>Public ownership</small>' : ''}</td>
      <td><span class="class-chip ${classTone(record.energyClass)}">${escapeHtml(record.energyClass)}</span></td>
      <td>${number(record.epNonRenewable, 1)} <small>kWh/m²·y</small></td>
      <td>${number(record.annualElectricity)} <small>kWh/y</small></td>
      <td>${number(record.heatedArea, 1)} <small>m²</small></td>
      <td>${dateLabel(record.certificateDate)}</td>
    </tr>`).join('') || '<tr><td colspan="7">No records match the current filters.</td></tr>';
  el('pageLabel').textContent = `Page ${state.page} of ${pages}`;
  el('prevPage').disabled = state.page <= 1;
  el('nextPage').disabled = state.page >= pages;
  el('recordsBody').querySelectorAll('tr[data-id]').forEach((row) => {
    const select = () => selectRecord(row.dataset.id);
    row.addEventListener('click', select);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') select(); });
  });
}

function metric(label, value, unit = '') {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}${unit ? ` <small>${escapeHtml(unit)}</small>` : ''}</dd></div>`;
}

function renderDetails(record) {
  el('emptyState').hidden = true;
  const detail = el('detailContent');
  detail.hidden = false;
  const googleUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${record.address}, Lecco, Italy`)}`;
  detail.innerHTML = `
    <p class="section-kicker">SELECTED BUILDING</p>
    <h2 class="detail-title">${escapeHtml(record.address)}</h2>
    <p class="detail-meta">APE ${escapeHtml(record.id)} · ${dateLabel(record.certificateDate)}</p>
    <div class="detail-badges">
      <span class="badge energy">Class ${escapeHtml(record.energyClass)}</span>
      <span class="badge">${buildingType(record)}</span>
      <span class="badge">${escapeHtml(record.dprUse || 'Use not reported')}</span>
      ${record.hasPv ? '<span class="badge">Existing PV</span>' : ''}
      ${record.publicProperty ? '<span class="badge">Public ownership</span>' : ''}
    </div>
    <section class="detail-section"><h3>Building and envelope</h3><dl class="metric-list">
      ${metric('Construction period', record.constructionPeriod || '—')}
      ${metric('Heated floor area', number(record.heatedArea, 1), 'm²')}
      ${metric('Heated volume', number(record.heatedVolume, 1), 'm³')}
      ${metric('Heat-loss surface', number(record.dispersingSurface, 1), 'm²')}
      ${metric('Surface-to-volume ratio', number(record.surfaceVolumeRatio, 3), 'm⁻¹')}
      ${metric('Heating need EP_H_ND', number(record.heatingNeed, 1), 'kWh/m²·y')}
    </dl></section>
    <section class="detail-section"><h3>Annual energy performance</h3><dl class="metric-list">
      ${metric('EPgl,nren', number(record.epNonRenewable, 1), 'kWh/m²·y')}
      ${metric('EPgl,ren', number(record.epRenewable, 1), 'kWh/m²·y')}
      ${metric('CO₂ emissions', number(record.co2, 1), 'kgCO₂eq/m²·y')}
      ${metric('Annual electricity', number(record.annualElectricity), 'kWh/y')}
      ${metric('Annual natural gas', number(record.annualGas), 'm³/y')}
      ${metric('Annual PV use', number(record.annualPvUse), 'kWh/y')}
    </dl></section>
    <section class="detail-section"><h3>Systems and retrofit</h3><dl class="metric-list">
      ${metric('Heating system', record.heatingSystem || '—')}
      ${metric('Heating energy carrier', record.heatingCarrier || '—')}
      ${metric('Heating power', number(record.heatingPower, 1), 'kW')}
      ${metric('Renewable system', record.renewableSystem || '—')}
      ${metric('Recommended retrofit', record.retrofitMeasure || '—')}
      ${metric('Post-retrofit class', record.retrofitClass || '—')}
    </dl></section>
    <a class="map-link" href="${googleUrl}" target="_blank" rel="noreferrer">Open address in Google Maps ↗</a>`;
}

function markerIcon(record, count = 1) {
  return L.divIcon({
    className: 'leaflet-div-icon',
    html: `<div class="map-marker ${classTone(record.energyClass)}"><span>${escapeHtml(record.energyClass)}</span>${count > 1 ? `<b>${count}</b>` : ''}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 28], popupAnchor: [0, -26],
  });
}

function addMarker(record, coords, focus = true) {
  if (!state.map || !window.L) return;
  const key = addressKey(record);
  const group = state.recordsByAddress.get(key) || [record];
  const representative = latestPerAddress(group)[0] || record;
  let marker = state.markers.get(key);
  if (!marker) {
    const classes = [...new Set(group.map((item) => item.energyClass).filter(Boolean))].join(', ');
    marker = L.marker([coords.lat, coords.lon], { icon: markerIcon(representative, group.length) }).addTo(state.map);
    marker.bindPopup(`<strong>${escapeHtml(representative.address)}</strong><br>${number(group.length)} APE record${group.length === 1 ? '' : 's'} · Class ${escapeHtml(classes || '—')}<br>Latest EPgl,nren ${number(representative.epNonRenewable, 1)} kWh/m²·y`);
    marker.on('click', () => selectRecord(representative.id));
    state.markers.set(key, marker);
  }
  if (focus) {
    state.map.setView([coords.lat, coords.lon], 17);
    marker.openPopup();
  }
}

async function geocode(record, focus = true) {
  const key = addressKey(record);
  if (state.geocodeCache[key]) {
    addMarker(record, state.geocodeCache[key], focus);
    el('mapStatus').textContent = `Located: ${record.address}`;
    return state.geocodeCache[key];
  }
  el('mapStatus').textContent = `Locating: ${record.address}…`;
  const query = encodeURIComponent(`${record.address}, 23900 Lecco, Italy`);
  const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=it&q=${query}`, { headers: { 'Accept-Language': 'it,en' } });
  if (!response.ok) throw new Error(`Geocoding failed: ${response.status}`);
  const result = (await response.json())[0];
  if (!result) throw new Error('No matching address');
  const coords = { lat: Number(result.lat), lon: Number(result.lon), label: result.display_name };
  state.geocodeCache[key] = coords;
  localStorage.setItem('leccoCenedGeocodes', JSON.stringify(state.geocodeCache));
  addMarker(record, coords, focus);
  el('mapStatus').textContent = `Located: ${record.address}`;
  return coords;
}

function queueGeocode(record, focus = true) {
  state.geocodeQueue = state.geocodeQueue.then(() => geocode(record, focus)).catch(() => {
    el('mapStatus').textContent = `Could not automatically locate “${record.address}”. Use the Google Maps link in the details panel.`;
  });
  return state.geocodeQueue;
}

function selectRecord(id) {
  const record = state.snapshot.records.find((item) => item.id === id);
  if (!record) return;
  state.selectedId = id;
  renderDetails(record);
  renderTable();
  queueGeocode(record, true);
  if (window.innerWidth < 760) el('detailCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAll() {
  renderKpis();
  renderCharts();
  renderTable();
}

function exportCurrentCsv() {
  const headers = ['COD_APE', 'INDIRIZZO', 'DATA_INS', 'TIPO', 'CLASSE_ENERGETICA', 'EP_GL_NREN', 'EP_H_ND', 'CONSUMI_ENERGIA_ELETTRICA', 'CONSUMI_GAS_NATURALE', 'SUPERF_UTILE_RISCALDATA', 'VOLUME_LORDO_RISCALDATO', 'RAPPORTO_SV', 'PV_ESISTENTE'];
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [headers.join(','), ...state.filtered.map((record) => [record.id, record.address, record.certificateDate, buildingType(record), record.energyClass, record.epNonRenewable, record.heatingNeed, record.annualElectricity, record.annualGas, record.heatedArea, record.heatedVolume, record.surfaceVolumeRatio, record.hasPv].map(quote).join(','))];
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'Lecco_CENED_filtered_buildings.csv';
  link.click();
  URL.revokeObjectURL(url);
}

function initMap() {
  if (!window.L) {
    el('map').innerHTML = '<div class="empty-state"><p>The map component could not load. Address search and Google Maps links remain available.</p></div>';
    return;
  }
  state.map = L.map('map', { zoomControl: true }).setView(LECCO_CENTER, 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);
}

function bindEvents() {
  Object.values(controls).forEach((control) => control.addEventListener(control.type === 'search' ? 'input' : 'change', () => { state.page = 1; filterRecords(); }));
  el('resetFilters').addEventListener('click', () => {
    controls.search.value = '';
    controls.use.value = 'all';
    controls.energyClass.value = 'all';
    controls.pvOnly.checked = false;
    controls.latestOnly.checked = false;
    state.page = 1;
    filterRecords();
  });
  el('exportCsv').addEventListener('click', exportCurrentCsv);
  el('prevPage').addEventListener('click', () => { state.page -= 1; renderTable(); });
  el('nextPage').addEventListener('click', () => { state.page += 1; renderTable(); });
  el('locateVisible').addEventListener('click', async () => {
    const button = el('locateVisible');
    const records = latestPerAddress(state.filtered);
    let completed = 0;
    let failed = 0;
    button.disabled = true;
    for (const record of records) {
      const key = addressKey(record);
      const wasCached = Boolean(state.geocodeCache[key]);
      el('mapStatus').textContent = `Locating addresses: ${completed + failed + 1} of ${records.length} · ${record.address}`;
      try {
        await geocode(record, false);
        completed += 1;
      } catch {
        failed += 1;
      }
      if (!wasCached) await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    const markers = records.map((record) => state.markers.get(addressKey(record))).filter(Boolean);
    if (markers.length) state.map.fitBounds(L.featureGroup(markers).getBounds().pad(.15));
    button.disabled = false;
    button.textContent = `Locate all ${number(records.length)} addresses`;
    el('mapStatus').textContent = `${completed} addresses located and cached${failed ? `; ${failed} could not be verified` : ''}. Markers may represent multiple APE records at the same address.`;
  });
}

function prepareAddressIndex() {
  state.recordsByAddress.clear();
  state.snapshot.records.forEach((record) => {
    const key = addressKey(record);
    if (!state.recordsByAddress.has(key)) state.recordsByAddress.set(key, []);
    state.recordsByAddress.get(key).push(record);
  });
}

function restoreCachedMarkers() {
  state.recordsByAddress.forEach((records, key) => {
    if (state.geocodeCache[key]) addMarker(latestPerAddress(records)[0], state.geocodeCache[key], false);
  });
  const located = state.markers.size;
  if (located) el('mapStatus').textContent = `${located} cached address locations restored. Use “Locate all addresses” to resolve the remainder.`;
}

async function init() {
  initMap();
  bindEvents();
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error('The building data file could not be loaded.');
  state.snapshot = await response.json();
  prepareAddressIndex();
  restoreCachedMarkers();
  filterRecords();
  if (state.filtered.length) selectRecord(state.filtered[0].id);
}

init().catch((error) => {
  document.querySelector('.dashboard').innerHTML = `<section class="card empty-state"><h2>Dashboard data could not be loaded</h2><p>${escapeHtml(error.message)}</p></section>`;
});
