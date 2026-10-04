// Worker side: terrain, water and context-ring geometry as transferable typed arrays.
//
// Terrain LOD is static and error-bounded. The heightfield is cut into 32-cell chunks; each chunk gets the coarsest
// grid step whose bilinear reconstruction stays within a height tolerance, so a flat valley floor costs two triangles
// and a ridge keeps every sample. Chunks are merged into blocks (one draw call each), and every block is built at
// three tolerances; the renderer picks one per block by distance. Skirts, short walls hanging down from every chunk
// edge, hide the cracks where neighbors of different resolution meet.

const CHUNK = 32, BLOCK = 4;                      // cells per chunk, chunks per block side
export const TOLERANCES = [0.25, 0.9, 3.0];       // meters of height error allowed at each block LOD

function stepFor(H, n, ci, cj, tol) {
  const x0 = ci * CHUNK, z0 = cj * CHUNK;
  for (let s = CHUNK; s > 1; s >>= 1) {
    let ok = true;
    for (let j = 0; j <= CHUNK && ok; j++) {
      const zj = z0 + j, gz = Math.floor(j / s) * s, vz = (j - gz) / s, za = z0 + gz, zb = Math.min(z0 + gz + s, n - 1);
      for (let i = 0; i <= CHUNK; i++) {
        const gx = Math.floor(i / s) * s, ux = (i - gx) / s, xa = x0 + gx, xb = Math.min(x0 + gx + s, n - 1);
        const h = H[zj * n + x0 + i];
        const e = (H[za * n + xa] * (1 - ux) + H[za * n + xb] * ux) * (1 - vz) + (H[zb * n + xa] * (1 - ux) + H[zb * n + xb] * ux) * vz;
        if (Math.abs(h - e) > tol) { ok = false; break; }
      }
    }
    if (ok) return s;
  }
  return 1;
}

class Mesh {
  constructor() { this.P = []; this.I = []; }
  get n() { return this.P.length / 3; }
  arrays() {
    const n = this.n, position = new Float32Array(this.P);
    const index = n > 65535 ? new Uint32Array(this.I) : new Uint16Array(this.I);
    return { position, index };
  }
}

// one chunk at grid step s, with skirts of depth `skirt`
function chunk(m, H, n, half, cell, ci, cj, s, skirt) {
  const k = CHUNK / s + 1, base = m.n, x0 = ci * CHUNK, z0 = cj * CHUNK;
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
    const gx = x0 + i * s, gz = z0 + j * s;
    m.P.push(-half + gx * cell, H[gz * n + gx], -half + gz * cell);
  }
  for (let j = 0; j < k - 1; j++) for (let i = 0; i < k - 1; i++) {
    const a = base + j * k + i, b = a + 1, c = a + k, d = c + 1;
    m.I.push(a, c, b, b, c, d);
  }
  // skirts: walk the four edges in order, dropping a copy of each vertex
  const edge = [];
  for (let i = 0; i < k; i++) edge.push(base + i);                       // north edge, west -> east
  for (let j = 1; j < k; j++) edge.push(base + j * k + k - 1);           // east edge
  for (let i = k - 2; i >= 0; i--) edge.push(base + (k - 1) * k + i);    // south edge
  for (let j = k - 2; j >= 1; j--) edge.push(base + j * k);              // west edge
  edge.push(base);
  const sb = m.n;
  for (const v of edge) m.P.push(m.P[v * 3], m.P[v * 3 + 1] - skirt, m.P[v * 3 + 2]);
  for (let e = 0; e < edge.length - 1; e++) {
    const a = edge[e], b = edge[e + 1], c = sb + e, d = sb + e + 1;
    m.I.push(a, b, c, b, d, c);
  }
}

// error-bounded chunked grid over a heightfield: blocks of merged chunks, one mesh per tolerance
function buildGrid(H, n, half, tolerances, sink = null) {
  const cell = 2 * half / (n - 1), nc = (n - 1) / CHUNK;
  const steps = tolerances.map(tol => {
    const st = new Uint8Array(nc * nc);
    for (let cj = 0; cj < nc; cj++) for (let ci = 0; ci < nc; ci++) st[cj * nc + ci] = stepFor(H, n, ci, cj, tol);
    return st;
  });
  const nb = Math.ceil(nc / BLOCK), blocks = [], tris = tolerances.map(() => 0);
  for (let bj = 0; bj < nb; bj++) for (let bi = 0; bi < nb; bi++) {
    const lods = [];
    let hmin = Infinity, hmax = -Infinity;
    for (let l = 0; l < tolerances.length; l++) {
      const m = new Mesh();
      for (let cj = bj * BLOCK; cj < Math.min(nc, (bj + 1) * BLOCK); cj++) for (let ci = bi * BLOCK; ci < Math.min(nc, (bi + 1) * BLOCK); ci++) {
        const s = steps[l][cj * nc + ci];
        chunk(m, H, n, half, cell, ci, cj, s, 1.5 + tolerances[l] * 2 + s * cell * 0.15);
      }
      if (sink) for (let i = 0; i < m.P.length; i += 3) if (Math.abs(m.P[i]) < sink && Math.abs(m.P[i + 2]) < sink) m.P[i + 1] -= 40;
      for (let i = 1; i < m.P.length; i += 3) { hmin = Math.min(hmin, m.P[i]); hmax = Math.max(hmax, m.P[i]); }
      tris[l] += m.I.length / 3;
      lods.push(m.arrays());
    }
    const x0 = -half + bi * BLOCK * CHUNK * cell, z0 = -half + bj * BLOCK * CHUNK * cell, size = BLOCK * CHUNK * cell;
    blocks.push({ lods, box: [x0, hmin, z0, x0 + size, hmax, z0 + size] });
  }
  return { blocks, tris };
}

export function buildTerrain(w) {
  const { height: H, n, H: half } = w, cell = 2 * half / (n - 1);
  const { blocks, tris } = buildGrid(H, n, half, TOLERANCES);
  // a deep skirt round the whole core, so the context ring never shows through at the seam
  const rim = new Mesh();
  const rimDepth = 60;
  const rimPts = [];
  for (let i = 0; i < n; i++) rimPts.push([i, 0]);
  for (let j = 1; j < n; j++) rimPts.push([n - 1, j]);
  for (let i = n - 2; i >= 0; i--) rimPts.push([i, n - 1]);
  for (let j = n - 2; j >= 0; j--) rimPts.push([0, j]);
  for (const [i, j] of rimPts) { const x = -half + i * cell, z = -half + j * cell, h = H[j * n + i]; rim.P.push(x, h, z, x, h - rimDepth, z); }
  for (let k = 0; k < rimPts.length - 1; k++) { const a = k * 2; rim.I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  return { blocks, rim: rim.arrays(), tris };
}

// normal map of the heightfield (RGBA8, xyz in 0..1, alpha 255), from central differences at full resolution
export function normalMap(H, n, cell) {
  const out = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const l = H[j * n + Math.max(0, i - 1)], r = H[j * n + Math.min(n - 1, i + 1)];
    const u = H[Math.max(0, j - 1) * n + i], d = H[Math.min(n - 1, j + 1) * n + i];
    const sx = (i > 0 && i < n - 1 ? 2 : 1) * cell, sz = (j > 0 && j < n - 1 ? 2 : 1) * cell;
    let nx = -(r - l) / sx, nz = -(d - u) / sz, ny = 1; const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    const o = (j * n + i) * 4;
    out[o] = (nx * 0.5 + 0.5) * 255; out[o + 1] = (ny * 0.5 + 0.5) * 255; out[o + 2] = (nz * 0.5 + 0.5) * 255; out[o + 3] = 255;
  }
  return out;
}

// water surfaces: a grid cell exists wherever any corner is water; its vertices sit on the water level field
export function buildWater(w) {
  const { level: L, wmask: W, n, H: half } = w, cell = 2 * half / (n - 1);
  const S = 4;                                  // water grid step in height samples: 4 x 2 m = 8 m quads
  const g = Math.floor((n - 1) / S) + 1, gc = g - 1;
  const wet = new Uint8Array(gc * gc);
  for (let j = 0; j < gc; j++) for (let i = 0; i < gc; i++) {
    let any = 0;
    for (let b = 0; b <= S && !any; b++) for (let a = 0; a <= S; a++) if (W[(j * S + b) * n + i * S + a] > 127) { any = 1; break; }
    wet[j * gc + i] = any;
  }
  const meshes = [], BW = 64;                   // cells per block side
  for (let bj = 0; bj < gc; bj += BW) for (let bi = 0; bi < gc; bi += BW) {
    const m = new Mesh(), map = new Map();
    const vid = (i, j) => {
      const k = j * g + i; let v = map.get(k);
      if (v === undefined) { v = m.n; map.set(k, v); m.P.push(-half + i * S * cell, L[(j * S) * n + i * S], -half + j * S * cell); }
      return v;
    };
    for (let j = bj; j < Math.min(gc, bj + BW); j++) for (let i = bi; i < Math.min(gc, bi + BW); i++) {
      if (!wet[j * gc + i]) continue;
      const a = vid(i, j), b = vid(i + 1, j), c = vid(i, j + 1), d = vid(i + 1, j + 1);
      m.I.push(a, c, b, b, c, d);
    }
    if (m.I.length) meshes.push(m.arrays());
  }
  return meshes;
}

// context ring: the same chunked grid with one loose tolerance, sunk 40 m inside the core box so it never pokes through
export function buildFar(w) {
  const fm = w.meta.far, F = w.farHeight, n = fm.n, half = fm.half, cell = 2 * half / (n - 1);
  const { blocks, tris } = buildGrid(F, n, half, [1.2], w.H - cell);
  return { blocks, tris: tris[0], normals: normalMap(F, n, cell) };
}
