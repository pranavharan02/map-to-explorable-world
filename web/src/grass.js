// Grass tufts around the viewer, placed entirely on the GPU. One instanced draw covers a disc of world-anchored grid
// cells; the vertex shader jitters each cell, reads its height and land cover from the package textures, and scales a
// tuft to zero where there should be none (roads, paving, water, forest floor, rock). The CPU only moves the center.
import * as THREE from 'three';
import { env } from './env.js';
import { HEIGHT_GLSL } from './world.js';
import { grassCard } from './textures.js';

export function createGrass(world, tex, { radius = 26, spacing = 0.62 } = {}) {
  const K = Math.ceil(radius / spacing), cells = [];
  for (let j = -K; j <= K; j++) for (let i = -K; i <= K; i++) if (i * i + j * j <= K * K) cells.push(i, j);
  const pos = [], uv = [], ind = [];
  for (let q = 0; q < 3; q++) {
    const a = q * Math.PI / 3, c = Math.cos(a) * 0.42, s = Math.sin(a) * 0.42, o = pos.length / 3;
    pos.push(-c, 0, -s, c, 0, s, c, 0.34, s, -c, 0.34, -s); uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    ind.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(ind);
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cells), 2));
  geo.instanceCount = cells.length / 2;
  const U = {
    uHeight: { value: tex.height }, uN: { value: world.n }, uHalf: { value: world.H }, uMask: { value: tex.mask }, uCover: { value: tex.cover }, uGround: { value: tex.ground }, uSat: { value: tex.color },
    uCenter: { value: new THREE.Vector2() }, uSpacing: { value: spacing }, uRadius: { value: radius }, uTime: env.uTime,
  };
  const mat = new THREE.MeshLambertMaterial({ map: grassCard(), alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
      ${HEIGHT_GLSL}
      attribute vec2 aCell; uniform sampler2D uHeight, uMask, uCover, uGround, uSat; uniform float uN, uHalf, uSpacing, uRadius, uTime; uniform vec2 uCenter;
      varying float vDry; varying vec3 vTint;
      float h1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
        vec2 id = uCenter + aCell;
        vec2 wp = (id + 0.5 + (vec2(h1(id), h1(id + 5.3)) - 0.5) * 0.95) * uSpacing;
        vec2 auv = (wp + uHalf) / (2.0 * uHalf);
        vec3 m = texture2D(uMask, auv).rgb, cv = texture2D(uCover, auv).rgb, gd = texture2D(uGround, auv).rgb;
        float shore = (m.r * 255.0 - 128.0) * 0.25, road = (m.g * 255.0 - 128.0) * 0.125;
        float dens = cv.r * (1.0 - gd.r) * (1.0 - cv.b * 0.8) * (1.0 - cv.g * 0.6) * step(0.8, shore) * step(0.5, road) * (1.0 - gd.g);
        dens *= step(h1(id + 2.7), 0.12 + 0.6 * dens);
        float dist = length(wp - cameraPosition.xz);
        float sc = dens * (1.0 - smoothstep(uRadius * 0.6, uRadius, dist)) * (0.75 + 0.5 * h1(id + 9.1));
        if (abs(wp.x) > uHalf - 2.0 || abs(wp.y) > uHalf - 2.0) sc = 0.0;
        vDry = h1(id + 4.4);
        vec3 sat = texture2D(uSat, auv).rgb; float sl = max(dot(sat, vec3(0.2126, 0.7152, 0.0722)), 0.02);
        vTint = mix(vec3(0.62, 0.76, 0.46), clamp(sat / sl, 0.4, 2.0) * 0.7, 0.55);     // the meadow's own hue
        float ang = h1(id + 1.7) * 6.2831;
        vec3 p = position; p.xz = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p.xz; p *= sc;
        float sway = sin(uTime * 1.8 + wp.x * 0.15 + wp.y * 0.09) * 0.16 + sin(uTime * 3.4 + wp.x * 0.6) * 0.04;
        p.x += sway * p.y; p.z += sway * 0.4 * p.y;
        vec3 transformed = vec3(wp.x + p.x, gridHeight(uHeight, uN, uHalf, wp) + p.y - 0.03, wp.y + p.z);`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vDry; varying vec3 vTint;')
      // both faces of a tuft are lit as the ground they grow from (a double-sided material would flip back faces down)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);')
      .replace('#include <map_fragment>', `#include <map_fragment>
        { vec2 d = dFdx(vMapUv * 128.0), e = dFdy(vMapUv * 128.0);
          diffuseColor.a *= 1.0 + max(0.5 * log2(max(dot(d, d), dot(e, e))), 0.0) * 0.35; }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.33))) * 1.3, 0.35) * vTint * mix(0.9, 1.25, vDry * vDry * vDry);`);
  };
  mat.customProgramCacheKey = () => 'grass-v1';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.receiveShadow = true;
  const api = { mesh, update, enabled: true };
  function update(cam) {
    U.uCenter.value.set(Math.floor(cam.position.x / spacing), Math.floor(cam.position.z / spacing));
    mesh.visible = api.enabled && cam.position.y - world.groundAt(cam.position.x, cam.position.z) < 60;
  }
  return api;
}
