// World package loader: world.json + world.bin + the data images, decoded to typed arrays, plus CPU-side samplers.
// Runs on the main thread and inside the build workers (each worker decodes only the layers it needs).
//
// Frame: three.js x = east, y = up, z = south. Package coordinates are (x east, y north), so z = -y.
// Images have row 0 at the north edge, so with flipY off, texture v = (z + half) / (2 half).
// Heightfields are point grids (n samples per side, edges included); everything else is an area grid.
import * as THREE from 'three';

const DT = { int16: Int16Array, uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array, float32: Float32Array };

export async function fetchBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

// RGBA bytes of a bitmap. Data images carry no alpha on the CPU side, so canvas premultiplication cannot touch them.
export function pixels(bmp) {
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  return cx.getImageData(0, 0, bmp.width, bmp.height).data;
}

// 16-bit values split across R (high byte) and G (low byte)
function decode16(px, lo, scale) {
  const n = px.length >> 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (px[i * 4] * 256 + px[i * 4 + 1]) * scale + lo;
  return out;
}

function channel(px, c, f = 1, off = 0) {
  const n = px.length >> 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (px[i * 4 + c] + off) * f;
  return out;
}

// bilinear sample of a point grid (n x n over [-H, H]^2)
export function pointSampler(arr, n, H) {
  const k = (n - 1) / (2 * H);
  return (x, z) => {
    let fx = (x + H) * k, fz = (z + H) * k;
    fx = fx < 0 ? 0 : fx > n - 1.0001 ? n - 1.0001 : fx;
    fz = fz < 0 ? 0 : fz > n - 1.0001 ? n - 1.0001 : fz;
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, o = j * n + i;
    return (arr[o] * (1 - u) + arr[o + 1] * u) * (1 - v) + (arr[o + n] * (1 - u) + arr[o + n + 1] * u) * v;
  };
}

// bilinear sample of an area grid (n x n pixels over [-H, H]^2, pixel centers at the half steps)
export function areaSampler(arr, n, H) {
  const k = n / (2 * H);
  return (x, z) => {
    let fx = (x + H) * k - 0.5, fz = (z + H) * k - 0.5;
    fx = fx < 0 ? 0 : fx > n - 1.0001 ? n - 1.0001 : fx;
    fz = fz < 0 ? 0 : fz > n - 1.0001 ? n - 1.0001 : fz;
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, o = j * n + i;
    return (arr[o] * (1 - u) + arr[o + 1] * u) * (1 - v) + (arr[o + n] * (1 - u) + arr[o + n + 1] * u) * v;
  };
}

const ALL = { bin: true, height: true, water: true, mask: true, far: true, images: true };

export async function loadWorld(base, need = ALL) {
  const meta = await (await fetch(base + 'world.json')).json();
  const H = meta.half, far = meta.far;
  const want = [];
  if (need.height) want.push('height.webp');
  if (need.water) want.push('water.webp');
  if (need.mask || need.images) want.push('mask.webp');
  if (need.images) want.push('cover.webp', 'ground.webp', 'color.webp');
  if (far && (need.far || need.images)) want.push('farh.webp');
  if (far && need.images) want.push('far.webp');
  const [bin, ...bmps] = await Promise.all([
    need.bin ? fetch(base + 'world.bin').then(r => r.arrayBuffer()) : null,
    ...want.map(f => fetchBitmap(base + f)),
  ]);
  const img = Object.fromEntries(want.map((f, i) => [f.replace('.webp', ''), bmps[i]]));
  const S = {};
  if (bin) for (const [name, [off, n, dt]] of Object.entries(meta.sections)) S[name] = new DT[dt](bin, off, n);

  const w = { meta, base, H, S, img, n: meta.height.n };
  const hm = meta.height;
  if (img.height) {
    w.height = decode16(pixels(img.height), hm.lo, hm.scale);
    w.heightAt = pointSampler(w.height, hm.n, H);
  }
  if (img.water) {
    const px = pixels(img.water);
    w.level = decode16(px, hm.lo, hm.scale);
    w.wmask = new Uint8Array(hm.n * hm.n);
    for (let i = 0; i < w.wmask.length; i++) w.wmask[i] = px[i * 4 + 2];
    w.levelAt = pointSampler(w.level, hm.n, H);
    const wm = pointSampler(channel(px, 2, 1 / 255), hm.n, H);
    w.waterAt = (x, z) => wm(x, z);
  }
  if (img.mask) {
    const px = pixels(img.mask), M = meta.mask.n;
    w.shore = channel(px, 0, meta.mask.shoreScale, -128);
    w.road = channel(px, 1, meta.mask.roadScale, -128);
    w.shoreAt = areaSampler(w.shore, M, H);
    w.roadAt = areaSampler(w.road, M, H);
  }
  if (img.farh) {
    const fm = meta.far;
    w.farHeight = decode16(pixels(img.farh), fm.lo, fm.scale);
    w.farHeightAt = pointSampler(w.farHeight, fm.n, fm.half);
  }
  // ground height anywhere: the core heightfield inside the core, the context ring outside it
  w.groundAt = (x, z) => (Math.abs(x) <= H && Math.abs(z) <= H) || !w.farHeightAt ? w.heightAt(x, z) : w.farHeightAt(x, z);
  return w;
}

// GPU textures for the main thread
export function worldTextures(w) {
  const t = (bmp, srgb, mips = true) => {
    const tx = new THREE.Texture(bmp);
    tx.flipY = false; tx.needsUpdate = true;
    tx.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
    tx.generateMipmaps = mips;
    tx.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tx.anisotropy = 4;
    return tx;
  };
  const f32 = (arr, n) => {
    const tx = new THREE.DataTexture(arr, n, n, THREE.RedFormat, THREE.FloatType);
    tx.minFilter = tx.magFilter = THREE.NearestFilter; tx.generateMipmaps = false; tx.needsUpdate = true;
    return tx;
  };
  const out = {
    mask: t(w.img.mask, false), cover: t(w.img.cover, false), ground: t(w.img.ground, false), color: t(w.img.color, true),
    height: f32(w.height, w.n), level: f32(w.level, w.n),
  };
  if (w.img.far) { out.far = t(w.img.far, false); out.farHeight = f32(w.farHeight, w.meta.far.n); }
  return out;
}

// GLSL: exact bilinear height from an R32F point-grid texture (manual, so it works without float-linear filtering)
export const HEIGHT_GLSL = /* glsl */`
  float gridHeight(sampler2D t, float n, float ext, vec2 xz) {
    vec2 f = clamp((xz + ext) / (2.0 * ext) * (n - 1.0), vec2(0.0), vec2(n - 1.001));
    ivec2 i = ivec2(floor(f)); vec2 u = f - vec2(i);
    float a = texelFetch(t, i, 0).r, b = texelFetch(t, i + ivec2(1, 0), 0).r;
    float c = texelFetch(t, i + ivec2(0, 1), 0).r, d = texelFetch(t, i + ivec2(1, 1), 0).r;
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }`;
