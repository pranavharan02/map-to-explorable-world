// Interface: the intro sheet, the HUD (mode, local time, position), the minimap, help, captions and toasts.
// The intro is laid out like the legend block of a survey map: the place, its coordinates, and its sources.
const $ = id => document.getElementById(id);
const fmtLat = v => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? 'N' : 'S'}`;
const fmtLon = v => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? 'E' : 'W'}`;

export function createUI(world, opts) {
  const m = world.meta, k = m.center;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('title').textContent = m.name;
  $('subtitle').textContent = m.subtitle || '';
  document.title = `${m.name} · map to explorable world`;
  const facts = [
    ['Center', `${fmtLat(k.lat)}  ${fmtLon(k.lon)}`],
    ['Walkable core', `${(2 * m.half / 1000).toFixed(1)} km square`],
    ['Context ring', m.far ? `${(2 * m.far.half / 1000).toFixed(0)} km square` : 'none'],
    ['In the package', `${m.counts.buildings.toLocaleString()} buildings · ${(m.counts.trees + (m.far?.trees || 0)).toLocaleString()} trees`],
  ];
  $('facts').innerHTML = facts.map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join('');
  $('credits').innerHTML = Object.values(m.credits || {}).map(c => `<li>${esc(c)}</li>`).join('');
  if (opts.worlds?.length > 1) {
    $('worlds').innerHTML = 'Other worlds: ' + opts.worlds.filter(w => w.id !== m.id)
      .map(w => `<a href="?world=${encodeURIComponent(w.id)}">${esc(w.name)}</a>`).join(' · ');
  }

  // ---- minimap: satellite color, footprints and labels, drawn once; the marker moves
  const mm = $('minimap'), mc = mm.getContext('2d');
  const base = document.createElement('canvas'); base.width = base.height = 1024;
  const bc = base.getContext('2d');
  bc.drawImage(world.img.color, 0, 0, 1024, 1024);
  bc.fillStyle = 'rgba(20,24,30,0.18)'; bc.fillRect(0, 0, 1024, 1024);
  const S = world.S, H = world.H, px = (x, z) => [(x + H) / (2 * H) * 1024, (z + H) / (2 * H) * 1024];
  bc.fillStyle = 'rgba(245,240,228,0.9)';
  for (let b = 0; b < S.bRing.length - 1; b++) {
    const r = S.bRing[b], o0 = S.rOff[r], o1 = S.rOff[r + 1];
    bc.beginPath();
    for (let i = o0; i < o1; i++) { const [x, y] = px(S.bPts[i * 2] / 10, -S.bPts[i * 2 + 1] / 10); i === o0 ? bc.moveTo(x, y) : bc.lineTo(x, y); }
    bc.closePath(); bc.fill();
  }
  bc.font = '600 15px ui-sans-serif, system-ui, sans-serif'; bc.textAlign = 'center';
  for (const l of m.labels || []) {
    if (Math.abs(l.x) > H || Math.abs(l.y) > H) continue;
    const [x, y] = px(l.x, -l.y);
    bc.lineWidth = 4; bc.strokeStyle = 'rgba(15,17,20,0.85)'; bc.strokeText(l.name, x, y); bc.fillStyle = '#f6f1e6'; bc.fillText(l.name, x, y);
  }
  let mapMode = 1;   // 0 off, 1 corner, 2 large
  function drawMap(cam, yaw) {
    if (!mapMode) return;
    const W = mm.width = mm.height = mapMode === 2 ? Math.min(innerWidth, innerHeight) * 0.8 * devicePixelRatio : 220 * devicePixelRatio;
    mc.drawImage(base, 0, 0, W, W);
    const [x, y] = px(cam.x, cam.z).map(v => v / 1024 * W);
    mc.save(); mc.translate(x, y); mc.rotate(-yaw);
    mc.fillStyle = '#ffcf4a'; mc.strokeStyle = '#111'; mc.lineWidth = 2 * devicePixelRatio;
    const s = 9 * devicePixelRatio;
    mc.beginPath(); mc.moveTo(0, -s * 1.4); mc.lineTo(s * 0.8, s); mc.lineTo(0, s * 0.45); mc.lineTo(-s * 0.8, s); mc.closePath(); mc.fill(); mc.stroke();
    mc.restore();
    mm.className = mapMode === 2 ? 'large' : '';
  }
  mm.addEventListener('click', e => {
    if (mapMode !== 2) return;
    const r = mm.getBoundingClientRect(), u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    opts.goTo?.(-H + u * 2 * H, -H + v * 2 * H);
    mapMode = 1; drawMap(opts.camera.position, opts.yaw());
  });

  let toastT = 0;
  const ui = {
    toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 3200); },
    caption(t) { const c = $('caption'); c.textContent = t; c.classList.toggle('on', !!t); },
    mode(mo) { $('mode').textContent = { walk: 'Walking', fly: 'Flying', tour: 'Drone tour' }[mo] || mo; },
    clock(h, zone) { const hh = Math.floor(h), mi = Math.floor((h - hh) * 60); $('clock').textContent = `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')} · ${zone}`; },
    position(cam, yaw) {
      const lat = k.lat + (-cam.z) / 111132.954, lon = k.lon + cam.x / (111412.84 * Math.cos(k.lat * Math.PI / 180));
      const hd = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
      $('pos').textContent = `${fmtLat(lat)}  ${fmtLon(lon)}  ·  ${Math.round(cam.y)} m  ·  ${String(Math.round(hd)).padStart(3, '0')}°`;
    },
    map(cam, yaw) { drawMap(cam, yaw); },
    toggleMap() { mapMode = (mapMode + 1) % 3; mm.style.display = mapMode ? 'block' : 'none'; drawMap(opts.camera.position, opts.yaw()); },
    status(t) { $('status').textContent = t; },
  };
  addEventListener('keydown', e => {
    if (e.code === 'KeyM') ui.toggleMap();
    if (e.code === 'KeyH' || e.key === '?') document.body.classList.toggle('help');
    if (e.code === 'KeyU') document.body.classList.toggle('nohud');
  });
  return ui;
}
