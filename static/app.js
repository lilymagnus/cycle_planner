// ── State ──────────────────────────────────────────────────────────────────
let waypoints    = [];   // [{lat, lon, name}]
let selectedIdx  = null;
let markers      = [];
let routeLayer   = null;
let routing      = false;
let lastRouteData = null;


// ── Map init ───────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([53.4808, -2.2426], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19
}).addTo(map);

map.on('click', e => addWaypoint(e.latlng.lat, e.latlng.lng, `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`));

// ── Marker helpers ─────────────────────────────────────────────────────────
function makeIcon(num, type) {
  //bg = color of the pin
  const bg = type === 'end' || type === 'start' ? '#e03030' : '#c0622a';
  //fg = color of the number in the pin
  const fg = type === 'end' || type === 'start' ? '#fff' : '#fff';
  //three layers together make: pin shape → subtle highlight circle → number on top.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 10 15 23 15 23S30 25 30 15C30 6.7 23.3 0 15 0z" fill="${bg}"/>
    <circle cx="15" cy="15" r="9" fill="white" opacity="0.15"/>
    <text x="15" y="20" text-anchor="middle" font-size="11" font-weight="700" font-family="Syne,sans-serif" fill="${fg}">${num}</text>
  </svg>`;
  return L.divIcon({
    html: svg, className: '', iconSize: [30, 38], iconAnchor: [15, 38], popupAnchor: [0, -38]
  });
}

function refreshMarkers() {
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  waypoints.forEach((wp, i) => {
    const type = i === 0 ? 'start' : i === waypoints.length - 1 ? 'end' : 'mid';
    const m = L.marker([wp.lat, wp.lon], { icon: makeIcon(i + 1, type) })
               .addTo(map)
               .bindPopup(`<b>${i + 1}. ${wp.name}</b>`);
    markers.push(m);
  });
}

// ── Waypoint management ────────────────────────────────────────────────────
function addWaypoint(lat, lon, name) {
  waypoints.push({ lat, lon, name });
  refreshMarkers();
  renderList();
  setStatus(`Waypoint ${waypoints.length} added`);
}

function removeWaypoint(i) {
  waypoints.splice(i, 1);
  if (selectedIdx >= waypoints.length) selectedIdx = null;
  clearRoute();
  refreshMarkers();
  renderList();
}

function moveUp() {
  if (selectedIdx === null || selectedIdx === 0) return;
  [waypoints[selectedIdx - 1], waypoints[selectedIdx]] = [waypoints[selectedIdx], waypoints[selectedIdx - 1]];
  selectedIdx--;
  clearRoute();
  refreshMarkers();
  renderList();
}

function moveDown() {
  if (selectedIdx === null || selectedIdx >= waypoints.length - 1) return;
  [waypoints[selectedIdx + 1], waypoints[selectedIdx]] = [waypoints[selectedIdx], waypoints[selectedIdx + 1]];
  selectedIdx++;
  clearRoute();
  refreshMarkers();
  renderList();
}

function clearAll() {
  waypoints = [];
  selectedIdx = null;
  clearRoute();
  refreshMarkers();
  renderList();
  document.getElementById('stats-box').textContent = 'No route calculated yet';
  setStatus('Cleared');
}

function clearRoute() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
}

// ── List rendering ─────────────────────────────────────────────────────────
function renderList() {
  const list = document.getElementById('wp-list');
  if (waypoints.length === 0) {
    list.innerHTML = '<div style="color:var(--muted);font-size:12px;font-family:\'Lora\',serif;padding:8px 0">No waypoints yet</div>';
    return;
  }
  list.innerHTML = waypoints.map((wp, i) => {
    const type = i === 0 ? 'first' : i === waypoints.length - 1 ? 'last' : '';
    const sel  = i === selectedIdx ? 'selected' : '';
    return `<div class="wp-item ${sel}" onclick="selectWp(${i})">
      <div class="wp-num ${type}">${i + 1}</div>
      <div class="wp-name" title="${wp.name}">${wp.name}</div>
      <button class="wp-remove" onclick="event.stopPropagation();removeWaypoint(${i})" title="Remove">✕</button>
    </div>`;
  }).join('');
}

function selectWp(i) {
  selectedIdx = (selectedIdx === i) ? null : i;
  renderList();
  if (selectedIdx !== null) map.panTo([waypoints[i].lat, waypoints[i].lon]);
}

// ── Search ─────────────────────────────────────────────────────────────────
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchAndAdd();
});

async function searchAndAdd() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  setStatus('<span class="spinner"></span> Searching…', true);
  try {
    const res  = await fetch('/geocode', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({query}) });
    const data = await res.json();
    if (data.error) { setStatus('Place not found'); return; }
    addWaypoint(data.lat, data.lon, data.name);
    map.setView([data.lat, data.lon], Math.max(map.getZoom(), 14));
    document.getElementById('search-input').value = '';
  } catch {
    setStatus('Search failed');
  }
}

// ── Routing ────────────────────────────────────────────────────────────────
async function snapWaypoint(lat, lon) {
  try {
    const url = `http://localhost:5001/nearest/v1/bicycle/${lon},${lat}?number=1`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.waypoints && data.waypoints.length) {
      const snapped = data.waypoints[0].location; // [lon, lat]
      return { lat: snapped[1], lon: snapped[0] };
    } else {
      throw new Error('No snap point found');
    }
  } catch (e) {
    console.error('Snap error:', e);
    return { lat, lon }; // fallback to original
  }
}

async function calculateRoute() {
  if (waypoints.length < 2) { alert('Add at least 2 waypoints first.'); return; }

  clearRoute();
  setStatus('<span class="spinner"></span> Calculating route…', true);
  document.getElementById('stats-box').innerHTML = '<span class="spinner"></span> Fetching route…';
  // Snap all waypoints first
  const snappedWaypoints = [];
  for (let w of waypoints) {
    const snapped = await snapWaypoint(w.lat, w.lon);
    snappedWaypoints.push(snapped);
  }

  // Then build coordStr from snapped points
  const coordStr = snappedWaypoints.map(w => `${w.lon},${w.lat}`).join(';');
 
  const url = `http://localhost:5001/route/v1/bicycle/${coordStr}?overview=full&geometries=geojson&annotations=true`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    lastRouteData = data;
    console.log('OSRMR:', data);

    if (data.code === 'Ok') {
      const coords = data.routes[0].geometry.coordinates;
      const points = coords.map(([lon, lat]) => [lat, lon]);  

      const km   = (data.routes[0].distance / 1000).toFixed(1);
      const mins = Math.round(data.routes[0].duration / 60);
      const hrs  = Math.floor(mins / 60);
      const mn   = mins % 60;
      const tStr = hrs ? `${hrs}h ${mn}m` : `${mn}m`;

      routeLayer = L.polyline(points, { color: '#5b8dff', weight: 5, opacity: 0.85 }).addTo(map);
      map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });

      document.getElementById('stats-box').textContent = `${km} km  ·  ~${tStr} cycling`;
      setStatus('Route calculated');
      // Fetch and draw elevation profile
      fetchElevation(coords).then(drawElevationChart).catch(e => console.warn('Elevation error:', e));
    } else {
      throw new Error('No route found');
    }

  } catch(e) {
    console.error('Route error:', e);
    document.getElementById('stats-box').textContent = 'Routing failed';
    setStatus('Error: ' + e.message);
  }
}

//GPX Exprot --------------------------
function exportGPX() {
  if (!routeLayer) { alert('Calculate a route first.'); return; }

  const points = routeLayer.getLatLngs();
  const date   = new Date().toISOString();

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Cycle Trip Planner"
  xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Cycle Route</name>
    <time>${date}</time>
  </metadata>
  <trk>
    <name>Cycle Route</name>
    <trkseg>
${points.map(p => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"></trkpt>`).join('\n')}
    </trkseg>
  </trk>
${waypoints.map((wp, i) => `  <wpt lat="${wp.lat.toFixed(6)}" lon="${wp.lon.toFixed(6)}">
    <name>${wp.name}</name>
  </wpt>`).join('\n')}
</gpx>`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'cycle_route.gpx'; a.click();
  URL.revokeObjectURL(url);
  setStatus('GPX downloaded');
}

// ── SVG Export ─────────────────────────────────────────────────────────────
async function exportSVG() {
  if (!routeLayer) { alert('Calculate a route first.'); return; }
  const points = routeLayer.getLatLngs().map(p => [p.lat, p.lng]);
  setStatus('<span class="spinner"></span> Generating SVG…', true);
  try {
    const res = await fetch('/export_svg', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ route_points: points, waypoints })
    });
    if (!res.ok) { setStatus('Export failed'); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'cycle_route.svg'; a.click();
    URL.revokeObjectURL(url);
    setStatus('SVG downloaded');
  } catch {
    setStatus('Export error');
  }
}

let elevationMarker = null;
let elevationData   = [];

async function fetchElevation(coords) {
  // Sample every 10th point to keep request small
  const sampled = coords.filter((_, i) => i % 10 === 0);
  const locations = sampled.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));

  const res  = await fetch('https://api.open-elevation.com/api/v1/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations })
  });
  const data = await res.json();
  return data.results; // [{latitude, longitude, elevation}]
}

function drawElevationChart(results) {
  const panel  = document.getElementById('elevation-panel');
  const canvas = document.getElementById('elevation-canvas');
  panel.style.display = 'block';

  // Resize canvas to actual pixel size
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;
  const pad = { top: 10, right: 10, bottom: 20, left: 40 };

  const elevs   = results.map(r => r.elevation);
  const minElev = Math.min(...elevs);
  const maxElev = Math.max(...elevs);
  const range   = (maxElev - minElev) || 1;

  function xFor(i)   { return pad.left + (i / (results.length - 1)) * (W - pad.left - pad.right); }
  function yFor(elev){ return pad.top  + (1 - (elev - minElev) / range) * (H - pad.top - pad.bottom); }

  ctx.clearRect(0, 0, W, H);

  // Filled area
  ctx.beginPath();
  ctx.moveTo(xFor(0), H - pad.bottom);
  results.forEach((r, i) => ctx.lineTo(xFor(i), yFor(r.elevation)));
  ctx.lineTo(xFor(results.length - 1), H - pad.bottom);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
  grad.addColorStop(0, 'rgba(192, 98, 42, 0.5)');
  grad.addColorStop(1, 'rgba(192, 98, 42, 0.05)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  results.forEach((r, i) => i === 0 ? ctx.moveTo(xFor(i), yFor(r.elevation)) : ctx.lineTo(xFor(i), yFor(r.elevation)));
  ctx.strokeStyle = '#c0622a';
  ctx.lineWidth   = 2;
  ctx.stroke();

  // Y axis labels
  ctx.fillStyle   = '#9c8878';
  ctx.font        = '10px Lora, serif';
  ctx.textAlign   = 'right';
  [minElev, Math.round((minElev + maxElev) / 2), maxElev].forEach(e => {
    const y = yFor(e);
    ctx.fillText(Math.round(e) + 'm', pad.left - 4, y + 3);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(156,136,120,0.15)';
    ctx.lineWidth = 1;
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
  });

  elevationData = results;

  // Hover interaction
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const i    = Math.round((x - pad.left) / (W - pad.left - pad.right) * (results.length - 1));
    if (i < 0 || i >= results.length) return;

    const point = results[i];

    // Calculate incline % vs previous point
    let inclineStr = '';
    if (i > 0) {
      const prev = results[i - 1];
      const rise = point.elevation - prev.elevation;
      const R    = 6371000;
      const dLat = (point.latitude  - prev.latitude)  * Math.PI / 180;
      const dLon = (point.longitude - prev.longitude) * Math.PI / 180;
      const a    = Math.sin(dLat/2)**2 + Math.cos(prev.latitude * Math.PI/180) * Math.cos(point.latitude * Math.PI/180) * Math.sin(dLon/2)**2;
      const run  = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const pct  = run > 0 ? (rise / run * 100).toFixed(1) : 0;
      const dir  = pct > 0 ? '▲' : pct < 0 ? '▼' : '→';
      inclineStr = `  ${dir} ${Math.abs(pct)}%`;
      //console.log('rise:', rise, 'run:', run, 'pct:', pct, 'inclineStr:', inclineStr);
    }

    // Move marker on map
    if (elevationMarker) map.removeLayer(elevationMarker);
    elevationMarker = L.circleMarker([point.latitude, point.longitude], {
      radius: 6, color: '#c0622a', fillColor: '#c0622a', fillOpacity: 1
    }).addTo(map).bindTooltip(`${Math.round(point.elevation)}m${inclineStr}`, { permanent: true, direction: 'top' }).openTooltip();

    // Redraw chart with hover line
    drawElevationChart(results);
    ctx.beginPath();
    ctx.strokeStyle = '#c0622a';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(xFor(i), pad.top);
    ctx.lineTo(xFor(i), H - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  canvas.onmouseleave = () => {
    if (elevationMarker) { map.removeLayer(elevationMarker); elevationMarker = null; }
  };
}

// ── Status bar ─────────────────────────────────────────────────────────────
let statusTimer;
function setStatus(msg, persist = false) {
  const el = document.getElementById('statusbar');
  el.innerHTML = msg;
  el.style.opacity = '1';
  clearTimeout(statusTimer);
  if (!persist) statusTimer = setTimeout(() => el.style.opacity = '0.4', 3000);
}
