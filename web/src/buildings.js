// Buildings and bridges: the worker's chunk meshes, and one material whose fragment shader draws every facade.
//
// Each vertex carries surface coordinates in meters (s along the wall, t above the floor line) and an info vector
// (material, wall length, wall height, kind and seed). From those, the shader lays out storeys, bays, windows, doors,
// shopfronts, curtain walls, corrugated sheds, roof tiles and gravel roofs at true scale, so detail costs no geometry
// and no texture memory. Lit windows at night are picked per window from a hash.
import * as THREE from 'three';
import { env } from './env.js';

const FACADE_GLSL = /* glsl */`
  varying vec2 vSurf; varying vec4 vInfo; varying vec3 vWp;
  uniform sampler2D uNoise; uniform float uNight, uStyle; uniform vec3 uSkyAmb, uHorizon;
  float hh(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  float box1(float x, float a, float b, float aa) { return smoothstep(a - aa, a + aa, x) * (1.0 - smoothstep(b - aa, b + aa, x)); }
  float winGlow;`;

const FACADE_MAIN = /* glsl */`
  winGlow = 0.0;
  float mid = floor(vInfo.x + 0.5), kind = floor(vInfo.w / 256.0), seed = floor(mod(vInfo.w, 256.0));
  vec2 s = vSurf; float aa = max(max(fwidth(s.x), fwidth(s.y)), 0.002) * 0.7;
  float nA = texture2D(uNoise, vWp.xz * 0.17 + vWp.y * 0.11).b, nB = texture2D(uNoise, vec2(s.x * 0.31, s.y * 0.07) + seed * 0.37).a;
  float detail = 1.0 - smoothstep(0.05, 0.25, aa);            // patterns fade out before they alias
  vec3 c = diffuseColor.rgb;
  vec3 V = normalize(vViewPosition), Nv = normalize(vNormal);
  float fres = pow(1.0 - abs(dot(Nv, V)), 4.0);
  if (mid == 0.0 || mid == 6.0) {
    float L = vInfo.y, top = vInfo.z;
    float sh = kind == 2.0 || kind == 5.0 ? 3.6 : kind == 7.0 ? 3.4 : 3.0;
    float st = floor(s.y / sh), sy = s.y - st * sh;
    float bay = mix(2.5, 3.4, hh(seed + 3.0)), nbay = max(1.0, floor(L / bay)), cw = L / nbay;
    float ci = floor(s.x / cw), cu = fract(s.x / cw), x = cu * cw;
    float inside = step(0.0, s.y) * step(s.y, top - 0.5) * step(1.8, L);
    vec3 glass = mix(vec3(0.03, 0.04, 0.05), uSkyAmb * 0.55 + uHorizon * 0.25, 0.2 + 0.7 * fres);
    vec3 frameC = hh(seed + 9.0) < 0.6 ? vec3(0.82, 0.8, 0.76) : vec3(0.2, 0.17, 0.14);
    float win = 0.0, fr = 0.0, door = 0.0, lit = step(0.58, hh(seed * 1.3 + ci * 7.1 + st * 13.7));
    if (kind == 7.0) {                                          // curtain wall: mullions, spandrel bands
      float mull = 1.0 - box1(fract(s.x / 1.5), 0.04, 0.96, aa / 1.5);
      float span = 1.0 - box1(sy, 0.85, sh - 0.05, aa);
      c = mix(glass * vec3(0.85, 0.95, 1.05), c * 0.8, max(mull * 0.9, span * 0.85) * detail + (1.0 - detail) * 0.35);
      winGlow = (1.0 - span) * (1.0 - mull) * lit * 0.8;
    } else if (kind == 3.0) {                                   // shed: corrugated cladding, a strip of windows up high
      c *= mix(1.0, 0.82 + 0.18 * sin(s.x * 31.4159), detail);
      win = box1(s.y, top - 2.2, top - 1.1, aa) * box1(cu, 0.1, 0.9, aa / cw) * inside;
      c = mix(c, glass, win);
    } else if (kind == 4.0) {                                   // church or temple: tall arched windows, no storeys
      float wx = box1(x, cw * 0.5 - 0.55, cw * 0.5 + 0.55, aa);
      float y0 = 2.0, y1 = min(top - 1.5, 8.5);
      float arch = step(length(vec2(x - cw * 0.5, max(s.y - (y1 - 0.55), 0.0))), 0.55);
      win = wx * step(y0, s.y) * step(s.y, y1) * arch * step(5.0, top) * inside;
      c = mix(c, mix(vec3(0.05, 0.05, 0.07), vec3(0.25, 0.18, 0.12), nB), win);
      winGlow = win * lit * 0.6;
    } else {
      bool shop = kind == 2.0 && st < 0.5;
      float ww = kind == 0.0 || kind == 8.0 || kind == 6.0 ? 0.36 : kind == 1.0 ? 0.48 : 0.56;
      float y0 = shop ? 0.35 : 0.9, y1 = shop ? sh - 0.45 : min(2.25, sh - 0.55);
      if (shop) ww = 0.8;
      float hw = cw * ww * 0.5;
      float wx = box1(x, cw * 0.5 - hw, cw * 0.5 + hw, aa), wy = box1(sy, y0, y1, aa);
      bool sm = kind == 6.0 || kind == 8.0;
      win = wx * wy * inside * (sm ? step(0.6, hh(seed + ci)) : 1.0) * (s.y < top - 0.6 ? 1.0 : 0.0);
      float dx = abs(x - cw * 0.5) - hw, dy = max(y0 - sy, sy - y1);
      fr = win * (1.0 - smoothstep(0.0, 0.07, min(-dx, -dy) + aa));
      // glazing bars: a mullion in wide windows, a transom in European ones
      float lx = x - cw * 0.5, ly = sy - y0, wh = y1 - y0;
      float bars = shop ? 0.0 : max((hw > 0.45 ? 1.0 - smoothstep(0.02, 0.04 + aa, abs(lx)) : 0.0), uStyle * (1.0 - smoothstep(0.02, 0.04 + aa, abs(ly - wh * 0.64))));
      fr = max(fr, bars * win * detail);
      // a door on the ground floor of one bay per wall
      float dbay = floor(hh(seed * 3.7 + L) * nbay);
      door = (st < 0.5 && abs(ci - dbay) < 0.5 && !shop && kind != 7.0) ? box1(x, cw * 0.5 - 0.55, cw * 0.5 + 0.55, aa) * step(0.0, sy) * step(sy, 2.2) * inside : 0.0;
      // glass: a dark interior, more sky towards the top of the pane, and a curtain behind some windows
      float curtain = step(0.55, hh(seed * 2.3 + ci * 3.1 + st)) * step(0.05, ly) * (1.0 - step(wh * 0.58, ly));
      vec3 wcol = mix(vec3(0.022, 0.026, 0.03), uSkyAmb * 0.6 + uHorizon * 0.3, clamp(0.12 + 0.6 * fres + 0.25 * ly / max(wh, 0.1), 0.0, 1.0));
      wcol = mix(wcol, vec3(0.3, 0.27, 0.22), curtain * 0.55 * (1.0 - fres));
      // shutters on European houses: louvred panels either side of the window
      float shut = uStyle * (kind == 0.0 ? 1.0 : 0.0) * step(0.45, hh(seed + 17.0)) * wy * box1(abs(x - cw * 0.5), hw, hw + 0.45, aa) * inside * (1.0 - win);
      vec3 shutC = hh(seed + 21.0) < 0.5 ? vec3(0.13, 0.22, 0.13) : vec3(0.25, 0.14, 0.08);
      c = mix(c, shutC * (0.85 + 0.25 * step(0.5, fract(sy * 9.0))), shut);
      c = mix(c, mix(wcol, frameC, fr * detail), win);
      c = mix(c, mix(vec3(0.14, 0.09, 0.06), vec3(0.24, 0.16, 0.1), nB), door);
      c *= 1.0 - 0.25 * box1(sy, y1 + 0.02, y1 + 0.22, aa) * box1(lx, -hw - 0.06, hw + 0.06, aa) * inside * (1.0 - win) * step(2.0, L) * detail * (sm ? 0.0 : 1.0);   // lintel shadow
      float sill = shop ? 0.0 : box1(sy, y0 - 0.09, y0, aa) * box1(lx, -hw - 0.07, hw + 0.07, aa) * inside * (sm ? 0.0 : 1.0);
      c = mix(c, vec3(0.72, 0.7, 0.66), sill * detail);
      winGlow = win * lit * (shop ? 1.4 : 1.0) * (1.0 - fr);
    }
    if (mid == 6.0) { c = diffuseColor.rgb; winGlow = 0.0; }   // gable ends stay plain
    if (s.y < 0.0) c = mix(c * 0.62, vec3(0.3, 0.29, 0.27) * (0.8 + 0.3 * nA), 0.6);   // plinth / exposed basement
    c = mix(c, c * vec3(0.72, 0.72, 0.68), (1.0 - smoothstep(0.0, 1.2, s.y)) * (0.45 + 0.4 * nA) * 0.7);   // splash grime
    c = mix(c, c * 0.8, smoothstep(0.55, 0.9, nB) * 0.6 * step(0.0, s.y));                             // weather streaks
  } else if (mid == 1.0) {                                       // pitched roof: courses up the slope, per-tile variation
    float row = floor(s.y / 0.34), col = floor(s.x / 0.26 + row * 0.5);
    float course = smoothstep(0.0, 0.16, fract(s.y / 0.34));
    float tileV = 0.82 + 0.3 * hh(row * 7.0 + col * 13.0 + seed);
    c *= mix(1.0, (0.76 + 0.3 * course) * tileV, detail);
    c = mix(c, c * vec3(0.6, 0.66, 0.55), smoothstep(0.62, 0.9, nA) * 0.5);                           // moss and soot
  } else if (mid == 2.0) {                                       // flat roof: gravel or membrane
    c *= 0.82 + 0.3 * nA * (0.8 + 0.4 * texture2D(uNoise, s * 0.9).g);
  } else if (mid == 3.0) {
    c *= 0.88 + 0.2 * nA;
  } else if (mid == 7.0) {                                       // dome: ribs
    c *= 0.85 + 0.15 * smoothstep(0.0, 0.1, abs(fract(s.x * 16.0) - 0.5));
  } else if (mid == 8.0) {                                       // bridge deck: asphalt or ballast with sleepers
    float rail = step(vInfo.z, 0.05);
    vec3 asph = vec3(0.07, 0.07, 0.075) * (0.85 + 0.3 * nA);
    vec3 ballast = vec3(0.25, 0.23, 0.2) * (0.7 + 0.4 * nA) * mix(1.0, 0.55, step(0.7, fract(s.y * 1.6)) * box1(s.x, 0.6, vInfo.y - 0.6, aa));
    c = mix(asph, ballast, rail);
  } else if (mid == 9.0 || mid == 10.0) {
    c *= 0.8 + 0.3 * nA;
  }
  diffuseColor.rgb = c;`;

export function buildingMaterial(noise, style) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uNoise: { value: noise }, uNight: env.uNight, uStyle: { value: style }, uSkyAmb: env.uSkyAmb, uHorizon: env.uHorizon });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aSurf; attribute vec4 aInfo; varying vec2 vSurf; varying vec4 vInfo; varying vec3 vWp;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSurf = aSurf; vInfo = aInfo; vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FACADE_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FACADE_MAIN)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += winGlow * uNight * vec3(1.0, 0.62, 0.3) * 0.5;`);
  };
  mat.customProgramCacheKey = () => 'facade-v1';
  return mat;
}

export function createBuildings(data, noise, style) {
  const mat = buildingMaterial(noise, style);
  const group = new THREE.Group();
  for (const A of data.chunks) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(A.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(A.normal, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(A.color, 3, true));
    g.setAttribute('aSurf', new THREE.BufferAttribute(A.aSurf, 2));
    g.setAttribute('aInfo', new THREE.BufferAttribute(A.aInfo, 4));
    g.computeBoundingSphere(); g.computeBoundingBox();
    const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true; m.matrixAutoUpdate = false;
    // buildings are the biggest occluders in a town: drawn first, they let the depth test reject the terrain and
    // trees behind them before those are shaded (in a village lane this cuts the frame time by about 40%)
    m.renderOrder = -2;
    group.add(m);
  }
  group.userData.tris = data.tris;
  return group;
}

// point-in-footprint tests for the walker, bucketed in a 16 m grid
export function colliderGrid(polys, half) {
  const CELL = 16, G = Math.ceil(2 * half / CELL), grid = new Map();
  polys.forEach((poly, i) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    for (let j = Math.floor((z0 + half) / CELL); j <= Math.floor((z1 + half) / CELL); j++)
      for (let k = Math.floor((x0 + half) / CELL); k <= Math.floor((x1 + half) / CELL); k++) {
        const key = j * G + k; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(i);
      }
  });
  const inPoly = (x, z, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  return (x, z, r = 0.3) => {
    const list = grid.get(Math.floor((z + half) / CELL) * G + Math.floor((x + half) / CELL));
    if (!list) return false;
    for (const i of list) for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r], [0, 0]]) if (inPoly(x + ox, z + oz, polys[i])) return true;
    return false;
  };
}
