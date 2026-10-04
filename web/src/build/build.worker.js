// Geometry worker. Each instance loads the parts of the package it needs (the fetches hit the HTTP cache the main
// thread already filled), builds one job, and hands the typed arrays back as transferables: zero-copy, no jank.
import { loadWorld } from '../world.js';
import { buildFar, buildTerrain, buildWater, normalMap } from './terrain.build.js';
import { buildBuildings } from './buildings.build.js';

function buffers(o, out = new Set()) {
  if (ArrayBuffer.isView(o)) out.add(o.buffer);
  else if (Array.isArray(o)) o.forEach(v => buffers(v, out));
  else if (o && typeof o === 'object') Object.values(o).forEach(v => buffers(v, out));
  return out;
}

self.onmessage = async (e) => {
  const { base, job } = e.data;
  try {
    const t0 = performance.now();
    const w = await loadWorld(base, job === 'terrain' ? { height: true, water: true, far: true } : { bin: true, height: true, water: true });
    const t1 = performance.now();
    let out;
    if (job === 'terrain') {
      out = { terrain: buildTerrain(w), normals: normalMap(w.height, w.n, 2 * w.H / (w.n - 1)), water: w.level ? buildWater(w) : [], far: w.farHeight ? buildFar(w) : null };
    } else {
      out = buildBuildings(w);
    }
    self.postMessage({ out, ms: { load: Math.round(t1 - t0), build: Math.round(performance.now() - t1) } }, [...buffers(out)]);
  } catch (err) {
    self.postMessage({ error: String(err && err.stack || err) });
  }
};
