// Terrain: the worker-built LOD blocks, shaded by one material that paints the ground from the package's layers.
//
// The mesh carries positions only. Normals come from a full-resolution normal map, so a block drawn at a coarse LOD
// still shades with every ridge and gully. Ground color is procedural (soil, grass, forest floor, rock, paving),
// weighted by the land-cover maps and tinted by the satellite, which takes over with distance. Roads and shorelines
// are painted from their distance fields, which stay sharp however close you stand.
import * as THREE from 'three';
import { env } from './env.js';

export const GROUND_GLSL = /* glsl */`
  uniform sampler2D uMask, uCover, uGround, uColor, uNormalMap, uNoise, uDetail; uniform float uHalf, uN, uNight;
  varying vec3 vW;
  vec2 areaUv(vec2 xz) { return (xz + uHalf) / (2.0 * uHalf); }
  vec2 pointUv(vec2 xz) { return (areaUv(xz) * (uN - 1.0) + 0.5) / uN; }
  vec3 terrainNormal(vec2 xz) { return normalize(texture2D(uNormalMap, pointUv(xz)).xyz * 2.0 - 1.0); }
  float roadAA;
  vec3 groundAlbedo(vec3 p, vec3 nW, out float onRoad) {
    vec2 uv = areaUv(p.xz);
    vec3 m = texture2D(uMask, uv).rgb, cv = texture2D(uCover, uv).rgb, gd = texture2D(uGround, uv).rgb, sat = texture2D(uColor, uv).rgb;
    float sdS = (m.r * 255.0 - 128.0) * 0.25, sdR = (m.g * 255.0 - 128.0) * 0.125, surf = m.b;
    float dist = length(p - cameraPosition), slope = 1.0 - nW.y;
    float sdR0 = (m.g * 255.0 - 128.0) * 0.125;
    onRoad = 1.0 - smoothstep(-fwidth(sdR0) - 0.02, fwidth(sdR0) + 0.02, sdR0);
    // far away the satellite carries the ground (with the roads drawn over it), so the procedural layers are skipped
    vec3 farGround = mix(sat * 0.85, mix(vec3(0.3, 0.27, 0.22), vec3(0.08, 0.08, 0.085), smoothstep(0.4, 0.75, surf)), onRoad * 0.6);
    if (dist > 1000.0) return farGround;
    float n1 = texture2D(uNoise, p.xz * 0.013).r, n2 = texture2D(uNoise, p.xz * 0.061).g;
    float n3 = texture2D(uNoise, p.xz * 0.27).b, n4 = texture2D(uNoise, p.xz * 1.3).a;
    float satL = max(dot(sat, vec3(0.2126, 0.7152, 0.0722)), 0.015);
    vec3 hue = clamp(sat / satL, 0.3, 3.0);
    float dry = smoothstep(0.85, 1.25, hue.r / max(hue.g, 0.1));            // the satellite says straw rather than green
    vec3 soil = vec3(0.16, 0.13, 0.095) * (0.78 + 0.36 * n3);
    vec3 grass = mix(vec3(0.075, 0.13, 0.04), vec3(0.19, 0.16, 0.075), dry) * (0.72 + 0.5 * n2) * (0.86 + 0.28 * n4);
    vec3 litter = mix(vec3(0.075, 0.06, 0.035), vec3(0.15, 0.1, 0.05), smoothstep(0.4, 0.75, n4 * 0.6 + n2 * 0.4)) * (0.8 + 0.3 * n3);
    vec3 rock = vec3(0.23, 0.22, 0.21) * (0.62 + 0.5 * n3) * (0.84 + 0.3 * n4) * mix(vec3(1.0), hue, 0.25);
    vec3 farm = mix(soil, grass, 0.45 + 0.4 * n1) * mix(vec3(1.0), hue, 0.5);
    float tile = step(0.06, fract(p.x * 1.6 + step(0.5, fract(p.z * 0.8)) * 0.5)) * step(0.06, fract(p.z * 1.6));
    vec3 paved = vec3(0.27, 0.262, 0.245) * (0.84 + 0.26 * n4) * mix(0.82, 1.0, mix(1.0, tile, 1.0 - smoothstep(4.0, 25.0, dist)));
    vec3 a = soil;
    a = mix(a, grass, cv.r);
    a = mix(a, litter, cv.g);
    a = mix(a, rock, cv.b);
    a = mix(a, farm, gd.b);
    a = mix(a, paved, gd.r);
    a = mix(a, rock, smoothstep(0.36, 0.55, slope + (n2 - 0.5) * 0.12) * (1.0 - gd.r));   // cliffs (steeper than ~50 degrees) show rock
    a = mix(a, a * clamp(hue * 0.35 + 0.65, 0.55, 1.6), 0.5);                              // the satellite's hue, everywhere
    // roads from the distance field: asphalt, setts or gravel by surface class, with a dusty shoulder
    float aa = fwidth(sdR) * 0.75 + 0.015;
    onRoad = 1.0 - smoothstep(-aa, aa, sdR);
    vec3 asphalt = vec3(0.07, 0.07, 0.075) * (0.82 + 0.36 * n4) * (0.9 + 0.2 * n2);
    vec3 setts = vec3(0.24, 0.22, 0.2) * (0.7 + 0.5 * n3) * (0.72 + 0.28 * step(0.1, fract(p.x * 4.5)) * step(0.1, fract(p.z * 4.5 + floor(p.x * 4.5) * 0.5)));
    vec3 gravel = vec3(0.3, 0.27, 0.22) * (0.72 + 0.42 * n3) * (0.85 + 0.3 * n4);
    vec3 road = surf > 0.6 && surf < 0.7 ? setts : mix(gravel, asphalt, smoothstep(0.4, 0.75, surf));
    float shoulder = (1.0 - smoothstep(0.0, 1.1 + n3 * 0.6, sdR)) * (1.0 - onRoad);
    a = mix(a, mix(a, gravel, 0.55), shoulder * 0.65);
    a = mix(a, road, onRoad);
    // banks: dark wet mud at the waterline, silt under water
    float wet = 1.0 - smoothstep(0.0, 1.6 + n2, sdS);
    a = mix(a, a * 0.5 + vec3(0.02, 0.018, 0.012), wet * 0.75 * (1.0 - onRoad));
    a = mix(a, vec3(0.15, 0.13, 0.095) * (0.75 + 0.4 * n3), (1.0 - smoothstep(-0.5, 0.0, sdS)) * 0.8);
    a *= 1.0 - gd.g * 0.42;                                                                 // contact shade at walls
    if (dist < 45.0) {                                                                       // close-range grain, twigs and litter
      vec3 det = texture2D(uDetail, p.xz * 0.25).rgb * 2.0;
      a *= mix(vec3(1.0), det, (1.0 - smoothstep(10.0, 45.0, dist)) * (1.0 - onRoad * 0.65));
    }
    return mix(a, farGround, smoothstep(140.0, 1000.0, dist));                               // and blends in from 140 m out
  }`;

export function terrainMaterial(world, tex, extra) {
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });   // double-sided: skirts are seen from either side
  const U = {
    uMask: { value: tex.mask }, uCover: { value: tex.cover }, uGround: { value: tex.ground }, uColor: { value: tex.color },
    uNormalMap: { value: extra.normalMap }, uNoise: { value: extra.noise }, uDetail: { value: extra.detail },
    uHalf: { value: world.H }, uN: { value: world.n }, uNight: env.uNight,
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GROUND_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 nW = terrainNormal(vW.xz); float onRoad;
        diffuseColor.rgb = groundAlbedo(vW, nW, onRoad);`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`);
  };
  mat.customProgramCacheKey = () => 'terrain-v1';
  return mat;
}

export function normalTexture(data, n) {
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

const geom = (a) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
  g.setIndex(new THREE.BufferAttribute(a.index, 1));
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
};

// LOD distances per quality preset scale the switch points; blocks pick their level from the nearest point of their box
export function createTerrain(data, mat, lodScale = 1) {
  const group = new THREE.Group();
  const blocks = data.blocks.map(b => {
    const meshes = b.lods.map((l, k) => {
      const m = new THREE.Mesh(geom(l), mat);
      m.receiveShadow = true; m.matrixAutoUpdate = false; m.visible = k === 0;   // terrain-scale shadows come from terrainshadow.js
      m.renderOrder = -1;                                                       // after buildings, before trees
      group.add(m); return m;
    });
    return { meshes, box: new THREE.Box3(new THREE.Vector3(b.box[0], b.box[1], b.box[2]), new THREE.Vector3(b.box[3], b.box[4], b.box[5])), lod: 0 };
  });
  const rim = new THREE.Mesh(geom(data.rim), mat); rim.matrixAutoUpdate = false; rim.renderOrder = -1; group.add(rim);
  const NEAR = 200 * lodScale, MID = 700 * lodScale;
  function update(cam) {
    for (const b of blocks) {
      const d = b.box.distanceToPoint(cam.position);
      const lod = d < NEAR ? 0 : d < MID ? 1 : 2;
      if (lod !== b.lod) { b.meshes[b.lod].visible = false; b.meshes[lod].visible = true; b.lod = lod; }
    }
  }
  group.userData.tris = data.tris;
  return { group, update, blocks };
}
