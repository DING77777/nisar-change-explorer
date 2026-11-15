// AI-assisted code (Claude, Codex); see README, Use of AI.
// NISAR Change Explorer: reads scene packages from ./scenes and shows them on a swipe map.

const THUMB_PX = 26;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ROLES = ['baseline_1', 'baseline_2', 'after'];
const ZONE_STYLE = {
  target: { color: '#b3541e', label: 'area of interest' },
  control: { color: '#12306b', label: 'comparison area' },
  stable: { color: '#5b6676', label: 'stable ground' },
};
const state = { index: [], scenes: {}, scene: null, view: 'backscatter', pol: 'hh', pair: 'event', dateIndex: 0, colour: 0, rel: false, layerOn: {} };
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- map
const map = L.map('map', { zoomSnap: 0.25, maxBoundsViscosity: 1.0 });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
map.createPane('left').style.zIndex = 410;
map.createPane('right').style.zIndex = 411;
map.createPane('single').style.zIndex = 412;
map.createPane('optical').style.zIndex = 405;   // optical picture is the base map; radar layers sit on top of it
map.createPane('objects').style.zIndex = 440;   // cells, fields and official outlines
map.createPane('pins').style.zIndex = 450;   // vector markers must sit above the image panes
const objectLayer = L.layerGroup().addTo(map);
const boxLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);
const overlays = { left: null, right: null };

function clipPanes() {
  const size = map.getSize();
  const nw = map.containerPointToLayerPoint([0, 0]);
  const se = map.containerPointToLayerPoint(size);
  const offset = THUMB_PX / 2 + Number($('swipe').value) * (size.x - THUMB_PX);
  const x = nw.x + offset;
  map.getPane('left').style.clip = `rect(${nw.y}px, ${x}px, ${se.y}px, ${nw.x}px)`;
  map.getPane('right').style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
  $('divider').style.left = `${offset}px`;
}
map.on('move zoom zoomend resize', clipPanes);
$('swipe').addEventListener('input', clipPanes);

// ---------------------------------------------------------------- helpers
// A version tag on image URLs, so a rebuilt case is never shown with old cached pictures.
function ver(s) {
  return s && s.generated_utc ? `?v=${encodeURIComponent(s.generated_utc)}` : '';
}
function niceDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function shortDate(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}
function db(v, digits = 2) {
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)} dB`;
}
function pct(v) {
  return `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function overpass(scene) {
  return new Date(`${scene.dates.after.date}T${scene.dates.after.time_utc}Z`);
}
function localClock(date, scene) {
  const t = new Date(date.getTime() + scene.local_time.utc_offset_hours * 3600e3);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} ${scene.local_time.label} on ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
}
function phaseText(d) {
  return { after: '(after the event)', before: '(before)' }[d.phase] || '';
}
// A scene is either "two dates before an event and one after" (default) or "three dates, two real changes".
function isBaselineStory(s) {
  return (s.story || 'baseline_event') === 'baseline_event';
}
function wording(s) {
  const d = s.dates, span = [`${shortDate(d.baseline_1.date)} to ${shortDate(d.baseline_2.date)}`, `${shortDate(d.baseline_2.date)} to ${shortDate(d.after.date)}`];
  if (isBaselineStory(s)) {
    return {
      span, short: ['Normal 12 days', 'Across the event'],
      change: [`normal change: ${span[0]}`, `event change: ${span[1]}`],
      notes: { baseline_1: '', baseline_2: '(before)', after: '(after)' },
      pairs: { normal: 'Two dates before the event', event: 'Before and after the event' },
    };
  }
  const notes = s.date_notes || {};
  return {
    span, short: s.interval_short || ['First change', 'Second change'],
    change: s.interval_labels || span,
    notes: Object.fromEntries(ROLES.map((r) => [r, notes[r] ? `(${notes[r]})` : ''])),
    pairs: { normal: `${shortDate(d.baseline_1.date)} and ${shortDate(d.baseline_2.date)}`, event: `${shortDate(d.baseline_2.date)} and ${shortDate(d.after.date)}` },
  };
}
function syncButtons() {
  for (const [group, attr, key] of [['viewgroup', 'view', 'view'], ['polgroup', 'pol', 'pol'], ['pairgroup', 'pair', 'pair']]) {
    for (const b of $(group).querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === state[key]);
  }
}

// ---------------------------------------------------------------- charts
// HH and HV on each date, relative to the average of the dates before the event (or to the first date).
function relChart(dates, hh, hv, W = 340, H = 150) {
  const L0 = 40, R = 14, T = 12, B = 24;
  const hasEvent = dates.some((d) => d.phase === 'after');
  const rel = (vals) => {
    const before = vals.filter((v, i) => v !== null && dates[i].phase === 'before');
    const base = hasEvent && before.length ? before.reduce((a, b) => a + b, 0) / before.length : vals.find((v) => v !== null);
    return vals.map((v) => (v === null ? null : v - base));
  };
  const rh = rel(hh), rv = rel(hv);
  const all = [...rh, ...rv].filter((v) => v !== null);
  if (!all.length) return '<p class="small">No values to plot.</p>';
  const top = Math.max(1, Math.ceil(Math.max(...all))), bottom = Math.min(-1, Math.floor(Math.min(...all)));
  const times = dates.map((d) => Date.parse(d.date));
  const t0 = times[0], t1 = times[times.length - 1];
  const x = (t) => L0 + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - L0 - R);
  const y = (v) => T + (top - v) / (top - bottom) * (H - T - B);
  const line = (vals, colour, dash) => {
    const pts = vals.map((v, i) => (v === null ? null : [x(times[i]), y(v)])).filter(Boolean);
    return `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}" fill="none" stroke="${colour}" stroke-width="2"${dash ? ' stroke-dasharray="5 3"' : ''}/>`
      + pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${colour}"/>`).join('');
  };
  const beforeHH = rh.filter((v, i) => v !== null && dates[i].phase === 'before');
  const band = hasEvent && beforeHH.length > 1
    ? `<rect x="${L0}" width="${W - L0 - R}" y="${y(Math.max(...beforeHH))}" height="${Math.max(1, y(Math.min(...beforeHH)) - y(Math.max(...beforeHH)))}" fill="#12306b" opacity="0.12"/>` : '';
  const firstAfter = dates.findIndex((d) => d.phase === 'after');
  let eventLine = '';
  if (firstAfter > 0) {
    // The event falls somewhere between these two passes; shade that interval rather than inventing a date.
    const xa = x(times[firstAfter - 1]), xb = x(times[firstAfter]);
    eventLine = `<rect x="${xa}" y="${T}" width="${Math.max(1, xb - xa)}" height="${H - T - B}" fill="#b3541e" opacity="0.12"/>`
      + `<text x="${(xa + xb) / 2}" y="${T + 8}" text-anchor="middle" font-size="9" fill="#b3541e">event between passes</text>`;
  }
  const every = Math.ceil(dates.length / 5);
  const last = dates.length - 1;
  // First and last dates are anchored inwards so they are never cut off at the chart edge.
  const ticks = dates.map((d, i) => ((i % every && i !== last) || (i !== last && last - i < every / 2 && i !== 0) ? '' :
    `<text x="${x(times[i])}" y="${H - 7}" text-anchor="${i === 0 ? 'start' : i === last ? 'end' : 'middle'}" font-size="10" fill="#5b6676">${shortDate(d.date)}</text>`)).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Radar return over time">`
    + band
    + `<line x1="${L0}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#9aa3b0"/>`
    + `<line x1="${L0}" x2="${L0}" y1="${T}" y2="${H - B}" stroke="#5b6676"/>`
    + `<text x="${L0 - 4}" y="${y(top) + 4}" text-anchor="end" font-size="10" fill="#5b6676">+${top} dB</text>`
    + `<text x="${L0 - 4}" y="${y(0) + 3}" text-anchor="end" font-size="10" fill="#5b6676">0</text>`
    + `<text x="${L0 - 4}" y="${y(bottom) + 3}" text-anchor="end" font-size="10" fill="#5b6676">${bottom} dB</text>`
    + eventLine + line(rv, '#f5a623', true) + line(rh, '#12306b', false) + ticks + '</svg>'
    + `<p class="chartkey"><span class="k"></span>HH <span class="k dash"></span>HV · change in dB from ${hasEvent ? 'the average before the event' : 'the first date'}</p>`;
}

function gaugeChart(e, scene) {
  const W = 340, H = 150, L0 = 38, R = 8, T = 10, B = 24;
  const pts = e.series.map(([t, v]) => [Date.parse(t), v]);
  if (!pts.length) return '<p class="small">No gauge readings available.</p>';
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const vmax = Math.max(...pts.map((p) => p[1])), vmin = Math.min(...pts.map((p) => p[1]));
  const top = Math.ceil(vmax), bottom = Math.floor(vmin);
  const x = (t) => L0 + (t - t0) / (t1 - t0) * (W - L0 - R);
  const y = (v) => T + (top - v) / (top - bottom || 1) * (H - T - B);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const offset = scene.local_time.utc_offset_hours * 3600e3;
  let ticks = '';
  for (let day = Math.ceil((t0 + offset) / 864e5) * 864e5 - offset; day <= t1; day += 2 * 864e5) {
    const d = new Date(day + offset);
    ticks += `<line x1="${x(day)}" x2="${x(day)}" y1="${H - B}" y2="${H - B + 4}" stroke="#5b6676"/>`
      + `<text x="${x(day)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#5b6676">${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}</text>`;
  }
  const pass = overpass(scene).getTime();
  let passLine = '', passText = '';
  if (pass >= t0 && pass <= t1) {
    const near = pts.reduce((a, b) => (Math.abs(b[0] - pass) < Math.abs(a[0] - pass) ? b : a));
    passLine = `<line x1="${x(pass)}" x2="${x(pass)}" y1="${T}" y2="${H - B}" stroke="#b3541e" stroke-width="2" stroke-dasharray="4 3"/>`
      + `<text x="${x(pass) - 4}" y="${T + 9}" text-anchor="end" font-size="10" fill="#b3541e">satellite pass</text>`;
    passText = ` At the satellite pass (${localClock(new Date(pass), scene)}) the level was ${near[1].toFixed(2)} m.`;
  }
  const peak = pts.reduce((a, b) => (b[1] > a[1] ? b : a));
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="River level at ${esc(e.label)}">`
    + `<line x1="${L0}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#5b6676"/>`
    + `<line x1="${L0}" x2="${L0}" y1="${T}" y2="${H - B}" stroke="#5b6676"/>`
    + `<text x="${L0 - 4}" y="${y(top) + 4}" text-anchor="end" font-size="10" fill="#5b6676">${top} m</text>`
    + `<text x="${L0 - 4}" y="${y(bottom) + 3}" text-anchor="end" font-size="10" fill="#5b6676">${bottom} m</text>`
    + ticks + `<path d="${path}" fill="none" stroke="#12306b" stroke-width="2"/>` + passLine + '</svg>';
  return `<p><b>${esc(e.label)}</b></p>${svg}`
    + `<p>Highest hourly level in this record: ${peak[1].toFixed(2)} m at ${localClock(new Date(peak[0]), scene)}.${passText}</p>`
    + `<p class="small">${esc(e.note)} ${esc(e.credit)}.</p>`;
}

// ---------------------------------------------------------------- layers
function currentLayers() {
  const s = state.scene, d = s.dates, pol = state.pol.toUpperCase(), w = wording(s);
  if (state.view === 'change') {
    const relative = state.rel && Boolean(s.images.change_rel);
    const changeImages = relative ? s.images.change_rel : s.images.change;
    const suffix = relative ? ' (relative to the whole window)' : '';
    return {
      left: changeImages[state.pol].normal, right: changeImages[state.pol].event,
      leftLabel: `Change, ${pol}: ${w.change[0]}${suffix}`, rightLabel: `Change, ${pol}: ${w.change[1]}${suffix}`,
      hint: `The slider compares two periods. Left of the line: change over ${w.span[0]}${isBaselineStory(s) ? ' (a normal 12 days)' : ''}. `
        + `Right of the line: change over ${w.span[1]}. Same colour scale on both sides: blue means the radar return dropped, red means it rose. Colours are not hazard classes.` + (relative ? ' ' + s.display.relative.note : ''),
    };
  }
  const b = s.images.backscatter[state.pol];
  const [r1, r2] = state.pair === 'normal' ? ['baseline_1', 'baseline_2'] : ['baseline_2', 'after'];
  return {
    left: b[r1], right: b[r2],
    leftLabel: `Radar ${pol}: ${niceDate(d[r1].date)} ${w.notes[r1]}`, rightLabel: `Radar ${pol}: ${niceDate(d[r2].date)} ${w.notes[r2]}`,
    hint: `The slider compares two dates. Left of the line: radar image on ${niceDate(d[r1].date)}. Right of the line: ${niceDate(d[r2].date)}. Same brightness scale on both sides. `
      + (isBaselineStory(s) && state.pair === 'normal'
        ? 'Both images are from before the event, so very little should change: this is the normal variation.'
        : 'Click the image to read the values at that point.'),
  };
}

function drawLegend() {
  const s = state.scene;
  if (state.view === 'change') {
    const lim = s.display.change_limit_db;
    $('legend').innerHTML = `<div>${state.rel && s.images.change_rel ? 'Change relative to window median' : 'Change in radar return'}</div>`
      + '<div class="bar" style="background:linear-gradient(90deg,#2166ac,#f7f7f7,#b2182b)"></div>'
      + `<div class="ticks"><span>-${lim} dB darker</span><span>0</span><span>+${lim} dB brighter</span></div>`;
  } else {
    const [lo, hi] = s.display.stretch_db[state.pol];
    $('legend').innerHTML = `<div>${state.pol.toUpperCase()} radar return (gamma0)</div>`
      + '<div class="bar" style="background:linear-gradient(90deg,#000,#fff)"></div>'
      + `<div class="ticks"><span>${lo} dB</span><span>${hi} dB</span></div>`;
  }
}

// One date at a time (date slider and playback)
let seriesLayers = [], playTimer = null;

function showDate() {
  const s = state.scene, d = s.series.dates[state.dateIndex];
  seriesLayers.forEach((l, i) => l.setOpacity(i === state.dateIndex ? Number($('opacity').value) : 0));
  $('dateslider').value = state.dateIndex;
  $('datelabel').textContent = `${niceDate(d.date)} ${phaseText(d)}`;
  $('leftlabel').textContent = `${state.pol.toUpperCase()} ${niceDate(d.date)} ${phaseText(d)}`;
}
function clearSeries() {
  seriesLayers.forEach((l) => map.removeLayer(l));
  seriesLayers = [];
  $('mapwrap').classList.remove('single');
}
function stopPlay() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  $('play').textContent = 'Play all dates';
}
function startPlay() {
  if (state.view !== 'backscatter' || state.pair !== 'series') {
    state.view = 'backscatter';
    state.pair = 'series';
    syncButtons();
    refreshLayers();
  }
  stopPlay();
  playTimer = setInterval(() => {
    state.dateIndex = (state.dateIndex + 1) % state.scene.series.dates.length;
    showDate();
  }, 1300);
  $('play').textContent = 'Stop';
}
$('play').addEventListener('click', () => (playTimer ? stopPlay() : startPlay()));
$('dateslider').addEventListener('input', () => {
  stopPlay();
  state.dateIndex = Number($('dateslider').value);
  showDate();
});

function refreshLayers() {
  const s = state.scene;
  const base = `scenes/${s.id}/`;
  $('relgroup').hidden = !(state.view === 'change' && s.images && s.images.change_rel);
  for (const b of $('relgroup').querySelectorAll('button')) b.classList.toggle('on', (b.dataset.rel === 'true') === state.rel);
  for (const id of ['viewgroup', 'polgroup', 'pairgroup', 'play', 'dategroup', 'opacitygroup']) $(id).style.display = s.objects_only ? 'none' : '';
  if (s.objects_only) {
    for (const side of ['left', 'right']) {
      if (overlays[side]) map.removeLayer(overlays[side]);
      overlays[side] = null;
    }
    clearSeries();
    stopPlay();
    $('mapwrap').classList.add('single');
    $('leftlabel').textContent = 'Map cells: values already computed for each cell';
    $('hint').textContent = 'This case has no radar image on the map: each square is one analysis cell. Choose how to colour the cells, switch layers on or off, and click a cell to read its values.';
    $('legend').hidden = true;
    return;
  }
  $('legend').hidden = false;
  if (state.view === 'none') {   // radar layer switched off: base map, outlines and cells only
    for (const side of ['left', 'right']) {
      if (overlays[side]) map.removeLayer(overlays[side]);
      overlays[side] = null;
    }
    clearSeries();
    stopPlay();
    $('mapwrap').classList.add('single');
    for (const id of ['pairgroup', 'play', 'dategroup']) $(id).style.display = 'none';
    $('leftlabel').textContent = 'Radar layer off';
    $('hint').textContent = 'Radar layer off: the base map, outlines and cells stay. Choose Radar image or Change map to show the radar again.';
    $('legend').hidden = true;
    return;
  }
  const seriesMode = state.view === 'backscatter' && state.pair === 'series';
  const opacity = Number($('opacity').value);
  const w = wording(s);
  $('pairgroup').querySelector('[data-pair=normal]').textContent = w.pairs.normal;
  $('pairgroup').querySelector('[data-pair=event]').textContent = w.pairs.event;
  $('pairgroup').style.display = state.view === 'change' ? 'none' : '';
  $('play').style.display = state.view === 'change' ? 'none' : '';
  $('dategroup').style.display = seriesMode ? '' : 'none';
  for (const side of ['left', 'right']) {
    if (overlays[side]) map.removeLayer(overlays[side]);
    overlays[side] = null;
  }
  clearSeries();
  if (seriesMode) {
    seriesLayers = s.series.dates.map((d) => L.imageOverlay(base + d.images[state.pol] + ver(s), s.bounds, { pane: 'single', opacity: 0, interactive: false }).addTo(map));
    $('mapwrap').classList.add('single');
    $('dateslider').max = seriesLayers.length - 1;
    state.dateIndex = Math.min(state.dateIndex, seriesLayers.length - 1);
    $('hint').textContent = `One date at a time, ${seriesLayers.length} dates. Move the date slider or press Play.`;
    showDate();
    drawLegend();
    return;
  }
  stopPlay();
  const cur = currentLayers();
  for (const side of ['left', 'right']) {
    overlays[side] = L.imageOverlay(base + cur[side] + ver(s), s.bounds, { pane: side, opacity, interactive: false }).addTo(map);
  }
  $('leftlabel').textContent = cur.leftLabel;
  $('rightlabel').textContent = cur.rightLabel;
  $('hint').textContent = cur.hint;
  updateFixedHint();
  drawLegend();
  clipPanes();
}

function drawPins() {
  const s = state.scene;
  pinLayer.clearLayers();
  boxLayer.clearLayers();
  const marker = (lat, lon, fill) => L.circleMarker([lat, lon], {
    pane: 'pins', radius: 7, color: '#fff', weight: 2, fillColor: fill, fillOpacity: 1, bubblingMouseEvents: false,
  });
  const gaugeIcon = L.divIcon({ className: 'gaugeicon', html: '▼', iconSize: [14, 14], iconAnchor: [7, 7] });
  for (const e of s.evidence.filter((x) => x.type === 'gauge')) {
    L.marker([e.lat, e.lon], { icon: gaugeIcon, pane: 'pins', keyboard: false, title: e.label }).addTo(pinLayer);
  }
  for (const z of s.zones || []) {
    const style = ZONE_STYLE[z.kind] || ZONE_STYLE.target;
    L.rectangle(z.bounds, { pane: 'pins', color: style.color, weight: 2, fill: false, interactive: false })
      .bindTooltip(`${z.name} (${style.label})`, { permanent: true, direction: 'top', className: 'zonetip' }).addTo(boxLayer);
  }
  const area = (b) => (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]);
  for (const other of state.index) {
    if (other.id === s.id || area(other.bounds) >= area(s.bounds)) continue;
    if (!L.latLngBounds(s.bounds).intersects(L.latLngBounds(other.bounds))) continue;
    L.rectangle(other.bounds, { pane: 'pins', color: '#12306b', weight: 2, fill: true, fillOpacity: 0, dashArray: '6 4', bubblingMouseEvents: false })
      .bindTooltip(`${other.short_title} (click to open)`, { permanent: true, direction: 'center', className: 'zonetip' }).on('click', () => selectScene(other.id)).addTo(boxLayer);
  }
}

// ---------------------------------------------------------------- map objects (cells, fields, official outlines, optical pictures)
// Each layer keeps its identity: official record, optical context, hand-drawn field, analysis cell, data window.
const NO_DATA = '#9a9a9a';
function mix(a, b, t) {
  const h = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [h(a), h(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}
function rampColour(st, v) {
  if (v === null || v === undefined) return null;
  if (st.mode === 'diverging') {
    const t = Math.max(-1, Math.min(1, v / st.limit));
    return t >= 0 ? mix('#f7f7f7', '#b2182b', t) : mix('#f7f7f7', '#2166ac', -t);
  }
  const t = Math.max(0, Math.min(1, (v - st.min) / (st.max - st.min)));
  return st.mode === 'steps' ? mix('#efe3f5', '#4a1486', t) : mix('#fff5eb', '#7f2704', t);
}
function activeStyle(lay) {
  const styles = lay.styles || [{ mode: 'outline', color: '#12306b' }];
  return styles.length > 1 ? styles[Math.min(state.colour, styles.length - 1)] : styles[0];
}
function featureStyle(lay, props) {
  const st = activeStyle(lay);
  if (st.mode === 'outline') {
    return { color: st.color, weight: 2.5, dashArray: st.dash || null, fill: Boolean(lay.series || lay.popup), fillOpacity: 0.06, fillColor: st.color };
  }
  let fill;
  if (st.mode === 'class') fill = (st.classes[props[st.property]] || {}).color || NO_DATA;
  else fill = rampColour(st, props[st.property]);
  if (fill === null) {
    return st.mode === 'steps'
      ? { color: '#c9ccd1', weight: 0.4, fillOpacity: 0, fill: true }
      : { color: '#ffffff', weight: 0.4, fillColor: NO_DATA, fillOpacity: 0.55 };
  }
  return { color: '#ffffff', weight: 0.3, fillColor: fill, fillOpacity: 0.85 };
}
function fmtValue(lay, key, unit, v) {
  if (v === null || v === undefined) return 'no data';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return unit === 'dB' ? db(v) : Number.isInteger(v) ? String(v) : v.toFixed(3);
  for (const st of lay.styles || []) if (st.mode === 'class' && st.property === key && st.classes[v]) return st.classes[v].label;
  return String(v).replace(/_/g, ' ');
}
function propsPopup(lay, props) {
  const rows = (lay.popup || []).map((f) => (f.label
    ? `<tr><td>${esc(f.label)}</td><td class="num">${esc(fmtValue(lay, f.key, f.unit, props[f.key]))}</td></tr>`
    : `<tr><td colspan="2">${esc(fmtValue(lay, f.key, f.unit, props[f.key]))}</td></tr>`)).join('');
  return `<b>${esc(lay.name)}</b>${props.id ? ` <span class="small">${esc(props.id)}</span>` : ''}<table class="pt">${rows}</table>`
    + '<span class="small">Values of this one cell. Categories are threshold views, not confirmed causes.</span>';
}

// A small line chart with its own axis and unit. lines = [{vals, colour, dash, label}]
function lineChart(isoTimes, lines, unit, W = 300, H = 120) {
  const L0 = 40, R = 14, T = 10, B = 22;
  const times = isoTimes.map((t) => Date.parse(t));
  const all = lines.flatMap((l) => l.vals).filter((v) => v !== null);
  if (!all.length) return '<p class="small">No values.</p>';
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.1 || 0.5;
  lo -= pad; hi += pad;
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const x = (t) => L0 + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - L0 - R);
  const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const fmt = (v) => (unit === 'dB' ? `${v.toFixed(0)} dB` : v.toFixed(2));
  const paths = lines.map((l) => {
    const pts = l.vals.map((v, i) => (v === null ? null : [x(times[i]), y(v)])).filter(Boolean);
    return `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}" fill="none" stroke="${l.colour}" stroke-width="2"${l.dash ? ' stroke-dasharray="5 3"' : ''}/>`
      + pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${l.colour}"/>`).join('');
  }).join('');
  const every = Math.ceil(isoTimes.length / 4);
  const last = isoTimes.length - 1;
  const ticks = isoTimes.map((t, i) => ((i % every && i !== last) || (i !== last && i !== 0 && last - i < every / 2) ? ''
    : `<text x="${x(times[i])}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === last ? 'end' : 'middle'}" font-size="10" fill="#5b6676">${shortDate(t.slice(0, 10))}</text>`)).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`
    + `<line x1="${L0}" x2="${L0}" y1="${T}" y2="${H - B}" stroke="#5b6676"/>`
    + `<text x="${L0 - 4}" y="${y(hi - pad) + 4}" text-anchor="end" font-size="10" fill="#5b6676">${fmt(hi - pad)}</text>`
    + `<text x="${L0 - 4}" y="${y(lo + pad) + 3}" text-anchor="end" font-size="10" fill="#5b6676">${fmt(lo + pad)}</text>`
    + paths + ticks + '</svg>';
}
function fieldPopup(id) {
  const o = state.scene.object_series[id];
  let html = `<b>Field ${esc(id)}</b>`;
  if (o.radar) {
    html += '<p class="small">Radar return, median of the field\'s 100 m cells (dB). Solid HH, dashed HV. UTC dates.</p>'
      + lineChart(o.radar.dates, [{ vals: o.radar.hh, colour: '#12306b' }, { vals: o.radar.hv, colour: '#f5a623', dash: true }], 'dB');
  } else {
    html += '<p class="warn">Excluded before any radar comparison: only one complete 100 m cell. No radar values, not zero.</p>';
  }
  const ok = o.optical.pass.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  html += '<p class="small">Optical greenness (NDVI, no unit), clear dates only. Separate axis.</p>'
    + lineChart(ok.map((i) => o.optical.dates[i]), [{ vals: ok.map((i) => o.optical.ndvi[i]), colour: '#1e7d4f' }], '');
  if (o.endpoint) {
    const e = o.endpoint;
    html += `<table class="pt"><tr><td>Greenness change, 21 Jun to 20 Aug</td><td class="num">${e.ndvi_change > 0 ? '+' : ''}${e.ndvi_change.toFixed(2)}</td></tr>`
      + `<tr><td>HH change, 20 Jun to 19 Aug</td><td class="num">${db(e.hh_change_db)}</td></tr>`
      + `<tr><td>HV change, 20 Jun to 19 Aug</td><td class="num">${db(e.hv_change_db)}</td></tr>`
      + `<tr><td>100 m cells</td><td class="num">${e.cells_100m}</td></tr></table>`;
  }
  return `${html}<span class="small">Optical images stop on 20 Aug. Lines join observations only.</span>`;
}

// ---------------------------------------------------------------- candidate cells: a stated rule, the cells that pass it, and what they overlap
// Result first: cells passing the rule are highlighted on top of the images, which stay underneath for checking.
const cand = { on: false, measure: 0, dir: 'darker', thr: 3, geo: null, features: [] };
function candSpec() { return state.scene.candidates; }
function candMeasure() { return candSpec().measures[cand.measure]; }
// The value of the current measure in one cell, or null when the cell is outside the common quality support.
function candValue(props) {
  const vp = candSpec().valid_property;
  if (vp && !props[vp]) return null;
  return props[candMeasure().key];
}
function passes(v) {
  if (v === null || v === undefined) return null;
  if (cand.dir === 'darker') return v <= -cand.thr;
  if (cand.dir === 'brighter') return v >= cand.thr;
  return Math.abs(v) >= cand.thr;
}
function candStyle(props) {
  const v = candValue(props), p = passes(v);
  if (p === null) return { stroke: false, fill: true, fillColor: NO_DATA, fillOpacity: 0.45 };
  if (!p) return { stroke: false, fill: true, fillOpacity: 0 };
  return { color: '#ffffff', weight: 0.3, fill: true, fillColor: v < 0 ? '#5e3c99' : '#e66101', fillOpacity: 0.8 };
}
function candStats() {
  const m = candMeasure(), ref = m.reference;
  let valid = 0, pass = 0;
  const groups = ref ? { target: [0, 0], background: [0, 0] } : null;
  for (const f of cand.features) {
    const p = passes(candValue(f.properties));
    if (p === null) continue;
    valid += 1;
    if (p) pass += 1;
    if (ref) {
      const g = f.properties[ref.property] === ref.target ? 'target' : f.properties[ref.property] === ref.background ? 'background' : null;
      if (g) { groups[g][0] += 1; if (p) groups[g][1] += 1; }
    }
  }
  return { valid, pass, groups };
}
// The threshold at which a given share of background cells would pass (the team's evaluation used about 5%).
function thresholdForBackgroundShare(share) {
  const m = candMeasure(), ref = m.reference;
  if (!ref) return null;
  const vals = cand.features.filter((f) => f.properties[ref.property] === ref.background && candValue(f.properties) !== null)
    .map((f) => candValue(f.properties));
  if (!vals.length) return null;
  const key = cand.dir === 'darker' ? vals.map((v) => -v) : cand.dir === 'brighter' ? vals : vals.map(Math.abs);
  key.sort((a, b) => b - a);
  return key[Math.max(0, Math.floor(share * key.length) - 1)];
}
function renderCandPanel() {
  // Builds the controls once per case. Moving the slider or pressing a button only updates them in place,
  // so a slider is never replaced while it is being dragged.
  const spec = candSpec(), box = $('candpanel');
  if (!spec) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="candhead"><label class="chk"><input type="checkbox" id="candon"${cand.on ? ' checked' : ''}> <b>Highlight cells that pass a rule</b></label></div>
    <div class="candbody" id="candbody"${cand.on ? '' : ' hidden'}>
      <div class="group"><span>Measure</span>${spec.measures.map((x, i) => `<button data-m="${i}">${esc(x.short || x.label)}</button>`).join('')}</div>
      <div class="group"><span>Radar return</span>${['darker', 'brighter', 'either'].map((d) => `<button data-d="${d}">${d === 'darker' ? '<span class="sw" style="background:#5e3c99"></span> Darker' : d === 'brighter' ? '<span class="sw" style="background:#e66101"></span> Brighter' : 'Either'}<span class="dirmeaning" data-dm="${d}"></span></button>`).join('')}</div>
      <p class="small">The image controls above choose the background picture; this rule chooses which cells are highlighted. They can differ.</p>
      <div class="group"><span>Threshold</span><input type="range" id="candthr" aria-label="Threshold"> <b id="candthrlabel"></b></div>
      <p class="candsum" id="candsum"></p>
      <p class="candsum" id="candref"></p>
      <p class="candsum"><button id="candfive"></button></p>
      <p class="small" id="candnote"></p>
      <p><button id="canddl"></button> <span class="small">Candidates for checking, not a confirmed ${esc(spec.not_a || 'map')}. Grey cells have no data and are not counted.</span></p>
    </div>`;
  $('candon').addEventListener('change', (e) => {
    cand.on = e.target.checked;
    state.layerOn[candSpec().layer] = cand.on;   // the cells go on and off with the highlight
    renderLayerControls();
    $('candbody').hidden = !cand.on;
    drawObjects();
  });
  for (const b of box.querySelectorAll('[data-m]')) {
    b.addEventListener('click', () => {
      const oldUnit = candMeasure().unit;
      cand.measure = Number(b.dataset.m);
      const m = candMeasure();
      cand.dir = m.dir || cand.dir;
      if (m.unit !== oldUnit) cand.thr = m.default ?? 3;   // keep the user's threshold unless the unit changes
      if (m.sync && state.view !== 'none') {   // show the same polarisation and period in the background
        Object.assign(state, m.sync);
        syncButtons();
        refreshLayers();
      }
      updateCandPanel(true);
    });
  }
  for (const b of box.querySelectorAll('[data-d]')) b.addEventListener('click', () => { cand.dir = b.dataset.d; updateCandPanel(); });
  $('candthr').addEventListener('input', (e) => { cand.thr = Number(e.target.value); updateCandPanel(); });
  $('candfive').addEventListener('click', (e) => { cand.thr = Number(e.currentTarget.dataset.v); updateCandPanel(true); });
  $('canddl').addEventListener('click', downloadCand);
  updateCandPanel(true);
}
function updateCandPanel(resetSlider = false) {
  const spec = candSpec();
  if (!spec || !$('candthr')) return;
  if (cand.geo) cand.geo.setStyle((f) => candStyle(f.properties));
  const m = candMeasure(), unit = m.unit === undefined ? 'dB' : m.unit, u = unit ? ` ${unit}` : '';
  for (const b of $('candpanel').querySelectorAll('[data-m]')) b.classList.toggle('on', Number(b.dataset.m) === cand.measure);
  for (const b of $('candpanel').querySelectorAll('[data-d]')) b.classList.toggle('on', b.dataset.d === cand.dir);
  // Link the radar direction to what it is consistent with on the ground in this period (where we have that evidence).
  for (const sp of $('candpanel').querySelectorAll('.dirmeaning')) {
    const t = (m.meaning_short || {})[sp.dataset.dm];
    sp.textContent = t ? ` — ${t}` : '';
  }
  const slider = $('candthr');
  if (resetSlider) {
    Object.assign(slider, { min: m.min ?? 0.5, max: m.max ?? 8, step: m.step ?? 0.01 });
    slider.value = cand.thr;
  }
  $('candthrlabel').textContent = `${cand.thr}${u}`;
  const st = candStats();
  const area = (st.pass * (spec.cell_ha || 1)).toFixed(spec.cell_ha < 1 ? 1 : 0);
  const rule = `${m.label}: radar return ${cand.dir === 'darker' ? 'gets darker by' : cand.dir === 'brighter' ? 'gets brighter by' : 'changes by'} at least ${cand.thr}${u}`;
  $('candsum').innerHTML = `<b>${st.pass}</b> of ${st.valid} cells with data pass (${area} ha). Rule: ${esc(rule)}.`;
  const ref = m.reference;
  const pctOf = (g) => (g[0] ? `${Math.round(g[1] / g[0] * 100)}% of ${g[0]}` : 'none');
  // Say what each share means in full: a share of a reference group, not a probability or an accuracy.
  const share = (g) => (g[0] ? `<b>${Math.round(g[1] / g[0] * 100)}%</b> (${g[1]} of ${g[0]})` : 'none');
  $('candref').innerHTML = ref
    ? `Of the cells labelled <i>${esc(ref.target_label.replace(/\s*\(.*\)$/, '').toLowerCase())}</i>, ${share(st.groups.target)} pass this rule. `
      + `Of the cells labelled <i>${esc(ref.background_label.replace(/\s*\(.*\)$/, '').toLowerCase())}</i>, ${share(st.groups.background)} also pass. `
      + '<span class="small">These are shares of each reference group, not a probability or an accuracy.</span>'
    : '';
  // What darker or brighter means in this period, so the radar direction links to the change on the ground.
  const meaning = (m.meaning || {})[cand.dir];
  $('candnote').textContent = (meaning ? `${meaning} ` : '') + (ref ? ref.note || '' : '');
  const five = ref && cand.dir !== 'either' ? thresholdForBackgroundShare(0.05) : null;
  const fiveBtn = $('candfive');
  fiveBtn.hidden = five === null || five === undefined;
  if (!fiveBtn.hidden) {
    fiveBtn.dataset.v = Math.round(five * 100) / 100;
    fiveBtn.textContent = `Set threshold so about 5% of the ${ref.background_label.replace(/\s*\(.*\)$/, '').toLowerCase()} passes (${five.toFixed(2)}${u})`;
  }
  $('canddl').textContent = `Download the ${st.pass} cells (GeoJSON)`;
}
function downloadCand() {
  const m = candMeasure(), s = state.scene;
  const rule = `${m.label}; ${cand.dir}; threshold ${cand.thr}${m.unit === '' ? '' : ' dB'}`;
  const feats = cand.features.filter((f) => passes(candValue(f.properties)) === true)
    .map((f) => ({ ...f, properties: { ...f.properties, rule, status: 'candidate for checking, not verified' } }));
  const fc = { type: 'FeatureCollection', name: `${s.id} candidate cells`, rule, source: `NISAR Change Explorer, case ${s.id}`, features: feats };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }));
  a.download = `${s.id}_candidates_${m.key}_${cand.dir}_${cand.thr}.geojson`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function showSelection(html) {
  const box = $('selection');
  box.innerHTML = `<button class="closesel" aria-label="Close">Close</button>${html}`;
  box.hidden = false;
  box.querySelector('.closesel').addEventListener('click', () => { box.hidden = true; });
  if (!window.matchMedia('(max-width: 880px)').matches) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const geoCache = {};
async function loadGeo(url) {
  if (!geoCache[url]) geoCache[url] = fetch(url, { cache: 'no-cache' }).then((r) => r.json());
  return geoCache[url];
}
async function drawObjects() {
  const s = state.scene;
  objectLayer.clearLayers();
  for (const lay of s.layers || []) {
    if (!state.layerOn[lay.id]) continue;
    const url = `scenes/${s.id}/${lay.file}`;
    if (lay.type === 'image') {
      L.imageOverlay(url + ver(s), lay.bounds, { pane: 'optical', opacity: 1, interactive: false }).addTo(objectLayer);
      continue;
    }
    const gj = await loadGeo(url);
    if (state.scene !== s) return;
    const st = activeStyle(lay);
    const isCand = cand.on && s.candidates && s.candidates.layer === lay.id;
    if (s.candidates && s.candidates.layer === lay.id) cand.features = gj.features;
    const geo = L.geoJSON(gj, {
      pane: st.mode === 'outline' || st.mode === 'point' ? 'pins' : 'objects',
      bubblingMouseEvents: false,
      interactive: Boolean(lay.series || lay.popup),
      style: (f) => (isCand ? candStyle(f.properties) : featureStyle(lay, f.properties)),
      pointToLayer: (f, ll) => L.circleMarker(ll, { pane: 'pins', radius: 7, color: '#fff', weight: 2, fillColor: st.color || '#5b6676', fillOpacity: 1, bubblingMouseEvents: false }),
      onEachFeature: (f, layer) => {
        if (lay.label_property && layer.getBounds) {
          L.marker(layer.getBounds().getSouthEast(), { pane: 'pins', interactive: false, keyboard: false,
            icon: L.divIcon({ className: 'fieldlabel', html: esc(String(f.properties[lay.label_property])), iconSize: [16, 16], iconAnchor: [-2, -2] }) }).addTo(objectLayer);
        }
        if (lay.series && s.object_series) {
          const p = f.properties;
          layer.bindPopup(`<b>Field ${esc(p.id)}</b>: optical greenness ${esc(p.optical_label)}.<br><span class="small">Curves are shown in the panel on the right.</span>`);
          layer.on('click', () => showSelection(fieldPopup(p.id)));
        }
        else if (lay.popup) layer.bindPopup(() => propsPopup(lay, f.properties), { maxWidth: 340 });
      },
    }).addTo(objectLayer);
    if (s.candidates && s.candidates.layer === lay.id) cand.geo = isCand ? geo : null;
  }
  $('layerlegend').innerHTML = layerLegend();
  $('colourgroup').style.display = cand.on ? 'none' : '';
  $('legend').hidden = Boolean(s.objects_only);
  renderCandPanel();
  updateFixedHint();
}
function updateFixedHint() {
  const note = ' Outlines and cells stay fixed while you drag the line; only the radar images swipe.';
  const s = state.scene;
  const base = $('hint').textContent.replace(note, '');
  $('hint').textContent = base + (!s.objects_only && (s.layers || []).some(l => l.type === 'geojson' && state.layerOn[l.id]) ? note : '');
}
function layerLegend() {
  const s = state.scene;
  const parts = [];
  for (const lay of s.layers || []) {
    if (!state.layerOn[lay.id]) continue;
    if (lay.type === 'image') { parts.push(`<div><span class="sw" style="background:linear-gradient(90deg,#6b8e4e,#c9b98f)"></span>${esc(lay.name)}</div>`); continue; }
    if (cand.on && s.candidates && s.candidates.layer === lay.id) {
      parts.push('<div><span class="sw" style="background:#5e3c99"></span>Passes the rule: radar darker</div><div><span class="sw" style="background:#e66101"></span>Passes the rule: radar brighter</div>'
        + `<div><span class="sw" style="background:${NO_DATA}"></span>No data</div><div class="small">Clear cells do not pass the rule; they may still have changed.</div>`);
      continue;
    }
    const st = activeStyle(lay);
    if (st.mode === 'outline') parts.push(`<div><span class="sw line" style="border-color:${st.color};border-style:${st.dash ? 'dashed' : 'solid'}"></span>${esc(lay.name)}</div>`);
    else if (st.mode === 'point') parts.push(`<div><span class="sw dot" style="background:${st.color}"></span>${esc(lay.name)}</div>`);
    else if (st.mode === 'class') {
      parts.push(`<div><b>${esc(st.name)}</b></div>` + Object.values(st.classes).map((c) => `<div><span class="sw" style="background:${c.color}"></span>${esc(c.label)}</div>`).join(''));
    } else {
      const grad = st.mode === 'diverging' ? '#2166ac,#f7f7f7,#b2182b' : st.mode === 'steps' ? '#efe3f5,#4a1486' : '#fff5eb,#7f2704';
      const lo = st.mode === 'diverging' ? `-${st.limit}` : st.min, hi = st.mode === 'diverging' ? `+${st.limit}` : st.max;
      parts.push(`<div><b>${esc(st.name)}</b></div><div class="bar" style="background:linear-gradient(90deg,${grad})"></div>`
        + `<div class="ticks"><span>${lo}${st.unit ? ` ${st.unit}` : ''}</span><span>${hi}${st.unit ? ` ${st.unit}` : ''}</span></div>`
        + `<div><span class="sw" style="background:${st.mode === 'steps' ? '#fff;border:1px solid #c9ccd1' : NO_DATA}"></span>${esc(st.null_label || 'No data')}</div>`);
    }
  }
  if ((s.evidence || []).some((e) => e.type === 'gauge')) {
    parts.push('<div><span class="gaugeicon inkey">▼</span>River gauge (water-level station); its record is charted in the panel</div>');
  }
  return parts.length ? `<div class="laylegend"><b>Map key</b>${parts.join('')}</div>` : '';
}
function renderLayerControls() {
  const s = state.scene;
  const lays = s.layers || [];
  const tied = s.candidates && cand.on ? s.candidates.layer : null;   // cells shown by the highlight switch
  $('layergroup').innerHTML = lays.length ? '<span>Map layers</span>' + lays.map((l) => (l.id === tied
    ? `<label class="chk" title="Shown while the highlight below is on"><input type="checkbox" checked disabled> ${esc(l.name)} (with the highlight)</label>`
    : `<label class="chk"><input type="checkbox" data-layer="${esc(l.id)}"${state.layerOn[l.id] ? ' checked' : ''}> ${esc(l.name)}</label>`)).join('') : '';
  const multi = lays.find((l) => (l.styles || []).length > 1);
  $('colourgroup').innerHTML = multi ? '<span>Colour cells by</span>' + multi.styles.map((st, i) => `<button data-colour="${i}" class="${i === state.colour ? 'on' : ''}">${esc(st.name)}</button>`).join('') : '';
  for (const c of $('layergroup').querySelectorAll('input')) {
    c.addEventListener('change', () => { state.layerOn[c.dataset.layer] = c.checked; refreshLayers(); drawObjects(); });
  }
  for (const b of $('colourgroup').querySelectorAll('button')) {
    b.addEventListener('click', () => { state.colour = Number(b.dataset.colour); renderLayerControls(); drawObjects(); });
  }
  const credits = lays.filter((l) => l.credit && state.layerOn[l.id]).map((l) => esc(l.credit)).join(' ');
  $('layercredit').textContent = '';
  $('layercredit').innerHTML = credits;
}

// ---------------------------------------------------------------- read values at a point
const imageCache = {};

function pixels(url) {
  if (!imageCache[url]) {
    imageCache[url] = new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        c.width = im.naturalWidth;
        c.height = im.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(im, 0, 0);
        resolve(ctx.getImageData(0, 0, c.width, c.height));
      };
      im.onerror = reject;
      im.src = url;
    });
  }
  return imageCache[url];
}
// The display PNGs are a linear grey scale of dB, so a grey level converts back to dB (in steps of about 0.1 dB).
function sampleDb(img, fx, fy, lo, hi) {
  const col = Math.floor(fx * img.width), row = Math.floor(fy * img.height);
  let sum = 0, n = 0;
  for (let y = row - 2; y <= row + 2; y += 1) {
    for (let x = col - 2; x <= col + 2; x += 1) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const k = (y * img.width + x) * 4;
      if (img.data[k + 3] === 0) continue;
      sum += 10 ** ((lo + Math.round(img.data[k] * 254 / 255) / 254 * (hi - lo)) / 10);
      n += 1;
    }
  }
  return n ? 10 * Math.log10(sum / n) : null;
}
map.on('click', async (ev) => {
  const s = state.scene;
  if (!s || s.objects_only || !L.latLngBounds(s.bounds).contains(ev.latlng)) return;
  const popup = L.popup({ maxWidth: 340 }).setLatLng(ev.latlng).setContent('Reading values...').openOn(map);
  const project = (ll) => L.CRS.EPSG3857.project(L.latLng(ll));
  const sw = project(s.bounds[0]), ne = project(s.bounds[1]), p = project(ev.latlng);
  const fx = (p.x - sw.x) / (ne.x - sw.x), fy = (ne.y - p.y) / (ne.y - sw.y);
  const read = async (file, pol) => sampleDb(await pixels(`scenes/${s.id}/${file}${ver(s)}`), fx, fy, ...s.display.stretch_db[pol]);
  // Reuse the series image of a key date when there is one, so each image is fetched once.
  const roleFile = (pol, r) => {
    const hit = s.series.dates.find((d) => d.date === s.dates[r].date);
    return hit ? hit.images[pol] : s.images.backscatter[pol][r];
  };
  let role, hh, hv;
  try {
    role = {};
    for (const pol of ['hh', 'hv']) for (const r of ROLES) role[`${pol}_${r}`] = await read(roleFile(pol, r), pol);
    hh = await Promise.all(s.series.dates.map((d) => read(d.images.hh, 'hh')));
    hv = await Promise.all(s.series.dates.map((d) => read(d.images.hv, 'hv')));
  } catch (err) {
    popup.setContent('Could not read the images.');
    return;
  }
  if (Object.values(role).some((v) => v === null)) { popup.setContent('No radar data at this point.'); return; }
  const change = (pol, a, b) => db(role[`${pol}_${b}`] - role[`${pol}_${a}`], 1);
  const w = wording(s);
  const relativeNote = state.view === 'change' && state.rel && s.display.relative ? `<br><span class="small">Values above are raw changes. The map shows them minus the window median (HH ${db(s.display.relative.offsets.hh.event)} and HV ${db(s.display.relative.offsets.hv.event)} across the event).</span>` : '';
  popup.setContent('<b>Radar return at this point</b><br>'
    + `<span class="small">${Math.abs(ev.latlng.lat).toFixed(4)} ${ev.latlng.lat < 0 ? 'S' : 'N'}, ${Math.abs(ev.latlng.lng).toFixed(4)} ${ev.latlng.lng < 0 ? 'W' : 'E'}. Averaged over a patch about ${Math.round(s.display.posting_m * 5)} m across.</span>`
    + relChart(s.series.dates, hh, hv, 300, 120)
    + `<table class="pt"><tr><th></th><th>${esc(w.short[0])}<br>${w.span[0]}</th><th>${esc(w.short[1])}<br>${w.span[1]}</th></tr>`
    + `<tr><td>HH (solid)</td><td class="num">${change('hh', 'baseline_1', 'baseline_2')}</td><td class="num"><b>${change('hh', 'baseline_2', 'after')}</b></td></tr>`
    + `<tr><td>HV (dashed)</td><td class="num">${change('hv', 'baseline_1', 'baseline_2')}</td><td class="num"><b>${change('hv', 'baseline_2', 'after')}</b></td></tr></table>`
    + '<span class="small">Values at this point only, read from the display images in 0.1 dB steps. They are not the group statistics in the panel. A change here is a candidate for follow-up, not a confirmed cause.</span>' + relativeNote);
});

// ---------------------------------------------------------------- evidence card
function classTable(s, w) {
  if (!s.class_table) return '';
  const rows = s.class_table.map((r) => `<tr><td>${esc(w.short[r.interval])}: ${esc(r.label)}</td><td class="num">${r.cells}</td>`
    + `<td class="num"><b>${db(r.hh_db)}</b></td><td class="num"><b>${db(r.hv_db)}</b></td></tr>`).join('');
  return '<p class="small"><b>Group statistics</b> (median over all cells in each group, not a value at one point):</p>'
    + `<table><tr><th>Group</th><th>100 m cells</th><th>HH change</th><th>HV change</th></tr>${rows}</table>`
    + `<p class="small">${esc(s.class_table_note || '')}</p>`;
}
function extraTables(s, step) {
  return (s.tables || []).filter((t) => t.step === step).map((t) => `<p><b>${esc(t.title)}</b></p><div class="tablewrap"><table>`
    + `<tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`
    + t.rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td class="num">${esc(c)}</td>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')
    + `</table></div><p class="small">${esc(t.note || '')}</p>`).join('');
}

// Six questions, in the order a user would ask them.
function renderCard() {
  const s = state.scene, w = s.objects_only ? null : wording(s);
  const list = (items) => `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
  const sources = (s.sources || []).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>`).join('; ');
  const checks = Object.values(s.checks || {}).map((c) => `<div class="check"><b class="${c.value ? 'y' : 'n'}">${c.value ? 'Yes' : 'No'}</b><span>${esc(c.question)} ${esc(c.text)}</span></div>`).join('');
  const sameVersion = s.checks && s.checks.same_processing_version;
  const mixed = sameVersion && !sameVersion.value ? '<p class="warn">The dates use different processing versions. Read small differences with care.</p>' : '';
  const images = (s.evidence || []).filter((e) => e.type === 'image').map((e) => `<figure><img src="scenes/${s.id}/${esc(e.file)}${ver(s)}" alt="${esc(e.alt || e.caption)}" loading="lazy">`
    + `<figcaption>${esc(e.caption)} <span class="small">${esc(e.credit)}.</span></figcaption></figure>`).join('');
  const gauges = (s.evidence || []).filter((e) => e.type === 'gauge').map((e) => gaugeChart(e, s)).join('');
  const agreement = s.agreement || (s.checks.independent_evidence ? s.checks.independent_evidence.text : '');
  const downloads = (s.downloads || []).map((d) => `<li><a href="scenes/${s.id}/${esc(d.file)}" download>${esc(d.label)}</a><br><span class="small">${esc(d.note || '')}</span></li>`).join('');
  const dataUsed = s.objects_only ? '' : `<details><summary class="small">Data used</summary><p class="small">${esc(s.product)}. Track ${s.track}, frame ${s.frame}, ${esc(s.direction)}.<br>`
    + `${ROLES.map((r) => `${s.dates[r].date} ${s.dates[r].time_utc} UTC, ${s.dates[r].crid}: ${esc(s.dates[r].granule)}`).join('<br>')}</p></details>`;

  $('card').innerHTML = `
    <h3>${esc(s.title)}</h3>
    <p class="meta"><span class="tag">${esc((s.theme || '').split(':')[0])}</span> ${esc(s.place)}.</p>
    <p class="small"><b>In this case you can:</b> ${[
      s.series ? `Radar images on ${s.series.dates.length} dates` : '',
      s.images && s.images.change ? 'Change map' : '',
      (s.layers || []).some(l => l.type === 'image') ? 'Optical image' : '',
      s.object_series ? 'Click a field for its curves' : '',
      s.candidates ? 'Highlight cells by a rule and download them' : '',
      (s.evidence || []).some(e => e.type === 'gauge') ? 'River gauges' : '',
      s.images && s.images.change_rel ? 'Relative change view' : ''
    ].filter(Boolean).join(' · ')}</p>
    ${s.headline ? `<p class="headline"><b>Key finding.</b> ${esc(s.headline)}</p>` : ''}
    ${mixed}
    <h4>1. Why look here?</h4>
    ${s.task ? `<p><i>${esc(s.task)}</i> <span class="small">(example use, not a real client)</span></p>` : ''}
    <p>${esc(s.what_happened)}</p>
    <p class="small">Sources: ${sources}</p>

    <h4>2. What does the radar show?</h4>
    ${s.radar_summary ? `<p>${esc(s.radar_summary)}</p>` : ''}
    ${s.objects_only ? '' : radarSection(s, w)}
    ${extraTables(s, 3)}

    <h4 id="sec-evidence">3. What do optical images and other records show?</h4>
    ${s.optical_text ? `<p>${esc(s.optical_text)}</p>` : ''}
    ${images}${gauges}
    ${s.audit_note ? `<p>${esc(s.audit_note)}</p>` : ''}

    <h4>4. Do they agree?</h4>
    <p>${esc(agreement)}</p>
    ${s.objects_only ? '' : classTable(s, w)}
    ${extraTables(s, 4)}

    ${s.candidates ? '<p class="small">Try it: the panel under the map highlights cells that pass a rule, shows how many fall in each reference group, and downloads them.</p>' : ''}

    <details class="more"><summary>More detail: polarisation, quality, limits and downloads</summary>
    <h4>5. Polarisation, quality and limits</h4>
    <p><span class="tag">candidate explanation</span> ${esc(s.mechanism || '')}</p>
    ${checks}
    ${extraTables(s, 5)}
    ${list(s.limits || [])}

    <h4>6. What can I take away?</h4>
    <p><b>Use it for</b></p>${list(s.use_for || [])}
    <p><b>Do not use it for</b></p>${list(s.not_for || [])}
    ${downloads ? `<p><b>Download</b> (only files that exist and were checked)</p><ul>${downloads}</ul>` : ''}
    ${dataUsed}
    </details>`;
}

function radarSection(s, w) {
  const hh = s.stats.hh, hv = s.stats.hv, baseline = isBaselineStory(s);
  const bigger = Math.abs(hh.event.median_db) >= Math.abs(hv.event.median_db) ? 'HH' : 'HV';
  const zoneStats = Object.fromEntries((s.zones || []).map((z) => [z.name, z.stats]));
  const timeCharts = s.series.areas.map((a) => {
    const st = zoneStats[a.name];
    const label = a.kind === 'all' ? '' : ` <span class="tag">${(ZONE_STYLE[a.kind] || ZONE_STYLE.target).label}</span>`;
    const numbers = st ? `<p class="small">${esc(w.short[0])}: HH ${db(st.hh.normal.median_db)}, HV ${db(st.hv.normal.median_db)}. ${esc(w.short[1])}: HH ${db(st.hh.event.median_db)}, HV ${db(st.hv.event.median_db)}.</p>` : '';
    return `<p><b>${esc(a.name)}</b>${label}</p>${relChart(s.series.dates, a.hh_db, a.hv_db)}${numbers}`;
  }).join('');
  const reference = baseline ? 'relative to the average of the dates before the event' : 'relative to the first date';
  return `
    <table>
      <tr><th>Whole area shown</th><th>${esc(w.short[0])}<br>${w.span[0]}</th><th>${esc(w.short[1])}<br>${w.span[1]}</th></tr>
      <tr><td>HH median change</td><td class="num">${db(hh.normal.median_db)}</td><td class="num"><b>${db(hh.event.median_db)}</b></td></tr>
      <tr><td>HV median change</td><td class="num">${db(hv.normal.median_db)}</td><td class="num"><b>${db(hv.event.median_db)}</b></td></tr>
      <tr><td>Area over 3 dB brighter (HH)</td><td class="num">${pct(hh.normal.share_above_3db)}</td><td class="num">${pct(hh.event.share_above_3db)}</td></tr>
      <tr><td>Area over 3 dB darker (HH)</td><td class="num">${pct(hh.normal.share_below_minus_3db)}</td><td class="num">${pct(hh.event.share_below_minus_3db)}</td></tr>
    </table>
    <p>${baseline ? `In this case ${bigger} changed more than ${bigger === 'HH' ? 'HV' : 'HH'}. ` : ''}Whole-area values are averaged over ${s.display.footprint_m} m.</p>
    <p class="small">Over time (${s.series.dates.length} dates): median return on each date, ${reference}. Solid line HH, dashed line HV.${baseline ? ' The shaded band is the range of HH before the event.' : ''}</p>
    ${timeCharts}
    ${s.series_note ? `<p class="small">${esc(s.series_note)}</p>` : ''}`;
}

// ---------------------------------------------------------------- scenes
async function loadScene(id) {
  if (!state.scenes[id]) {
    const r = await fetch(`scenes/${id}/scene.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`scene ${id}: HTTP ${r.status}`);
    state.scenes[id] = await r.json();
  }
  return state.scenes[id];
}

async function selectScene(id) {
  stopPlay();
  map.closePopup();
  state.scene = await loadScene(id);
  state.dateIndex = 0;
  state.rel = Boolean(state.scene.default_relative && state.scene.images && state.scene.images.change_rel);
  state.colour = 0;
  $('selection').hidden = true;
  $('mapnote').textContent = state.scene.map_note || '';
  $('mapnote').hidden = !state.scene.map_note;
  $('opacity').value = state.scene.default_opacity ?? 1;
  Object.assign(cand, { on: Boolean(state.scene.candidates && state.scene.candidates.default_on), measure: 0, geo: null, features: [] });
  if (state.scene.candidates) {
    const m0 = state.scene.candidates.measures[0];
    Object.assign(cand, { dir: m0.dir || 'darker', thr: m0.default ?? 3 });
  }
  state.layerOn = Object.fromEntries((state.scene.layers || []).map((l) => [l.id, Boolean(l.default_on)]));
  if (state.pair !== 'series') state.pair = state.scene.default_pair || 'event';
  state.view = state.scene.default_view || 'backscatter';
  // Highlight and its cells are one switch: when the highlight is on, its cells are shown,
  // and the background shows the same polarisation and period as the rule.
  if (cand.on) {
    state.layerOn[state.scene.candidates.layer] = true;
    Object.assign(state, state.scene.candidates.measures[0].sync || {});
  }
  syncButtons();
  history.replaceState(null, '', `#${id}`);
  for (const b of $('scenelist').querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === id);
  // Cell legends are tall: keep the bottom-left corner clear for them.
  // Keep the map near the case: a little room to pan, and at most two zoom levels out from the starting view.
  map.setMaxBounds(null);
  map.setMinZoom(0);
  const b = L.latLngBounds(state.scene.bounds);
  map.setView(b.getCenter(), state.scene.fit_contain ? map.getBoundsZoom(b, false) - (state.scene.zoom_out || 0) : map.getBoundsZoom(b, true) - 0.25 - (state.scene.zoom_out || 0), { animate: false });
  map.setMinZoom(Math.max(0, map.getZoom() - 2));
  map.setMaxBounds(L.latLngBounds(state.scene.bounds).pad(1.5));
  refreshLayers();
  drawPins();
  renderLayerControls();
  drawObjects();
  renderCard();
}

async function renderCompare() {
  const rows = [];
  for (const e of state.index) {
    const s = await loadScene(e.id);
    if (s.objects_only) {
      const ev = s.checks.independent_evidence;
      rows.push(`<tr><td>${esc(s.short_title)}<br><span class="small">${esc(s.theme)}</span></td>`
        + '<td colspan="4"><span class="small">Delivered as 1 ha map cells with values already computed (no radar image on the map). Open the case for its tables.</span></td>'
        + `<td>${s.checks.same_processing_version && s.checks.same_processing_version.value ? 'Yes' : 'No'}</td><td>${ev && ev.value ? 'Yes' : 'No'}</td></tr>`);
      continue;
    }
    const w = wording(s);
    const cell = (i, key) => `<td class="num"><span class="small">${esc(w.short[i])}</span><br>HH <b>${db(s.stats.hh[key].median_db)}</b><br>HV <b>${db(s.stats.hv[key].median_db)}</b></td>`;
    const ev = s.checks.independent_evidence;
    rows.push(`<tr><td>${esc(s.short_title)}<br><span class="small">${esc(s.theme)}</span></td>`
      + `<td>${shortDate(s.dates.baseline_1.date)}, ${shortDate(s.dates.baseline_2.date)}, ${shortDate(s.dates.after.date)}</td>`
      + cell(0, 'normal') + cell(1, 'event')
      + `<td>${s.series.dates.length}</td>`
      + `<td>${s.checks.same_processing_version.value ? 'Yes' : 'No'}</td>`
      + `<td>${ev && ev.value ? 'Yes' : 'No'}</td></tr>`);
  }
  $('comparetable').innerHTML = '<tr><th>Case</th><th>Key dates (2026)</th><th>First change</th><th>Second change</th>'
    + '<th>Dates in series</th><th>Same version</th><th>Independent evidence</th></tr>' + rows.join('');
}

// ---------------------------------------------------------------- guided tour
// optical: whether the optical picture (when the case has one) is shown at this step. Radar steps hide it.
const TOUR_STEPS = [
  { view: 'none', pol: 'hv', pair: 'default', optical: true, hl: true },   // first step: optical base and highlighted cells only
  { view: 'change', pol: 'hh', optical: false, hl: false },
  { view: 'change', pol: 'hv', optical: false, hl: false },
  { view: 'backscatter', pol: 'hh', pair: 'default', scroll: true, optical: true, hl: true },
  { optical: true, hl: true },
];
function tourText(s, i) {
  if (s.tour && s.tour[i]) return s.tour[i];
  return [
    `Radar works through cloud. This is ${s.short_title} on ${shortDate(s.dates.baseline_2.date)} (left) and ${shortDate(s.dates.after.date)} (right), before and after the floods. Drag the orange line.`,
    'Is that change unusual? Left of the line is the change over a normal 12 days. Right is the change across the event, on the same colour scale.',
    `Which polarisation shows it? This is HV. Here HH changed by ${db(s.stats.hh.event.median_db)} and HV by ${db(s.stats.hv.event.median_db)}.`,
    'What supports it? The panel shows a river gauge with the satellite pass marked, what we could not confirm, and what the map should not be used for.',
    'Now explore. Click the image to see the radar return at that point over time, press Play to step through the dates, or open another case.',
  ][i];
}
let tourStep = 0;

function showTourStep() {
  const { scroll, optical, hl, ...set } = TOUR_STEPS[tourStep];
  if (state.scene.candidates && hl !== undefined) { cand.on = hl; state.layerOn[state.scene.candidates.layer] = hl; }   // highlight only where the tour talks about it
  stopPlay();
  if (set.pair === 'default') set.pair = state.scene.default_pair || 'event';
  Object.assign(state, set);
  if (state.scene.images && state.scene.images.change_rel) state.rel = tourStep === 2;
  syncButtons();
  $('swipe').value = 0.5;
  refreshLayers();
  renderLayerControls();
  drawObjects();
  $('tourtext').textContent = tourText(state.scene, tourStep);
  $('tourcount').textContent = `${tourStep + 1} of ${TOUR_STEPS.length}`;
  $('tourback').disabled = tourStep === 0;
  $('tournext').textContent = tourStep === TOUR_STEPS.length - 1 ? 'Finish' : 'Next';
  // On a narrow screen the panel sits below the map, and scrolling to it would hide the tour box.
  const sideBySide = !window.matchMedia('(max-width: 880px)').matches;
  if (scroll && sideBySide && $('sec-evidence')) $('sec-evidence').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function startTour() {
  await selectScene(state.index[0].id);
  tourStep = 0;
  $('tour').hidden = false;
  showTourStep();
}
$('tourbtn').addEventListener('click', startTour);
$('tourclose').addEventListener('click', () => { $('tour').hidden = true; });
$('tourback').addEventListener('click', () => { tourStep -= 1; showTourStep(); });
$('tournext').addEventListener('click', () => {
  if (tourStep === TOUR_STEPS.length - 1) { $('tour').hidden = true; return; }
  tourStep += 1;
  showTourStep();
});

// ---------------------------------------------------------------- controls
function wireGroup(groupId, attr, key) {
  for (const b of $(groupId).querySelectorAll('button')) {
    b.addEventListener('click', () => {
      state[key] = b.dataset[attr];
      syncButtons();
      refreshLayers();
    });
  }
}
for (const b of $('relgroup').querySelectorAll('button')) b.addEventListener('click', () => { state.rel = b.dataset.rel === 'true'; refreshLayers(); drawObjects(); });
wireGroup('viewgroup', 'view', 'view');
wireGroup('polgroup', 'pol', 'pol');
wireGroup('pairgroup', 'pair', 'pair');
$('opacity').addEventListener('input', () => {
  for (const side of ['left', 'right']) if (overlays[side]) overlays[side].setOpacity(Number($('opacity').value));
  if (seriesLayers.length) showDate();
});
for (const b of document.querySelectorAll('nav button')) {
  b.addEventListener('click', () => {
    for (const o of document.querySelectorAll('nav button')) o.classList.toggle('on', o === b);
    for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== b.dataset.tab;
    if (b.dataset.tab === 'explore') {
      map.invalidateSize();
      if (state.scene) { const b = L.latLngBounds(state.scene.bounds); map.setView(b.getCenter(), state.scene.fit_contain ? map.getBoundsZoom(b, false) - (state.scene.zoom_out || 0) : map.getBoundsZoom(b, true) - 0.25 - (state.scene.zoom_out || 0), { animate: false }); }
      clipPanes();
    }
    if (b.dataset.tab === 'compare') renderCompare();
  });
}

// ---------------------------------------------------------------- start
(async function start() {
  try {
    const r = await fetch('scenes/index.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.index = await r.json();
  } catch (err) {
    $('card').innerHTML = '<p class="warn">Could not load the cases. This page needs to be opened through a web server or its public link, not as a local file.</p>';
    map.setView([-27.45, 152.75], 8);
    return;
  }
  // Themes like "Water · Victoria: ..." show the main theme once, in bold, with the sub-group under it.
  let theme = null, main = null;
  for (const e of state.index) {
    if (e.theme !== theme) {
      theme = e.theme;
      const [m, sub] = (theme || 'Other').split(' · ');
      if (m !== main) {
        main = m;
        const h = document.createElement('div');
        h.className = 'themehead';
        h.textContent = m;
        $('scenelist').appendChild(h);
      }
      if (sub) {
        const s = document.createElement('div');
        s.className = 'themesub';
        s.textContent = sub;
        $('scenelist').appendChild(s);
      }
    }
    const b = document.createElement('button');
    b.textContent = e.short_title;
    b.dataset.id = e.id;
    b.addEventListener('click', () => selectScene(e.id));
    $('scenelist').appendChild(b);
  }
  const wanted = location.hash.slice(1);
  await selectScene(state.index.some((e) => e.id === wanted) ? wanted : state.index[0].id);
}());
