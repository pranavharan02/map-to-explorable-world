// Boot, frame loop and the performance machinery: geometry workers, shader warm-up before the first frame, a
// texel-snapped shadow camera that follows the viewer, a vsync-aware resolution governor, and debug hooks.
import * as THREE from 'three';
import { loadWorld, worldTextures } from './world.js';
import { applySun, env, makeClock } from './env.js';
import { createSky, injectUniforms, installChunks } from './atmosphere.js';
import { createTerrainShadow } from './terrainshadow.js';
import { groundDetail, noiseTexture, waterNormals } from './textures.js';
import { createTerrain, normalTexture, terrainMaterial } from './terrain.js';
import { createFar } from './far.js';
import { createWater } from './water.js';
import { colliderGrid, createBuildings } from './buildings.js';
import { createVegetation, DETAIL, LOD, VIEW_H } from './trees/vegetation.js';
import { createGrass } from './grass.js';
import { createControls } from './controls.js';
import { createUI } from './ui.js';
import { gpuName, pickPreset } from './quality.js';

const qs = new URLSearchParams(location.search);
const T0 = performance.now(), times = {};
const mark = k => { times[k] = Math.round(performance.now() - T0); };
const $ = id => document.getElementById(id);
const status = t => { $('status').textContent = t; };
const fail = (msg, err) => { status(msg); document.body.classList.add('failed'); if (err) console.error(err); throw err || new Error(msg); };

// ---------------------------------------------------------------- which world
const index = await fetch('worlds/index.json').then(r => r.json()).catch(() => ({ worlds: [] }));
const id = qs.get('world') || index.worlds[0]?.id;
if (!id) fail('No world package found. Build one first: python -m pipeline worlds/hallstatt.json');
const base = new URL(`worlds/${encodeURIComponent(id)}/`, location.href).href;

// the geometry workers start before anything else, and build while this thread sets up
const job = name => new Promise((res, rej) => {
  const w = new Worker(new URL('./build/build.worker.js', import.meta.url), { type: 'module' });
  w.onmessage = e => { w.terminate(); e.data.error ? rej(new Error(e.data.error)) : res(e.data); };
  w.onerror = e => { w.terminate(); rej(e); };
  w.postMessage({ base, job: name });
});
const built = Promise.all([job('terrain'), job('buildings')]);

// ---------------------------------------------------------------- renderer
const GPU = gpuName(), Q = pickPreset(qs, GPU);
let renderer;
try { renderer = new THREE.WebGLRenderer({ antialias: Q.msaa, powerPreference: 'high-performance', stencil: false }); }
catch (e) { fail('This needs WebGL 2. Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration on.', e); }
renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); status('The graphics driver reset. Reload the page to continue.'); document.body.classList.remove('started'); });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.debug.checkShaderErrors = qs.has('debug');      // synchronous error checks serialize every compile
let dpr = Math.min(devicePixelRatio, Q.maxDpr);
renderer.setPixelRatio(dpr); renderer.setSize(innerWidth, innerHeight);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xffffff, 0.0001);          // turns on USE_FOG; the fog itself is ours (atmosphere.js)
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.35, 30000);
const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
sun.castShadow = true; sun.shadow.mapSize.set(Q.shadow, Q.shadow);
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
const sc = sun.shadow.camera; sc.near = 1; sc.far = 3000;
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, Math.PI);
scene.add(sun, sun.target, hemi);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------------------------------------------------------------- data and the world
status('Fetching the world package…');
let world;
try { world = await loadWorld(base); } catch (e) { fail(`Could not load the world "${id}": ${e.message}`, e); }
mark('data');
const meta = world.meta, tex = worldTextures(world);
installChunks();
env.uNoise.value = noiseTexture();
const hm = meta.height;
const groundLo = (meta.water?.bodies?.[0]?.level ?? hm.lo);
env.uShadowExt.value.w = groundLo + 1700;                                       // cloud deck altitude
const HAZE = { tropical: 0.0003, subtropical: 0.00026, arid: 0.00022, temperate: 0.00017, boreal: 0.00014 };
env.uFogParams.value.set((HAZE[meta.biome] ?? 0.0002) * Math.sqrt(1000 / meta.half), 600, groundLo, 0);   // haze density, scale height, base
Object.assign(LOD, Q.lod); DETAIL.level = Q.detail;
scene.add(createSky());
status(`Growing ${(meta.counts.trees + (meta.far?.trees || 0)).toLocaleString()} trees…`);
await new Promise(r => setTimeout(r, 0));
const veg = createVegetation(world, renderer, Q.name); scene.add(veg.group); mark('vegetation');
status(`Building ${meta.counts.buildings.toLocaleString()} buildings and the terrain…`);
let BT, BB;
try { [BT, BB] = await built; } catch (e) { fail(`Building the world failed: ${e.message}`, e); }
mark('workers'); times.workers = { terrain: BT.ms, buildings: BB.ms };
const noise = env.uNoise.value;
const normalMap = normalTexture(BT.out.normals, world.n);
const tMat = terrainMaterial(world, tex, { normalMap, noise, detail: groundDetail() });
const terrain = createTerrain(BT.out.terrain, tMat, Q.terrainLod); scene.add(terrain.group);
const far = BT.out.far ? createFar(world, tex, BT.out.far, normalTexture(BT.out.far.normals, meta.far.n)) : null;
if (far) scene.add(far);
const water = createWater(world, tex, BT.out.water, waterNormals(), renderer); scene.add(water.group);
water.setScale(Q.refl);
const style = meta.palette === 'europe' ? 1 : 0;
const buildings = createBuildings(BB.out, noise, style); scene.add(buildings);
const building = colliderGrid(BB.out.colliders, world.H);
const grass = createGrass(world, tex, Q.grass); scene.add(grass.mesh);
injectUniforms(scene);
const tshadow = createTerrainShadow(renderer, world, tex, Q.terrainShadow);
mark('meshes');

// ---------------------------------------------------------------- controls, interface, time
const clock = makeClock(meta);
const ui = createUI(world, { worlds: index.worlds, camera, yaw: () => controls.yaw, goTo: (x, z) => goTo(x, z) });
const controls = createControls(camera, renderer.domElement, world, {
  building: (x, z, r) => building(x, z, r), trunk: (x, z, r) => veg.trunkAt(x, z, r),
  onMode: m => { ui.mode(m); document.body.dataset.mode = m; }, onCaption: t => ui.caption(t),
  onLock: l => document.body.classList.toggle('locked', l), onView: v => ui.toast(v.name),
});
function goTo(x, z) { controls.setPose(new THREE.Vector3(x, world.heightAt(x, z) + 1.65, z), controls.yaw, -0.05); controls.setMode('walk'); }
let simMs = Date.now(), timelapse = false, sunInfo;
if (qs.has('t')) simMs = clock.at(Date.now(), +qs.get('t'));
function setTime(ms, full = true) {
  simMs = ms;
  sunInfo = applySun(simMs, meta, { sun, hemi }, renderer);
  ui.clock(clock.localHour(simMs), clock.label);
  if (full) tshadow.update(true);
}
setTime(simMs);
if (!qs.has('t') && sunInfo.elevation < -3) {               // night there now: open on a late afternoon instead
  setTime(clock.at(Date.now(), 16.5));
  ui.toast(`It is night in ${meta.name} right now, so this opens at 16:30. Press T to change the time.`);
}
const HOURS = [6.5, 8.5, 11, 13.5, 16.5, 18.75, 20.25, 23];
addEventListener('keydown', e => {
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const h = clock.localHour(simMs);
  if (e.code === 'KeyT') setTime(clock.at(simMs, HOURS.find(x => x > h + 0.05) ?? HOURS[0]));
  if (e.code === 'BracketRight') setTime(simMs + 15 * 60000);
  if (e.code === 'BracketLeft') setTime(simMs - 15 * 60000);
  if (e.code === 'KeyP') { timelapse = !timelapse; ui.toast(timelapse ? 'Time-lapse: an hour every four seconds' : 'Time-lapse off'); }
});
if (qs.has('pos')) {
  const [x, z, y, yw, pt] = qs.get('pos').split(',').map(Number);
  if ([x, z, y, yw, pt].every(Number.isFinite)) { controls.setMode(qs.get('mode') === 'walk' ? 'walk' : 'fly'); controls.setPose(new THREE.Vector3(x, y, z), yw, pt); }
} else controls.view(0);
controls.update(0);
terrain.update(camera); veg.update(camera, shadowRadius(), true); grass.update(camera);

// ---------------------------------------------------------------- shaders, compiled before the first visible frame
status('Compiling shaders…');
await renderer.compileAsync(scene, camera);
mark('compiled');
// The reflection pass draws without shadow lookups, which needs its own program variants. They compile in the
// background after the first frame (compileAsync issues every compile synchronously, so the state can be restored
// at once), and reflections switch on when they're ready, instead of stalling the first frame that shows water.
water.setEnabled(false);
setTimeout(() => {
  sun.castShadow = false; veg.reflectionMode(true);
  const pending = renderer.compileAsync(scene, camera);
  sun.castShadow = true; veg.reflectionMode(false);
  pending.then(() => { water.setEnabled(true); mark('reflections'); });
}, 100);

// ---------------------------------------------------------------- the shadow camera follows the viewer, snapped to texels
const lightView = new THREE.Matrix4(), snap = new THREE.Vector3(), sdir = new THREE.Vector3(), ahead = new THREE.Vector3();
function shadowRadius() { return Math.min(Q.shadowR + Math.max(0, camera.position.y - world.groundAt(camera.position.x, camera.position.z) - 2) * 0.8, 280); }
function updateShadow() {
  const R = shadowRadius();
  sc.left = sc.bottom = -R; sc.right = sc.top = R; sc.updateProjectionMatrix();
  camera.getWorldDirection(ahead); ahead.y = 0; ahead.normalize().multiplyScalar(R * 0.45);   // center a little ahead
  const c = camera.position.clone().add(ahead); c.y = world.groundAt(c.x, c.z);
  sdir.copy(env.uSunDir.value); if (sdir.y < 0.08) sdir.y = 0.08; sdir.normalize();
  // snap the center to whole shadow texels in light space, so shadow edges do not crawl as you move
  lightView.lookAt(sdir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  snap.copy(c).applyMatrix4(lightView.clone().invert());
  const texel = 2 * R / Q.shadow;
  snap.x = Math.round(snap.x / texel) * texel; snap.y = Math.round(snap.y / texel) * texel;
  c.copy(snap.applyMatrix4(lightView));
  sun.target.position.copy(c); sun.position.copy(c).addScaledVector(sdir, 1200); sun.target.updateMatrixWorld();
}

// ---------------------------------------------------------------- dynamic resolution
// rAF frame times are capped by vsync: drop resolution when frames miss the refresh, creep back after a steady stretch
const perf = { hold: 0, refresh: 16.7, samples: [] };
function governor(ms) {
  perf.samples.push(ms); if (perf.samples.length > 30) perf.samples.shift();
  if (perf.samples.length < 30 || qs.has('fixed')) return;
  const p50 = [...perf.samples].sort((a, b) => a - b)[15];
  if (perf.refresh > p50) perf.refresh = Math.max(6.9, p50);   // learn the display's refresh interval
  let next = dpr;
  if (p50 > perf.refresh * 1.18) { next = Math.max(Q.minDpr, dpr * 0.88); perf.hold = 0; }
  else if (p50 < perf.refresh * 1.04 && ++perf.hold > 120) { next = Math.min(devicePixelRatio, Q.maxDpr, dpr * 1.07); perf.hold = 0; }
  if (Math.abs(next - dpr) > 0.01) { dpr = next; renderer.setPixelRatio(dpr); perf.samples.length = 0; }
}

// ---------------------------------------------------------------- loop
let last = performance.now(), shadowTick = 0, hudT = 0, frames = 0, fpsT = 0;
const lastShadowC = new THREE.Vector3(1e9, 0, 0);
function frame(t, dtOverride) {
  const dt = dtOverride ?? Math.min(0.1, (t - last) / 1000), ms = t - last; last = t;
  env.uTime.value += dt;
  env.uWind.value.x += dt * 0.00035; env.uWind.value.y += dt * 0.00012;   // the cloud deck drifts
  if (timelapse) setTime(simMs + dt * 900000, false);
  controls.update(dt);
  terrain.update(camera);
  veg.update(camera, shadowRadius()); veg.cull(camera); grass.update(camera);
  VIEW_H.value = renderer.domElement.height;
  updateShadow();
  tshadow.update();
  water.render(scene, camera,
    () => { veg.reflectionMode(true); grass.mesh.visible = false; sun.castShadow = false; },
    () => { veg.reflectionMode(false); grass.update(camera); sun.castShadow = true; });
  // the shadow map refreshes every other frame, or at once when its box has jumped
  shadowTick ^= 1;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = shadowTick === 0 || sun.target.position.distanceToSquared(lastShadowC) > 4;
  if (renderer.shadowMap.needsUpdate) lastShadowC.copy(sun.target.position);
  renderer.render(scene, camera);
  if (dtOverride == null) governor(ms);
  if ((hudT += dt) > 0.12) {
    hudT = 0; ui.position(camera.position, controls.yaw); ui.map(camera.position, controls.yaw);
    if (timelapse) ui.clock(clock.localHour(simMs), clock.label);
  }
  frames++; fpsT += ms;
  if (fpsT > 500) {
    if (qs.has('fps')) $('fps').textContent = `${Math.round(frames * 1000 / fpsT)} fps · ${Math.round(dpr * 100)}% · ${renderer.info.render.calls} draws · ${(renderer.info.render.triangles / 1e6).toFixed(2)}M tris · ${Q.name}`;
    frames = 0; fpsT = 0;
  }
}
renderer.setAnimationLoop(t => frame(t));
mark('first-frame');
const ready = () => { if (document.body.classList.contains('ready')) return; mark('drawn'); document.body.classList.add('ready'); status(''); };
requestAnimationFrame(ready); setTimeout(ready, 300);
$('enter').addEventListener('click', () => { document.body.classList.add('started'); renderer.domElement.requestPointerLock?.(); });
if (qs.has('nointro')) document.body.classList.add('started');
ui.mode(controls.mode);

// ---------------------------------------------------------------- hooks for scripted capture and probing
// (rAF does not tick while a test harness drives a hidden page, so step() advances frames by hand)
window.__world = {
  times, renderer, scene, camera, world, veg, terrain, water, controls, env, Q, GPU,
  step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) frame(performance.now(), dt); },
  view(i) { controls.view(i); controls.update(0); veg.update(camera, shadowRadius(), true); grass.update(camera); },
  setHour(h) { setTime(clock.at(simMs, h)); },
  // stand at (x, z), `h` meters above the ground, looking at (tx, tz)
  goto(x, z, tx, tz, h = 1.65, pitch = -0.04) {
    const wet = world.waterAt(x, z) > 0.5;                  // over water you hover above the surface, not the bed
    controls.setMode(h > 3 || wet ? 'fly' : 'walk');
    const base = wet ? Math.max(world.groundAt(x, z), world.levelAt(x, z)) : world.groundAt(x, z);
    controls.setPose(new THREE.Vector3(x, base + h, z), Math.atan2(-(tx - x), -(tz - z)), pitch);
    controls.update(0); veg.update(camera, shadowRadius(), true); grass.update(camera);
  },
  async cap(name, steps = 4, port = 5197) {
    for (let i = 0; i < steps; i++) frame(performance.now(), 1 / 60);
    const blob = await (await fetch(renderer.domElement.toDataURL('image/jpeg', 0.92))).blob();
    await fetch(`http://127.0.0.1:${port}/save?name=${encodeURIComponent(name)}.jpg`, { method: 'POST', body: blob });
    return name;
  },
  // GPU milliseconds per frame (EXT_disjoint_timer_query_webgl2). `full` is the median frame; each part's cost is the
  // median difference between interleaved frames with the part on and off, so clock ramps and drift cancel out.
  // Pass one part name, or none for all; the hidden Browser pane needs one part per call to stay under its timeout.
  async gpuProbe(only = null, n = 12) {
    const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return 'EXT_disjoint_timer_query_webgl2 is not available';
    const timed = async (count, setup) => {
      const list = [];
      for (let i = 0; i < count; i++) {
        setup?.(i);
        const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); frame(performance.now(), 1 / 60); gl.endQuery(ext.TIME_ELAPSED_EXT);
        list.push([i, q]);
      }
      gl.finish(); await new Promise(r => setTimeout(r, 40));
      const v = [];
      for (const [i, q] of list) {
        for (let k = 0; k < 60 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise(r => setTimeout(r, 5));
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) v.push([i, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6]);
        gl.deleteQuery(q);
      }
      return v;
    };
    const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
    const vis = o => b => { o.visible = b; };
    const parts = {
      trees: vis(veg.group), buildings: vis(buildings), terrain: vis(terrain.group), grass: b => { grass.enabled = b; },
      reflection: b => water.setEnabled(b), shadows: b => { sun.castShadow = b; }, ...(far ? { 'context ring': vis(far) } : {}),
    };
    await timed(8);                                                   // warm up
    const full = med((await timed(n)).map(x => x[1]));
    const out = { full: +full.toFixed(2) };
    for (const [name, set] of Object.entries(parts)) {
      if (only && name !== only) continue;
      // frames alternate in pairs (on, on, off, off...), so each side sees the every-other-frame shadow refresh equally
      const v = await timed(n * 4, i => set((i >> 1) % 2 === 0));
      set(true);
      const on = v.filter(x => (x[0] >> 1) % 2 === 0).map(x => x[1]), off = v.filter(x => (x[0] >> 1) % 2 === 1).map(x => x[1]);
      out[name] = +(med(on) - med(off)).toFixed(2);
    }
    grass.update(camera);
    return out;
  },
  info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, dpr, trees: veg.stats, terrainTris: terrain.group.userData.tris, buildingTris: buildings.userData.tris }),
};
