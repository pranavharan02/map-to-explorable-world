// Foliage cards, painted on canvases at startup: broadleaf clusters, needle sprays, pine tufts, palm fronds.
// Each is an alpha-tested texture; the tree geometry places them, and mip-level alpha boosting keeps them full at range.
import * as THREE from 'three';
import { canvas, rng } from '../textures.js';

const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
// every card keeps an opaque 4 x 4 block in its top-left corner: bark vertices point their uv there, so the shared
// alpha-tested shadow material never cuts holes in trunks
function texture(cv) {
  const c = cv.getContext('2d'); c.fillStyle = 'rgb(46,40,30)'; c.fillRect(0, 0, 4, 4);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// a lobed cluster of ovate leaves: several overlapping sub-clusters, so no card reads as a disc. Leaves on the upper
// side of each lobe are lighter (they face the sky), the inside darker; `hue` shifts the green, `leafLen` the size
export function broadleafCard(seed, { hue = 95, sat = 34, light = 16, count = 950, leafLen = 9 } = {}) {
  const N = 256, cv = canvas(N), c = cv.getContext('2d'), r = rng(seed);
  const lobes = [];
  for (let k = 0, n = 5 + Math.floor(r() * 3); k < n; k++) {
    const a = r() * Math.PI * 2, d = 18 + r() * 52;
    lobes.push([128 + Math.cos(a) * d, 128 + Math.sin(a) * d * 0.9, 34 + r() * 26]);
  }
  for (let k = 0; k < count; k++) {
    const [lx, ly, lr] = lobes[Math.floor(r() * lobes.length)];
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * lr, x = lx + Math.cos(a) * d, y = ly + Math.sin(a) * d;
    if (x < 8 || y < 8 || x > N - 8 || y > N - 8) continue;
    const up = (ly - y) / lr, rim = d / lr;                  // sky side and outer edge read lighter
    const L = leafLen * (0.7 + r() * 0.6);
    c.save(); c.translate(x, y); c.rotate(r() * Math.PI * 2);
    c.fillStyle = hsl(hue + (r() - 0.5) * 20, sat + (r() - 0.5) * 16, light + r() * 9 + up * 5 + rim * 3);
    c.beginPath(); c.ellipse(0, 0, L * 0.38, L, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = hsl(hue, sat, light - 4, 0.5); c.lineWidth = 0.8;
    c.beginPath(); c.moveTo(0, -L * 0.9); c.lineTo(0, L * 0.9); c.stroke();
    c.restore();
  }
  c.strokeStyle = 'rgba(58,44,30,0.85)'; c.lineWidth = 1.5;
  for (const [lx, ly] of lobes) { c.beginPath(); c.moveTo(128, 150); c.quadraticCurveTo((128 + lx) / 2, ly + 10, lx, ly); c.stroke(); }
  return texture(cv);
}

// needle spray for spruce and fir: a twig with short needles on both sides, drooping at the tip
export function needleCard(seed, { hue = 140, light = 17 } = {}) {
  const N = 256, cv = canvas(N), c = cv.getContext('2d'), r = rng(seed);
  c.lineCap = 'round';
  for (let b = 0; b < 7; b++) {
    const y0 = 20 + b * 32 + r() * 8, x0 = 12, len = 230 - b * 14;
    for (let k = 0; k < len; k += 2.2) {
      const t = k / len, x = x0 + k, y = y0 + t * t * 26;
      for (const s of [-1, 1]) {
        const L = (16 - t * 8) * (0.7 + r() * 0.5);
        c.strokeStyle = hsl(hue + (r() - 0.5) * 16, 28 + r() * 12, light + r() * 10);
        c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + L * 0.45, y + s * L); c.stroke();
      }
    }
    c.strokeStyle = 'rgba(70,50,32,1)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x0, y0); c.quadraticCurveTo(x0 + len * 0.6, y0 + 6, x0 + len, y0 + 26); c.stroke();
  }
  return texture(cv);
}

// pine tuft: long needles bursting from a point, for umbrella and Scots pine crowns
export function pineCard(seed, { hue = 105, light = 18 } = {}) {
  const N = 256, cv = canvas(N), c = cv.getContext('2d'), r = rng(seed);
  c.lineCap = 'round';
  for (let t = 0; t < 9; t++) {
    const cx = 40 + r() * 176, cy = 40 + r() * 176;
    for (let k = 0; k < 70; k++) {
      const a = r() * Math.PI * 2, L = 18 + r() * 26;
      c.strokeStyle = hsl(hue + (r() - 0.5) * 18, 30 + r() * 12, light + r() * 12);
      c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * L, cy + Math.sin(a) * L); c.stroke();
    }
  }
  return texture(cv);
}

// pinnate palm frond: u across (rachis at 0.5), v along (base 0, tip 1)
export function frondCard(seed, { hue = 82, light = 20 } = {}) {
  const W = 128, H = 512, cv = canvas(W, H), c = cv.getContext('2d'), r = rng(seed);
  for (let y = 28; y < H - 6; y += 4.4) {
    const t = y / H, L = 60 * Math.min(1, (1 - t) * 3.2) * (0.86 + r() * 0.14);
    for (const s of [-1, 1]) {
      if (r() < 0.05) continue;
      const ang = 0.55 + r() * 0.15, ex = 64 + s * L * Math.cos(ang), ey = y + L * Math.sin(ang) * 1.05;
      c.fillStyle = hsl(hue + r() * 16, 34 + r() * 16, light + r() * 10 + t * 5);
      c.beginPath(); c.moveTo(64, y - 1.6); c.lineTo(ex, ey); c.lineTo(64, y + 1.8); c.closePath(); c.fill();
    }
  }
  c.strokeStyle = '#8a8452'; c.lineWidth = 4; c.beginPath(); c.moveTo(64, 0); c.lineTo(64, H); c.stroke();
  return texture(cv);
}
