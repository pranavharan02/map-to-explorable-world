// Six tree species, generated in code at startup: broadleaf, tall broadleaf, conifer, pine, palm and shrub.
// Each comes as a near mesh and a reduced mid-distance mesh. Geometry group 0 is bark (opaque), group 1 is foliage
// (alpha-tested cards). Foliage normals bend outward from the crown center, so a card crown shades like a volume.
import * as THREE from 'three';
import { rng } from '../textures.js';

export const DETAIL = { level: 1 };              // 0 phones, 1 integrated graphics, 2 discrete graphics
const D = (hi, med, lo) => (DETAIL.level >= 2 ? hi : DETAIL.level === 1 ? med : lo);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

class TreeBuilder {
  constructor() { this.P = []; this.N = []; this.UV = []; this.C = []; this.F = []; this.B = []; this.I = [[], []]; }
  get n() { return this.P.length / 3; }
  vert(p, n, uv, col, flex, bark = null) {
    this.P.push(p.x, p.y, p.z); this.N.push(n.x, n.y, n.z); this.UV.push(uv[0], uv[1]);
    this.C.push(col[0], col[1], col[2]); this.F.push(flex); this.B.push(bark ? bark[0] : 0, bark ? bark[1] : -1);
    return this.n - 1;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.UV, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aFlex', new THREE.Float32BufferAttribute(this.F, 1));
    g.setAttribute('aBark', new THREE.Float32BufferAttribute(this.B, 2));
    g.setIndex([...this.I[0], ...this.I[1]]);
    g.addGroup(0, this.I[0].length, 0); g.addGroup(this.I[0].length, this.I[1].length, 1);
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

// a tube along curve(t), t in 0..1, radius(t); bark coordinates are (angle 0..1, meters along the tube)
// uv points at the opaque corner block of every foliage texture, so the alpha-tested shadow pass keeps bark solid
function tube(tb, curve, radius, rings, sides, col, flex, opts = {}) {
  const base = tb.n; let along = 0, prev = curve(0);
  for (let i = 0; i <= rings; i++) {
    const t = i / rings, p = curve(t), a = curve(Math.max(0, t - 0.01)), b = curve(Math.min(1, t + 0.01));
    along += p.distanceTo(prev); prev = p;
    const T = b.clone().sub(a).normalize(), ref = Math.abs(T.y) < 0.95 ? UP : V(1, 0, 0);
    const X = ref.clone().cross(T).normalize(), Y = T.clone().cross(X).normalize(), r = radius(t);
    const shade = opts.shade ? opts.shade(t) : 1;
    for (let k = 0; k <= sides; k++) {
      const ang = k / sides * Math.PI * 2, n = X.clone().multiplyScalar(Math.cos(ang)).addScaledVector(Y, Math.sin(ang));
      tb.vert(p.clone().addScaledVector(n, r), n, [0.006, 0.006], col.map(c => c * shade), flex(t), opts.bark === false ? null : [k / sides, along]);
    }
  }
  for (let i = 0; i < rings; i++) for (let k = 0; k < sides; k++) {
    const a = base + i * (sides + 1) + k, b = a + sides + 1;
    tb.I[0].push(a, b, a + 1, a + 1, b, b + 1);
  }
}

// a square foliage card centered at c, facing roughly `out`, rolled by `roll`
function card(tb, c, out, size, roll, col, flex, crownC, uvr = [0, 0, 1, 1]) {
  const t1 = UP.clone().cross(out); if (t1.lengthSq() < 1e-4) t1.set(1, 0, 0); t1.normalize();
  const t2 = out.clone().cross(t1).normalize();
  const X = t1.clone().multiplyScalar(Math.cos(roll)).addScaledVector(t2, Math.sin(roll)).multiplyScalar(size / 2);
  const Y = t2.clone().multiplyScalar(Math.cos(roll)).addScaledVector(t1, -Math.sin(roll)).multiplyScalar(size / 2);
  const base = tb.n;
  for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = c.clone().addScaledVector(X, i).addScaledVector(Y, j);
    const n = p.clone().sub(crownC).normalize().multiplyScalar(0.7).addScaledVector(out, 0.3).add(V(0, 0.22, 0)).normalize();
    tb.vert(p, n, [uvr[0] + (i * 0.5 + 0.5) * (uvr[2] - uvr[0]), uvr[1] + (j * 0.5 + 0.5) * (uvr[3] - uvr[1])], col, flex);
  }
  tb.I[1].push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// a drooping strip along a rachis (palm fronds); texture u across, v along
function frond(tb, origin, az, elev, len, segs, width, droop, col, crownC, flex0) {
  let dir = V(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az));
  const side = V(Math.cos(az), 0, -Math.sin(az));
  let p = origin.clone(); const pts = [];
  for (let k = 0; k <= segs; k++) {
    pts.push({ p: p.clone(), d: dir.clone() });
    p.addScaledVector(dir, len / segs);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y))) - droop * (0.6 + k / segs);
    dir = V(Math.cos(pitch) * Math.sin(az), Math.sin(pitch), Math.cos(pitch) * Math.cos(az));
  }
  for (const s of [-1, 1]) {
    const base = tb.n;
    for (let k = 0; k <= segs; k++) {
      const { p: q, d } = pts[k], t = k / segs, w = width(t);
      const down = side.clone().cross(d).normalize(); if (down.y > 0) down.negate();
      const edge = q.clone().addScaledVector(side, s * w * 0.9).addScaledVector(down, w * 0.35);
      for (const [pt, u] of [[q, 0.5], [edge, 0.5 + s * 0.5]]) {
        const n = pt.clone().sub(crownC).normalize().add(V(0, 0.6, 0)).normalize();
        tb.vert(pt, n, [u, t], col, flex0 + (1 - flex0) * t);
      }
    }
    for (let k = 0; k < segs; k++) { const a = base + k * 2; tb.I[1].push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
}

function randPerp(dir, r) {
  const a = Math.abs(dir.y) < 0.9 ? UP : V(1, 0, 0);
  return a.clone().cross(dir).normalize().applyAxisAngle(dir, r() * Math.PI * 2);
}

const BARK = { grey: [0.14, 0.125, 0.11], brown: [0.13, 0.1, 0.075], red: [0.2, 0.11, 0.07], palm: [0.2, 0.18, 0.15], pale: [0.34, 0.32, 0.29] };

// broadleaf crowns: limbs that fork two or three times, foliage cards at the tips, and infill so the crown is not a shell
function broadleaf(lod, seed, o) {
  const r = rng(seed), tb = new TreeBuilder();
  const top = V((r() - 0.5) * 0.4, o.trunkH, (r() - 0.5) * 0.4);
  tube(tb, t => V(0, 0, 0).lerp(top, t).add(V(Math.sin(t * 3 + seed) * 0.08, 0, 0)), t => o.trunkR * (1 - 0.3 * t) + 0.1 * Math.exp(-t * 9), lod ? 2 : 4, lod ? 5 : 8, o.bark, t => 0.03 * t);
  const tips = [], depth = lod ? 2 : D(3, 3, 2);
  const grow = (p0, dir, len, rad, d) => {
    const p1 = p0.clone().addScaledVector(dir, len), sag = V(0, -len * 0.05, 0);
    if (!lod || d >= depth - 1) tube(tb, t => p0.clone().lerp(p1, t).addScaledVector(sag, Math.sin(Math.PI * t)), t => rad * (1 - 0.35 * t), 2, d >= depth - 1 ? 5 : 3, o.bark, t => 0.06 + 0.16 * (1 - d / depth) * t);
    if (d === 0 || len < 0.5) { tips.push({ p: p1, d: dir.clone() }); return; }
    if (d === 1) tips.push({ p: p0.clone().lerp(p1, 0.6), d: dir.clone() });
    const kids = 2 + (r() < 0.45 ? 1 : 0);
    for (let k = 0; k < kids; k++) {
      let nd = dir.clone().applyAxisAngle(randPerp(dir, r), o.spread * (0.55 + 0.8 * r()));
      const out = p1.clone().sub(o.crown); out.y *= 0.5; out.normalize();
      nd.lerp(out, 0.3).normalize(); if (nd.y < -0.1) { nd.y = -0.1; nd.normalize(); }
      grow(p1, nd, len * 0.7 * (0.85 + 0.3 * r()), rad * 0.62, d - 1);
    }
  };
  for (let k = 0; k < o.limbs; k++) {
    const az = k / o.limbs * Math.PI * 2 + r() * 0.6, el = o.elev[0] + r() * (o.elev[1] - o.elev[0]);
    grow(top, V(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)), o.limb * (0.85 + 0.3 * r()), o.trunkR * 0.55, depth);
  }
  grow(top, V((r() - 0.5) * 0.2, 1, (r() - 0.5) * 0.2).normalize(), o.limb * 0.95, o.trunkR * 0.5, depth);
  const C = o.crown, size = lod ? o.card * 2.4 : o.card * D(1.35, 1.5, 1.8), per = lod ? 1 : D(3, 3, 2);
  for (const tp of tips) {
    const c = tp.p.clone().addScaledVector(tp.d, 0.25), out = c.clone().sub(C); out.y *= 0.7; out.normalize();
    const depthK = Math.min(1, c.clone().sub(C).multiply(V(1 / o.rx, 1 / o.ry, 1 / o.rx)).length());
    const sh = 0.5 + 0.5 * depthK;
    for (let k = 0; k < per; k++) {
      const o2 = out.clone().applyAxisAngle(tp.d, k / per * Math.PI * 1.2).lerp(out, 0.3).normalize();
      card(tb, c.clone().addScaledVector(o2, 0.1 * k), o2, size * (0.8 + r() * 0.45), r() * Math.PI, [sh * (0.92 + r() * 0.16), sh * (0.95 + r() * 0.1), sh * (0.88 + r() * 0.1)], 0.3 + 0.25 * depthK, C);
    }
  }
  const infill = Math.round(tips.length * (lod ? 0.7 : 0.45));
  for (let k = 0; k < infill; k++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, rr = Math.sqrt(1 - u * u), f = 0.35 + 0.4 * r();
    const c = C.clone().add(V(rr * Math.cos(a) * o.rx * f, u * o.ry * f, rr * Math.sin(a) * o.rx * f)), out = c.clone().sub(C).normalize(), sh = 0.42 + 0.2 * f;
    card(tb, c, out, size * 1.15, r() * Math.PI, [sh, sh * 1.02, sh * 0.88], 0.25, C);
  }
  return tb.build();
}

// spruce or fir: whorls of drooping branches shortening to the tip, needle sprays along each
function conifer(lod, seed) {
  const r = rng(seed), tb = new TreeBuilder(), Ht = 19 + r() * 3, base = 2.2, R0 = 3.3;
  tube(tb, t => V(Math.sin(t * 5 + seed) * 0.04, Ht * t, 0), t => 0.3 * (1 - t) + 0.02, lod ? 3 : 8, lod ? 4 : 7, BARK.red, t => 0.25 * t * t);
  const whorls = lod ? 9 : D(22, 16, 12), C = V(0, Ht * 0.42, 0);
  for (let w = 0; w < whorls; w++) {
    const t = w / whorls, y = base + (Ht - base - 0.6) * t, reach = R0 * Math.pow(1 - t, 1.05) + 0.25;
    const nb = lod ? 4 : D(7, 6, 5);
    for (let b = 0; b < nb; b++) {
      const az = b / nb * Math.PI * 2 + w * 0.7 + r() * 0.4, droop = 0.25 + 0.35 * (1 - t);
      const dir = V(Math.sin(az), -droop * 0.6 + 0.12, Math.cos(az)).normalize();
      const p0 = V(0, y, 0), p1 = p0.clone().addScaledVector(dir, reach);
      if (!lod && t < 0.85) tube(tb, s => p0.clone().lerp(p1, s).add(V(0, -Math.sin(s * Math.PI) * reach * 0.06, 0)), s => 0.05 * (1 - s) + 0.01, 1, 3, BARK.brown, s => 0.15 + 0.4 * s);
      const cards = lod ? 1 : D(3, 2, 2);
      for (let k = 0; k < cards; k++) {
        const f = (k + 0.6) / cards, c = p0.clone().lerp(p1, f).add(V(0, -0.15 * f, 0));
        const out = dir.clone().add(V(0, 0.35, 0)).normalize();
        const sh = 0.55 + 0.45 * (1 - Math.abs(t - 0.4));
        card(tb, c, out, (lod ? 2.4 : 1.6) * (0.5 + 0.7 * (1 - t)), az + r() * 0.5, [sh * 0.95, sh, sh * 0.92], 0.2 + 0.5 * t, C);
      }
    }
  }
  card(tb, V(0, Ht - 0.2, 0), V(0.2, 1, 0).normalize(), 1.4, 0, [1, 1, 1], 0.6, C);
  return tb.build();
}

// pine: a tall, slightly kinked bare trunk under an irregular, flattish crown of needle tufts
function pine(lod, seed) {
  const r = rng(seed), tb = new TreeBuilder(), Ht = 13 + r() * 3;
  const kink = V((r() - 0.5) * 1.2, 0, (r() - 0.5) * 1.2);
  tube(tb, t => V(0, Ht * t, 0).addScaledVector(kink, Math.sin(t * Math.PI * 0.8) * t), t => 0.26 * (1 - 0.6 * t) + 0.03, lod ? 3 : 8, lod ? 4 : 7, BARK.red, t => 0.12 * t * t, { shade: t => 0.75 + 0.35 * t });
  const top = V(0, Ht, 0).add(kink.clone().multiplyScalar(0.95)), C = top.clone().add(V(0, -0.8, 0));
  const limbs = lod ? 5 : D(8, 7, 6);
  for (let k = 0; k < limbs; k++) {
    const az = k / limbs * Math.PI * 2 + r() * 0.5, el = 0.25 + r() * 0.6, len = 2.2 + r() * 2;
    const p0 = top.clone().add(V(0, -1.8 - r() * 1.6, 0)), dir = V(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    const p1 = p0.clone().addScaledVector(dir, len);
    if (!lod) tube(tb, s => p0.clone().lerp(p1, s), s => 0.09 * (1 - 0.6 * s), 1, 4, BARK.red, s => 0.2 + 0.3 * s);
    const tufts = lod ? 2 : D(6, 4, 3);
    for (let q = 0; q < tufts; q++) {
      const c = p1.clone().add(V((r() - 0.5) * 1.6, (r() - 0.2) * 0.9, (r() - 0.5) * 1.6)), out = c.clone().sub(C).normalize();
      const sh = 0.6 + 0.4 * Math.max(0, out.y);
      card(tb, c, out.lerp(UP, 0.4).normalize(), (lod ? 2.8 : 2.0) * (0.8 + r() * 0.4), r() * 3, [sh, sh, sh * 0.95], 0.4, C);
    }
  }
  return tb.build();
}

// palm: a curved, ringed trunk and a crown of pinnate fronds
function palm(lod, seed) {
  const r = rng(seed), tb = new TreeBuilder(), L = 12, lean = 0.08 + r() * 0.2, ph = seed * 1.3;
  const curve = t => V(lean * L * Math.pow(t, 1.6) + Math.sin(t * 4 + ph) * 0.2 * t, L * t * (1 - lean * lean * 0.3), Math.sin(t * 3 + ph) * 0.12 * t);
  tube(tb, curve, t => 0.17 + 0.04 * (1 - t) + 0.12 * Math.exp(-t * L / 0.5), lod ? 5 : 14, lod ? 5 : 8, BARK.palm, t => 0.35 * t * t, { shade: t => 0.75 + 0.25 * Math.min(1, t * 4) });
  const top = curve(1), C = top.clone().add(V(0, 0.4, 0));
  tube(tb, t => top.clone().add(V(0, -0.5 + t * 0.8, 0)), t => 0.22 + 0.06 * Math.sin(Math.PI * t), 1, lod ? 5 : 8, [0.25, 0.19, 0.12], () => 0.35, { bark: false });
  const NF = lod ? 10 : D(20, 16, 12), segs = lod ? 3 : D(6, 5, 4);
  for (let f = 0; f < NF; f++) {
    const layer = (f + r() * 0.5) / NF, az = f * 2.39996 + r() * 0.25;
    const elev = layer < 0.08 ? 1.3 : 1.0 - 1.5 * Math.pow(layer, 0.9) + (r() - 0.5) * 0.14;
    const len = (4.2 + 1.2 * Math.sin(Math.PI * Math.min(1, layer * 1.2 + 0.08))) * (0.9 + r() * 0.2);
    const tint = layer > 0.82 ? [1.0, 0.9, 0.62] : [0.9 + r() * 0.1, 0.93 + r() * 0.08, 0.8 + r() * 0.08];
    frond(tb, top.clone().add(V(0, 0.2, 0)), az, elev, len, segs, t => 0.95 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.95)), 0.5), 0.08 + layer * 0.14, tint, C, 0.25);
  }
  return tb.build();
}

function shrub(lod, seed) {
  const r = rng(seed), tb = new TreeBuilder(), C = V(0, 0.8, 0);
  for (let k = 0; k < (lod ? 2 : 5); k++) { const a = r() * 6.28; tube(tb, t => V(Math.cos(a) * 0.35 * t, 0.9 * t, Math.sin(a) * 0.35 * t), () => 0.025, 1, 3, BARK.brown, () => 0); }
  const n = lod ? 9 : D(26, 16, 11), size = lod ? 1.15 : D(0.7, 0.85, 1.0);
  for (let k = 0; k < n; k++) {
    const u = Math.pow(r(), 0.6), a = r() * 6.28, rr = Math.sqrt(1 - u * u);
    const c = C.clone().add(V(rr * Math.cos(a) * 0.85, u * 0.75 - 0.15, rr * Math.sin(a) * 0.85)), out = c.clone().sub(C).normalize(), sh = 0.6 + 0.4 * u;
    card(tb, c, out, size * (0.8 + r() * 0.4), r() * Math.PI, [sh, sh, sh * 0.9], 0.3, C);
  }
  return tb.build();
}

// Species table. The index matches the pipeline's species codes (pipeline/build/trees.py).
// crownY: above this height, instance y-stretch is undone, so tall and short palms and pines share one crown.
export function makeSpecies() {
  const broad = { trunkH: 3.0, trunkR: 0.28, limbs: 5, elev: [0.5, 1.0], limb: 3.2, spread: 0.62, crown: V(0, 7.4, 0), rx: 4.8, ry: 3.8, card: 1.35, bark: BARK.grey };
  const tall = { trunkH: 4.2, trunkR: 0.24, limbs: 6, elev: [1.05, 1.35], limb: 3.6, spread: 0.42, crown: V(0, 11.5, 0), rx: 2.7, ry: 6.2, card: 1.15, bark: BARK.pale };
  return [
    { name: 'broad', near: broadleaf(0, 4, broad), mid: broadleaf(1, 4, broad), wind: 0.6, coll: 0.35, maxD: 3200 },
    { name: 'tall', near: broadleaf(0, 9, tall), mid: broadleaf(1, 9, tall), wind: 0.8, coll: 0.3, maxD: 3200 },
    { name: 'conifer', near: conifer(0, 5), mid: conifer(1, 5), wind: 0.35, coll: 0.35, maxD: 3200 },
    { name: 'pine', near: pine(0, 7), mid: pine(1, 7), wind: 0.4, coll: 0.3, crownY: 9.5, maxD: 3200 },
    { name: 'palm', near: palm(0, 3), mid: palm(1, 3), wind: 1.0, coll: 0.25, crownY: 11.2, maxD: 3200 },
    { name: 'shrub', near: shrub(0, 2), mid: shrub(1, 2), wind: 0.5, coll: 0.55, maxD: 500 },
  ];
}
