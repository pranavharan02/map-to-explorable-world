// Worker side: every building and bridge in the package, merged into a grid of chunk meshes (one draw call each).
//
// Geometry stays simple: extruded walls, and flat, gabled, hipped, pyramidal, skillion or domed roofs. The detail is
// drawn by the fragment shader from per-vertex surface coordinates (meters along the wall, meters above the floor),
// so windows, doors, storeys and roof courses keep true scale on every building without a single texture.
import { ShapeUtils, Vector2 } from 'three';

export const MAT = { WALL: 0, ROOF: 1, FLAT: 2, PARAPET: 3, TRIM: 5, GABLE: 6, DOME: 7, DECK: 8, CONCRETE: 9, RAIL: 10 };
const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

class Builder {
  // growable typed arrays written in place, so building 10,000 houses allocates almost nothing
  constructor() { this.n = 0; this.cap = 0; this.grow(4096); }
  grow(cap) {
    const P = new Float32Array(cap * 3), N = new Int8Array(cap * 3), C = new Uint8Array(cap * 3), S = new Float32Array(cap * 2), I = new Float32Array(cap * 4);
    if (this.cap) { P.set(this.P); N.set(this.N); C.set(this.C); S.set(this.S); I.set(this.I); }
    Object.assign(this, { P, N, C, S, I, cap });
  }
  v(x, y, z, nx, ny, nz, s, t, col, info) {
    if (this.n === this.cap) this.grow(this.cap * 2);
    const k = this.n++;
    this.P[k * 3] = x; this.P[k * 3 + 1] = y; this.P[k * 3 + 2] = z;
    this.N[k * 3] = nx * 127; this.N[k * 3 + 1] = ny * 127; this.N[k * 3 + 2] = nz * 127;
    this.C[k * 3] = col[0] * 255; this.C[k * 3 + 1] = col[1] * 255; this.C[k * 3 + 2] = col[2] * 255;
    this.S[k * 2] = s; this.S[k * 2 + 1] = t;
    this.I[k * 4] = info[0]; this.I[k * 4 + 1] = info[1]; this.I[k * 4 + 2] = info[2]; this.I[k * 4 + 3] = info[3];
  }
  // triangle with its own flat normal
  tri(a, b, c, sa, sb, sc, col, info) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.v(...a, nx, ny, nz, sa[0], sa[1], col, info); this.v(...b, nx, ny, nz, sb[0], sb[1], col, info); this.v(...c, nx, ny, nz, sc[0], sc[1], col, info);
  }
  quad(a, b, c, d, sa, sb, sc, sd, col, info) { this.tri(a, b, c, sa, sb, sc, col, info); this.tri(a, c, d, sa, sc, sd, col, info); }
  arrays() {
    const n = this.n;
    return { position: this.P.slice(0, n * 3), normal: this.N.slice(0, n * 3), color: this.C.slice(0, n * 3), aSurf: this.S.slice(0, n * 2), aInfo: this.I.slice(0, n * 4) };
  }
}

function signedArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

// minimum-area rectangle aligned to one of the ring's edges: the frame pitched roofs are built in
function orientedBox(r) {
  let best = null;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    if (L < 0.5) continue;
    const ux = dx / L, uz = dz / L; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of r) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, ux, uz, u0, u1, v0, v1 };
  }
  return best;
}

// walls of one ring between y0 and y1; t is measured from floor0 so window rows line up all round the building
function walls(B, ring, y0, y1, floor0, col, mat, kind, seed) {
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 0.05) continue;
    const nx = (q[1] - p[1]) / L, nz = -(q[0] - p[0]) / L;           // outward for counter-clockwise outer rings
    const info = [mat, L, y1 - floor0, seed + 256 * kind + (i % 7) * 0.01];
    const ta = y0 - floor0, tb = y1 - floor0;
    // wound so the front face looks outward (the material is double-sided, so the winding decides the lit side)
    B.v(p[0], y0, p[1], nx, 0, nz, 0, ta, col, info); B.v(q[0], y1, q[1], nx, 0, nz, L, tb, col, info); B.v(q[0], y0, q[1], nx, 0, nz, L, ta, col, info);
    B.v(p[0], y0, p[1], nx, 0, nz, 0, ta, col, info); B.v(p[0], y1, p[1], nx, 0, nz, 0, tb, col, info); B.v(q[0], y1, q[1], nx, 0, nz, L, tb, col, info);
  }
}

function flatRoof(B, outer, holes, y, col, seed, kind) {
  const contour = outer.map(p => new Vector2(p[0], p[1])), hs = holes.map(h => h.map(p => new Vector2(p[0], p[1])));
  let tris;
  try { tris = ShapeUtils.triangulateShape(contour, hs); } catch { return; }
  const all = outer.concat(...holes), info = [MAT.FLAT, 0, 0, seed + 256 * kind];
  for (const [a, b, c] of tris) {
    const A = all[a]; let Bp = all[b], C = all[c];
    if ((Bp[1] - A[1]) * (C[0] - A[0]) - (Bp[0] - A[0]) * (C[1] - A[1]) < 0) [Bp, C] = [C, Bp];   // front face up
    B.v(A[0], y, A[1], 0, 1, 0, A[0], A[1], col, info); B.v(Bp[0], y, Bp[1], 0, 1, 0, Bp[0], Bp[1], col, info); B.v(C[0], y, C[1], 0, 1, 0, C[0], C[1], col, info);
  }
}

function parapet(B, ring, y, h, col, seed, kind) {
  const inset = 0.25, info = [MAT.PARAPET, 0, h, seed + 256 * kind];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 0.05) continue;
    const nx = (q[1] - p[1]) / L, nz = -(q[0] - p[0]) / L, ix = -nx * inset, iz = -nz * inset;
    B.quad([p[0], y, p[1]], [q[0], y, q[1]], [q[0], y + h, q[1]], [p[0], y + h, p[1]], [0, 0], [L, 0], [L, h], [0, h], col, info);
    B.quad([q[0] + ix, y, q[1] + iz], [p[0] + ix, y, p[1] + iz], [p[0] + ix, y + h, p[1] + iz], [q[0] + ix, y + h, q[1] + iz], [0, 0], [L, 0], [L, h], [0, h], col, info);
    B.quad([p[0], y + h, p[1]], [q[0], y + h, q[1]], [q[0] + ix, y + h, q[1] + iz], [p[0] + ix, y + h, p[1] + iz], [0, 0], [L, 0], [L, inset], [0, inset], col, info);
  }
}

// pitched roofs over the oriented box; returns false when the footprint is too irregular for one
function pitchedRoof(B, outer, shape, y0, pitch, roofH, wallCol, roofCol, seed, kind) {
  const box = orientedBox(outer); if (!box) return false;
  const ov = 0.35, u0 = box.u0 - ov, u1 = box.u1 + ov, v0 = box.v0 - ov, v1 = box.v1 + ov;
  const lenU = u1 - u0, lenV = v1 - v0, along = lenU >= lenV;   // the ridge runs along the long side
  const W = along ? lenV : lenU, Lr = along ? lenU : lenV;
  const rise = roofH > 0 ? roofH : Math.min(W / 2 * Math.tan(pitch), 14);
  // local frame: a along the ridge, c across it; corner(a, c, y) -> world [x, y, z]
  const P = (a, c, y) => {
    const u = along ? u0 + a : u0 + c, v = along ? v0 + c : v0 + a;
    return [u * box.ux - v * box.uz, y, u * box.uz + v * box.ux];
  };
  const info = [MAT.ROOF, 0, 0, seed + 256 * kind], top = y0 + rise, slope = Math.hypot(W / 2, rise);
  const A0 = P(0, 0, y0), A1 = P(Lr, 0, y0), A2 = P(Lr, W, y0), A3 = P(0, W, y0);
  const quad = (a, b, c, d, sl, len) => B.quad(a, b, c, d, [0, 0], [len, 0], [len, sl], [0, sl], roofCol, info);
  if (shape === 4) {                                            // skillion: one slope rising across the box
    const H1 = P(Lr, W, y0 + rise), H0 = P(0, W, y0 + rise);
    quad(A1, A0, H0, H1, Math.hypot(W, rise), Lr);
    const g = [MAT.GABLE, W, rise, seed + 256 * kind];
    B.tri(A0, A3, H0, [0, 0], [W, 0], [W, rise], wallCol, g); B.tri(A2, A1, H1, [0, 0], [W, 0], [0, rise], wallCol, g);
    B.quad(A3, A2, H1, H0, [0, 0], [Lr, 0], [Lr, rise], [0, rise], wallCol, g);
    return true;
  }
  if (shape === 3) {                                            // pyramidal: four faces to an apex
    const apex = P(Lr / 2, W / 2, top);
    for (const [a, b, len] of [[A0, A1, Lr], [A1, A2, W], [A2, A3, Lr], [A3, A0, W]]) B.tri(b, a, apex, [len, 0], [0, 0], [len / 2, slope], roofCol, info);
    return true;
  }
  const hip = shape === 2 ? Math.min(W / 2, Lr / 2) : 0;
  const R0 = P(hip, W / 2, top), R1 = P(Lr - hip, W / 2, top);
  quad(A1, A0, R0, R1, slope, Lr);                              // long slopes
  quad(A3, A2, R1, R0, slope, Lr);
  if (shape === 2) {                                            // hipped ends
    const s2 = Math.hypot(hip, rise);
    B.tri(A0, A3, R0, [0, 0], [W, 0], [W / 2, s2], roofCol, info); B.tri(A2, A1, R1, [0, 0], [W, 0], [W / 2, s2], roofCol, info);
  } else {                                                      // gable ends in the wall color
    const g = [MAT.GABLE, W, rise, seed + 256 * kind];
    B.tri(A0, A3, R0, [0, 0], [W, 0], [W / 2, rise], wallCol, g); B.tri(A2, A1, R1, [0, 0], [W, 0], [W / 2, rise], wallCol, g);
  }
  // fascia boards along the eaves
  const trim = [MAT.TRIM, 0, 0, seed + 256 * kind], dk = [0.16, 0.13, 0.11];
  for (const [a, b] of [[A0, A1], [A1, A2], [A2, A3], [A3, A0]]) B.quad([a[0], y0 - 0.16, a[2]], [b[0], y0 - 0.16, b[2]], b, a, [0, 0], [1, 0], [1, 1], [0, 1], dk, trim);
  // soffit: closes the overhang from below
  B.quad([A0[0], y0 - 0.16, A0[2]], [A3[0], y0 - 0.16, A3[2]], [A2[0], y0 - 0.16, A2[2]], [A1[0], y0 - 0.16, A1[2]], [0, 0], [1, 0], [1, 1], [0, 1], dk, trim);
  return true;
}

function dome(B, outer, y0, col, seed, kind) {
  let cx = 0, cz = 0; for (const p of outer) { cx += p[0]; cz += p[1]; } cx /= outer.length; cz /= outer.length;
  let r = Infinity;
  for (let i = 0; i < outer.length; i++) {        // inscribed radius: nearest edge to the centroid
    const p = outer[i], q = outer[(i + 1) % outer.length], ex = q[0] - p[0], ez = q[1] - p[1], L2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((cx - p[0]) * ex + (cz - p[1]) * ez) / L2));
    r = Math.min(r, Math.hypot(cx - p[0] - ex * t, cz - p[1] - ez * t));
  }
  r *= 0.92; const info = [MAT.DOME, 0, 0, seed + 256 * kind], R = 10, S = 20;
  for (let k = 0; k < R; k++) for (let s = 0; s < S; s++) {
    const a0 = k / R * Math.PI / 2, a1 = (k + 1) / R * Math.PI / 2, b0 = s / S * Math.PI * 2, b1 = (s + 1) / S * Math.PI * 2;
    const pt = (a, b) => [cx + Math.cos(b) * Math.cos(a) * r, y0 + Math.sin(a) * r * 0.85, cz + Math.sin(b) * Math.cos(a) * r];
    B.quad(pt(a0, b1), pt(a0, b0), pt(a1, b0), pt(a1, b1), [0, 0], [1, 0], [1, 1], [0, 1], col, info);
  }
}

export function buildBuildings(w) {
  const { S, H: half } = w, nB = S.bRing.length - 1;
  const G = Math.max(2, Math.ceil(2 * half / 250)), cell = 2 * half / G;
  const builders = Array.from({ length: G * G }, () => new Builder());
  const pick = (x, z) => builders[Math.min(G - 1, Math.max(0, Math.floor((z + half) / cell))) * G + Math.min(G - 1, Math.max(0, Math.floor((x + half) / cell)))];
  const colliders = [], labels = [];
  let tris = 0;
  for (let b = 0; b < nB; b++) {
    const rings = [];
    for (let r = S.bRing[b]; r < S.bRing[b + 1]; r++) {
      const ring = [];
      for (let k = S.rOff[r]; k < S.rOff[r + 1]; k++) ring.push([S.bPts[k * 2] / 10, -S.bPts[k * 2 + 1] / 10]);   // (x, z)
      if (ring.length >= 3) rings.push(ring);
    }
    if (!rings.length) continue;
    const outer = rings[0], holes = rings.slice(1);
    if (signedArea(outer) < 0) outer.reverse();                    // outer counter-clockwise in (x, z)
    for (const h of holes) if (signedArea(h) > 0) h.reverse();     // holes clockwise, so their normals face the courtyard
    const height = S.bH[b * 3] / 10, minH = S.bH[b * 3 + 1] / 10, roofH = S.bH[b * 3 + 2] / 10;
    const kind = S.bA[b * 8], roof = S.bA[b * 8 + 1], seed = S.bA[b * 8 + 3], pitch = S.bA[b * 8 + 4] * Math.PI / 180, flags = S.bA[b * 8 + 5];
    const wallCol = [lin(S.bC[b * 6] / 255), lin(S.bC[b * 6 + 1] / 255), lin(S.bC[b * 6 + 2] / 255)];
    const roofCol = [lin(S.bC[b * 6 + 3] / 255), lin(S.bC[b * 6 + 4] / 255), lin(S.bC[b * 6 + 5] / 255)];
    let gmin = Infinity, gsum = 0, cx = 0, cz = 0;
    for (const p of outer) { const g = w.heightAt(p[0], p[1]); gmin = Math.min(gmin, g); gsum += g; cx += p[0]; cz += p[1]; }
    cx /= outer.length; cz /= outer.length;
    const gmean = gsum / outer.length;
    const tagged = (flags & 2) !== 0, part = (flags & 1) !== 0;
    const floor0 = minH > 0 ? gmin + minH : (part || tagged ? gmin : gmean);
    const base = minH > 0 ? gmin + minH : gmin - 0.5;
    const box = roof >= 1 && roof <= 4 ? orientedBox(outer) : null;
    let rise = 0;
    if (box) {
      const Wd = Math.min(box.u1 - box.u0, box.v1 - box.v0) + 0.7;
      rise = roofH > 0 ? roofH : Math.min(Wd / 2 * Math.tan(pitch), 14);
    }
    const ground = part || tagged ? gmin : gmean;
    let top = ground + height - (tagged || roofH > 0 ? rise : 0);
    top = Math.max(top, base + 2.2);
    const B = pick(cx, cz), n0 = B.n;
    walls(B, outer, base, top, floor0, wallCol, MAT.WALL, kind, seed);
    for (const h of holes) walls(B, h, base, top, floor0, wallCol, MAT.WALL, kind, seed);
    let done = false;
    if (box && (box.A < 1 ? false : Math.abs(signedArea(outer)) / box.A > 0.62)) done = pitchedRoof(B, outer, roof, top, pitch, roofH, wallCol, roofCol, seed, kind);
    if (!done) {
      flatRoof(B, outer, holes, top, roofCol, seed, kind);
      const area = Math.abs(signedArea(outer));
      if (kind !== 0 && kind !== 6 && kind !== 8 && area > 60) parapet(B, outer, top, 0.5 + (seed % 5) * 0.12, wallCol, seed, kind);
      if (roof === 5) dome(B, outer, top, roofCol, seed, kind);
    }
    tris += (B.n - n0) / 3;
    if (minH < 2) colliders.push(outer.map(p => [p[0], p[1]]));
  }
  // bridges: a deck that follows the line between its two landings, at least clear of the water and ground under it
  const nBr = S.brOff ? S.brOff.length - 1 : 0;
  for (let k = 0; k < nBr; k++) {
    const pts = [];
    for (let i = S.brOff[k]; i < S.brOff[k + 1]; i++) pts.push([S.brPts[i * 2] / 10, -S.brPts[i * 2 + 1] / 10]);
    if (pts.length < 2) continue;
    const width = S.brA[k * 4], surf = S.brA[k * 4 + 1], rail = S.brA[k * 4 + 2] > 0.5;
    const hs = pts.map(p => w.heightAt(p[0], p[1]));
    const d = [0]; for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = d[d.length - 1] || 1, h0 = hs[0] + 0.25, h1 = hs[hs.length - 1] + 0.25;
    const deck = pts.map((p, i) => {
      const t = d[i] / L, lin_ = h0 + (h1 - h0) * t, arch = Math.sin(Math.PI * t) * Math.min(1.5, L * 0.02);
      const water = w.waterAt && w.waterAt(p[0], p[1]) > 0.5 ? w.levelAt(p[0], p[1]) + 2.2 : -Infinity;
      return Math.max(lin_ + arch, water, hs[i] + 0.3);
    });
    const Bd = pick(pts[0][0], pts[0][1]);
    const deckCol = surf > 0.5 ? [0.05, 0.05, 0.05] : [0.18, 0.16, 0.13], con = [0.34, 0.33, 0.31];
    const hw = width / 2, th = 0.7, par = rail ? 0.0 : 0.95;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1], ex = q[0] - p[0], ez = q[1] - p[1], len = Math.hypot(ex, ez) || 1;
      const nx = -ez / len * hw, nz = ex / len * hw, y0 = deck[i], y1 = deck[i + 1];
      const LP = [p[0] + nx, y0, p[1] + nz], RP = [p[0] - nx, y0, p[1] - nz], LQ = [q[0] + nx, y1, q[1] + nz], RQ = [q[0] - nx, y1, q[1] - nz];
      const info = [MAT.DECK, width, surf, k];
      Bd.quad(RP, RQ, LQ, LP, [0, d[i]], [width, d[i]], [width, d[i + 1]], [0, d[i + 1]], deckCol, info);
      const ci = [MAT.CONCRETE, len, th, k];
      const down = a => [a[0], a[1] - th, a[2]], up = a => [a[0], a[1] + par, a[2]];
      Bd.quad(down(LP), down(LQ), LQ, LP, [0, 0], [len, 0], [len, th], [0, th], con, ci);
      Bd.quad(RQ, down(RQ), down(RP), RP, [0, 0], [0, th], [len, th], [len, 0], con, ci);
      Bd.quad(down(RP), down(LP), down(LQ), down(RQ), [0, 0], [1, 0], [1, 1], [0, 1], con, ci);
      if (par > 0) {
        const ri = [MAT.RAIL, len, par, k];
        Bd.quad(LP, LQ, up(LQ), up(LP), [d[i], 0], [d[i + 1], 0], [d[i + 1], par], [d[i], par], con, ri);
        Bd.quad(RQ, RP, up(RP), up(RQ), [d[i + 1], 0], [d[i], 0], [d[i], par], [d[i + 1], par], con, ri);
      }
      // a pier every ~28 m where the deck stands well clear of the ground
      const ground = w.heightAt(p[0], p[1]);
      if (i > 0 && y0 - ground > 3 && (Math.floor(d[i] / 28) !== Math.floor(d[i - 1] / 28))) {
        const s = Math.min(hw * 0.5, 1.2), px = p[0], pz = p[1], top = y0 - th, bot = Math.min(ground, w.waterAt && w.waterAt(px, pz) > 0.5 ? w.levelAt(px, pz) - 2 : ground) - 0.5;
        for (const [ax, az, bx, bz] of [[-s, -s, s, -s], [s, -s, s, s], [s, s, -s, s], [-s, s, -s, -s]])
          Bd.quad([px + ax, bot, pz + az], [px + bx, bot, pz + bz], [px + bx, top, pz + bz], [px + ax, top, pz + az], [0, 0], [1, 0], [1, top - bot], [0, top - bot], con, ci);
      }
    }
  }
  return { chunks: builders.filter(b => b.n).map(b => b.arrays()), colliders, tris, labels };
}
