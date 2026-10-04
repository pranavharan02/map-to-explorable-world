// Procedural textures, generated at startup in a few milliseconds each: nothing here is downloaded.
import * as THREE from 'three';

// a 2D canvas: a DOM canvas on the main thread (the safest texture source), an OffscreenCanvas in workers
export function canvas(w, h = w) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

// small, fast, seedable PRNG (mulberry32)
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// tileable value noise: `cells` lattice cells per side, smoothstep-interpolated
function lattice(N, cells, seed) {
  const r = rng(seed), g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(N * N), s = cells / N;
  for (let y = 0; y < N; y++) {
    const fy = y * s, j = fy | 0; let v = fy - j; v = v * v * (3 - 2 * v);
    const j0 = (j % cells) * cells, j1 = ((j + 1) % cells) * cells;
    for (let x = 0; x < N; x++) {
      const fx = x * s, i = fx | 0; let u = fx - i; u = u * u * (3 - 2 * u);
      const i0 = i % cells, i1 = (i + 1) % cells;
      out[y * N + x] = (g[j0 + i0] * (1 - u) + g[j0 + i1] * u) * (1 - v) + (g[j1 + i0] * (1 - u) + g[j1 + i1] * u) * v;
    }
  }
  return out;
}
function fbm(N, base, octaves, seed) {
  const o = new Float32Array(N * N); let a = 0.5, tot = 0;
  for (let k = 0; k < octaves; k++) {
    const n = lattice(N, base << k, seed * 7 + k * 131);
    for (let i = 0; i < o.length; i++) o[i] += n[i] * a;
    tot += a; a *= 0.5;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < o.length; i++) { o[i] /= tot; lo = Math.min(lo, o[i]); hi = Math.max(hi, o[i]); }
  for (let i = 0; i < o.length; i++) o[i] = (o[i] - lo) / (hi - lo);
  return o;
}
function dataTexture(px, N, srgb = false) {
  const t = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

// four independent fbm fields at different frequencies, one per channel
export function noiseTexture() {
  const N = 256, ch = [fbm(N, 4, 4, 1), fbm(N, 8, 4, 2), fbm(N, 16, 4, 3), fbm(N, 32, 3, 4)];
  const px = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 4; c++) px[i * 4 + c] = ch[c][i] * 255;
  return dataTexture(px, N);
}

// tileable ripple normals: broad swell plus fine cat's-paw ripples
export function waterNormals() {
  const N = 256, a = fbm(N, 8, 3, 11), b = fbm(N, 32, 2, 12), px = new Uint8Array(N * N * 4), k = 6.5;
  const h = (x, y) => { x = (x + N) % N; y = (y + N) % N; return a[y * N + x] * 0.7 + b[y * N + x] * 0.3; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let nx = (h(x - 1, y) - h(x + 1, y)) * k, ny = (h(x, y - 1) - h(x, y + 1)) * k; const l = Math.hypot(nx, ny, 1);
    const o = (y * N + x) * 4; px[o] = (nx / l * 0.5 + 0.5) * 255; px[o + 1] = (ny / l * 0.5 + 0.5) * 255; px[o + 2] = (1 / l * 0.5 + 0.5) * 255; px[o + 3] = 255;
  }
  return dataTexture(px, N);
}

// 4 m close-range ground detail (grain, pebbles, leaf litter, twigs), centered on mid-gray so it multiplies albedo
export function groundDetail() {
  const N = 512, cv = canvas(N), c = cv.getContext('2d'), r = rng(5);
  c.fillStyle = '#808080'; c.fillRect(0, 0, N, N);
  const tiled = (fn) => { for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) { c.save(); c.translate(dx, dy); fn(); c.restore(); } };
  for (let k = 0; k < 36; k++) {
    const x = r() * N, y = r() * N, rad = 12 + r() * 46, g = 96 + r() * 26;
    tiled(() => { const gr = c.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, `rgba(${g},${g - 4},${g - 10},0.45)`); gr.addColorStop(1, 'rgba(128,128,128,0)'); c.fillStyle = gr; c.fillRect(x - rad, y - rad, 2 * rad, 2 * rad); });
  }
  for (let k = 0; k < 15000; k++) { const v = 104 + r() * 64; c.fillStyle = `rgb(${v},${v - 2},${v - 5})`; c.fillRect(r() * N, r() * N, 1 + r(), 1 + r()); }
  for (let k = 0; k < 420; k++) {
    const x = r() * N, y = r() * N, rr = 1.5 + r() * 3.5, v = 92 + r() * 70;
    tiled(() => { c.fillStyle = `rgb(${v},${v - 3},${v - 8})`; c.beginPath(); c.ellipse(x, y, rr, rr * (0.6 + r() * 0.4), r() * 3, 0, 6.283); c.fill(); });
  }
  for (let k = 0; k < 220; k++) {
    const x = r() * N, y = r() * N, a = r() * Math.PI, L = 4 + r() * 11, br = 118 + r() * 50;
    tiled(() => { c.save(); c.translate(x, y); c.rotate(a); c.fillStyle = `rgb(${br + 26},${br},${br - 40})`; c.beginPath(); c.ellipse(0, 0, L, 1 + r() * 2, 0, 0, 6.283); c.fill(); c.restore(); });
  }
  c.lineCap = 'round';
  for (let k = 0; k < 50; k++) { const x = r() * N, y = r() * N, a = r() * Math.PI, L = 8 + r() * 26, v = 72 + r() * 26; tiled(() => { c.strokeStyle = `rgb(${v + 8},${v},${v - 8})`; c.lineWidth = 1 + r(); c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); c.stroke(); }); }
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.NoColorSpace;
  return t;
}

// grass tuft card: blades of mixed green and straw
export function grassCard() {
  const W = 128, cv = canvas(W), c = cv.getContext('2d'), r = rng(19);
  for (let k = 0; k < 64; k++) {
    const x = 8 + r() * 112, h = 46 + r() * 78, lean = (r() - 0.5) * 36, g = 112 + r() * 70, dry = r() < 0.22;
    c.strokeStyle = dry ? `rgb(${g + 44},${g + 30},${g * 0.5})` : `rgb(${g * 0.6 + 10},${g * 0.92},${g * 0.32})`;
    c.lineWidth = 1.1 + r() * 1.6;
    c.beginPath(); c.moveTo(x, W); c.quadraticCurveTo(x + lean * 0.3, W - h * 0.6, x + lean, W - h); c.stroke();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
