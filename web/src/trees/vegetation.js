// Vegetation: every tree in the package, drawn at three levels of detail.
//
//   near  (< LOD.near)  full mesh, wind, alpha-tested foliage, casts shadows
//   mid   (< LOD.far)   reduced mesh
//   far                 impostor quads lit from an albedo + normal atlas baked at startup, one draw per spatial chunk
//
// Neighboring levels overlap by a band and cross-fade with complementary screen-door dither, so trees never pop.
// Each species keeps four instance lists that the CPU refills only after the viewer moves 3 m:
//   near : main + reflection + shadow passes          mid  : main pass only
//   refl : reduced mesh, layer 2 (reflection pass)    shad : reduced mesh, shadow pass only (drawn with zero
//          instances in color passes, because three tests shadow casters against the main camera's layers)
import * as THREE from 'three';
import { env } from '../env.js';
import { ATMO_GLSL } from '../atmosphere.js';
import { rng } from '../textures.js';
import { DETAIL, makeSpecies } from './species.js';
import { broadleafCard, frondCard, needleCard, pineCard } from './leaves.js';

export const LOD = { near: 40, nearBand: 10, far: 150, farBand: 22 };
export const VIEW_H = { value: 720 };      // drawing-buffer height, kept current by main.js (impostor mip selection)
export { DETAIL };

const DITHER = /* glsl */`
  uniform vec4 uFade;      // fade in from x to y, fade out from z to w (meters from the camera)
  varying vec3 vInst;
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }   // interleaved gradient noise
  void ditherFade() {
    float d = distance(vInst + vec3(0.0, 5.0, 0.0), cameraPosition), n = ign(gl_FragCoord.xy);
    if (uFade.y > 0.0 && smoothstep(uFade.x, uFade.y, d) <= 1.0 - n) discard;
    if (1.0 - smoothstep(uFade.z, uFade.w, d) <= n) discard;
  }`;
const WIND = /* glsl */`
  uniform float uTime, uWindK, uCrownY; attribute float aFlex; attribute vec2 aBark; varying vec3 vInst; varying vec2 vBark;
  vec3 windOffset(vec3 p, float flex, vec3 inst) {
    float ph = inst.x * 0.071 + inst.z * 0.053;
    vec3 dir = normalize(transpose(mat3(instanceMatrix)) * vec3(0.8, 0.0, 0.6));
    float g = sin(uTime * 0.9 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.25 + 0.35;
    vec3 o = dir * g * flex * 0.3 * uWindK;
    o.y += sin(uTime * 5.3 + p.x * 2.0 + p.z * 2.0 + ph) * 0.06 * flex * flex * uWindK;
    return o;
  }`;

function materials(sp, map, fade) {
  const U = { uTime: env.uTime, uFade: { value: fade }, uWindK: { value: sp.wind }, uCrownY: { value: sp.crownY ?? 1e5 }, uSunDir: env.uSunDir, uSunColor: env.uSunColor };
  const vs = (sh, normals) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + WIND);
    const stretch = 'float kSt = length(instanceMatrix[1].xyz) / max(length(instanceMatrix[0].xyz), 1e-4);';
    if (normals) sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      ${stretch} if (position.y > uCrownY) objectNormal.y *= kSt;`);
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      ${normals ? '' : stretch}
      if (transformed.y > uCrownY) transformed.y = uCrownY + (transformed.y - uCrownY) / kSt;   // keep the crown rigid
      vBark = aBark;
      vInst = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      transformed += windOffset(transformed, aFlex, vInst);`);
  };
  const bark = new THREE.MeshLambertMaterial({ vertexColors: true });
  bark.onBeforeCompile = (sh) => {
    vs(sh, true);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + DITHER + '\nvarying vec2 vBark;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nditherFade();')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vBark.y >= 0.0) {               // fissured bark, faded out before it aliases
          float f = vBark.x * 6.2831853 * 9.0 + sin(vBark.y * 3.7) * 1.8 + vBark.y * 0.6;
          diffuseColor.rgb *= 0.76 + 0.3 * (1.0 - smoothstep(0.3, 1.0, sin(f)) * (1.0 - smoothstep(0.4, 1.2, fwidth(f))));
          diffuseColor.rgb *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 1.5, vBark.y));
        }`);
  };
  bark.customProgramCacheKey = () => 'bark-v1';
  const leaf = new THREE.MeshLambertMaterial({ vertexColors: true, map, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: true });
  leaf.onBeforeCompile = (sh) => {
    vs(sh, true);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + DITHER + '\nuniform vec3 uSunDir, uSunColor;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nditherFade();')
      // keep foliage full at range: raise alpha with the mip level, then sharpen it (alpha-to-coverage smooths the edge)
      .replace('#include <alphatest_fragment>', `
        { vec2 sz = vec2(textureSize(map, 0)); vec2 dx = dFdx(vMapUv * sz), dy = dFdy(vMapUv * sz);
          diffuseColor.a *= 1.0 + max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy)))) * 0.28; }
        diffuseColor.a = (diffuseColor.a - 0.5) / max(fwidth(diffuseColor.a), 0.0001) + 0.5;
        if (diffuseColor.a < 0.02) discard;`)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')   // crown normals: no back-face flip
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        { vec3 sv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz); vec3 vv = normalize(-vViewPosition);
          float tr = pow(max(dot(-vv, sv), 0.0), 3.0) * 0.45 + 0.06;         // light through the leaves, toward the sun
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uSunColor * tr * max(uSunDir.y + 0.1, 0.0) * 0.55; }`);
  };
  leaf.customProgramCacheKey = () => 'leaf-v1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.45 });
  depth.onBeforeCompile = (sh) => vs(sh, false);
  depth.customProgramCacheKey = () => 'tree-depth-v1';
  return { bark, leaf, depth };
}

// ---------------------------------------------------------------- impostor atlas: 8 azimuths x 3 elevations per species
const FR = 128, AZ = 8, ELS = [0.12, 0.6, 1.15], PER = AZ * ELS.length;
function bake(renderer, species) {
  const COLS = 16, ROWS = Math.ceil(species.length * PER / COLS);
  const opts = { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter };
  const rtA = new THREE.WebGLRenderTarget(FR * COLS, FR * ROWS, opts), rtN = new THREE.WebGLRenderTarget(FR * COLS, FR * ROWS, opts);
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  const mk = (mode, map) => new THREE.ShaderMaterial({
    uniforms: { map: { value: map } },
    vertexShader: 'attribute vec3 color; varying vec3 vC, vN; varying vec2 vUv; void main() { vC = color; vN = normal; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D map; varying vec3 vC, vN; varying vec2 vUv;
      void main() { vec4 t = ${map ? 'texture2D(map, vUv)' : 'vec4(1.0)'}; if (t.a < 0.5) discard;
        ${mode === 'albedo' ? 'gl_FragColor = vec4(sqrt(t.rgb * vC), 1.0);' : 'gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, 1.0);'} }`,
    side: THREE.DoubleSide,
  });
  const prev = { rt: renderer.getRenderTarget(), auto: renderer.autoClear, cc: renderer.getClearColor(new THREE.Color()), ca: renderer.getClearAlpha() };
  renderer.autoClear = false;
  for (const [rt, mode] of [[rtA, 'albedo'], [rtN, 'normal']]) {
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear();
    species.forEach((s, si) => {
      const mesh = new THREE.Mesh(s.near, [mk(mode, null), mk(mode, s.map)]);
      scene.add(mesh);
      const R = Math.max(s.rxz, s.ry);
      for (let e = 0; e < ELS.length; e++) for (let a = 0; a < AZ; a++) {
        const f = si * PER + e * AZ + a, col = f % COLS, row = Math.floor(f / COLS);
        const az = a / AZ * Math.PI * 2, el = ELS[e], hh = s.ry * Math.cos(el) + s.rxz * Math.sin(el);
        cam.left = -s.rxz; cam.right = s.rxz; cam.bottom = -hh; cam.top = hh; cam.far = R * 6; cam.updateProjectionMatrix();
        cam.position.copy(s.center).add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(R * 3));
        cam.lookAt(s.center); cam.updateMatrixWorld();
        rt.viewport.set(col * FR, row * FR, FR, FR); rt.scissor.set(col * FR, row * FR, FR, FR); rt.scissorTest = true;
        renderer.setRenderTarget(rt); renderer.render(scene, cam);
      }
      scene.remove(mesh);
    });
    rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height);
  }
  renderer.setRenderTarget(prev.rt); renderer.autoClear = prev.auto; renderer.setClearColor(prev.cc, prev.ca);
  return { albedo: rtA.texture, normal: rtN.texture, cols: COLS, rows: ROWS };
}

function impostorMaterial(atlas, species) {
  const NS = species.length;
  return new THREE.ShaderMaterial({
    uniforms: {
      ...env, uAlbedo: { value: atlas.albedo }, uNormalA: { value: atlas.normal }, uFade: { value: new THREE.Vector2(LOD.far, LOD.far + LOD.farBand) },
      uSetC: { value: species.map(s => new THREE.Vector4(s.center.x, s.center.y, s.center.z, s.rxz)) },
      uSetE: { value: species.map(s => new THREE.Vector4(s.ry, s.maxD, 0, 0)) }, uViewH: VIEW_H,
    },
    vertexShader: /* glsl */`
      attribute vec4 aPos;      // x, y, z, yaw
      attribute vec4 aParam;    // scale, species, random, trunk stretch
      uniform vec4 uSetC[${NS}], uSetE[${NS}]; uniform vec2 uFade; uniform float uViewH;
      varying vec2 vUv0, vUv1; varying float vMix, vFade, vYaw, vRand, vLod, vVis; varying vec4 vFog;
      ${ATMO_GLSL}
      void main() {
        int si = int(aParam.y + 0.5); vec4 sc = uSetC[si], se = uSetE[si]; float s = aParam.x, yaw = aPos.w, k = mix(1.0, aParam.w, 0.8);
        float cy = cos(yaw), sy = sin(yaw);
        vec3 c = vec3(cy * sc.x + sy * sc.z, sc.y * k, -sy * sc.x + cy * sc.z) * s + aPos.xyz;
        vec3 toCam = cameraPosition - c; float d = length(toCam); toCam /= d;
        vFade = smoothstep(uFade.x, uFade.y, d);
        if (vFade <= 0.0 || d > se.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        // thin the crowd with distance (the haze and the satellite-colored ground carry the canopy); the survivors grow
        // a little to keep it closed
        float keep = clamp(1.0 - (d - 450.0) / 1300.0 * 0.75, 0.25, 1.0);
        if (aParam.z > keep) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float grow = s * mix(1.0, 1.3, 1.0 - keep);
        vec3 lc = vec3(cy * toCam.x - sy * toCam.z, toCam.y, sy * toCam.x + cy * toCam.z);
        float az = atan(lc.x, lc.z); if (az < 0.0) az += 6.2831853;
        float af = az / 6.2831853 * ${AZ}.0, a0 = floor(af); vMix = af - a0; float a1 = mod(a0 + 1.0, ${AZ}.0);
        float el = asin(clamp(lc.y, -1.0, 1.0)), e = el < 0.36 ? 0.0 : el < 0.88 ? 1.0 : 2.0;
        float elb = e < 0.5 ? ${ELS[0]} : e < 1.5 ? ${ELS[1]} : ${ELS[2]};
        float rw = sc.w * grow, rh = (se.x * cos(elb) + sc.w * sin(elb)) * grow * k;
        vLod = max(0.0, log2(${FR}.0 / max(2.0 * max(rw, rh) / d * projectionMatrix[1][1] * 0.5 * uViewH, 1.0)));
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam)), up = cross(toCam, right);
        vec3 w = c + right * position.x * rw + up * position.y * rh;
        // sun visibility and fog once per tree, not per pixel: an impostor is only a few pixels wide
        vVis = sunVisibility(c); vFog = worldFog(c);
        float g0 = aParam.y * ${PER}.0 + e * ${AZ}.0 + a0, g1 = aParam.y * ${PER}.0 + e * ${AZ}.0 + a1;
        vec2 f = position.xy * 0.5 + 0.5, grid = vec2(${atlas.cols}.0, ${atlas.rows}.0);
        vUv0 = (vec2(mod(g0, grid.x), floor(g0 / grid.x)) + f) / grid;
        vUv1 = (vec2(mod(g1, grid.x), floor(g1 / grid.x)) + f) / grid;
        vYaw = yaw; vRand = aParam.z;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uAlbedo, uNormalA; uniform vec3 uSunDir, uSunColor, uSkyAmb, uGndAmb;
      varying vec2 vUv0, vUv1; varying float vMix, vFade, vYaw, vRand, vLod, vVis; varying vec4 vFog;
      float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
      void main() {
        if (vFade < 1.0 && vFade <= 1.0 - ign(gl_FragCoord.xy)) discard;
        vec2 uvA = vMix < 0.5 ? vUv0 : vUv1, uvB = vMix < 0.5 ? vUv1 : vUv0;
        vec4 a0 = texture2D(uAlbedo, uvA);                                        // alpha test first: one fetch when rejected
        if (a0.a * (1.0 + vLod * 0.3) < 0.5) discard;
        vec4 a = a0; vec3 nl;
        if (vLod < 1.5) {                                                          // big on screen: blend the two nearest views
          a = mix(a0, texture2D(uAlbedo, uvB), min(vMix, 1.0 - vMix));
          nl = mix(texture2D(uNormalA, uvA).xyz, texture2D(uNormalA, uvB).xyz, min(vMix, 1.0 - vMix));
        } else nl = texture2D(uNormalA, uvA).xyz;                                 // a few pixels wide: one view is enough
        vec3 alb = a.rgb / max(a.a, 0.001); alb = alb * alb * (0.9 + 0.2 * vRand);  // the atlas stores sqrt(albedo)
        nl = nl / max(a.a, 0.001) * 2.0 - 1.0;
        float cy = cos(vYaw), sy = sin(vYaw);
        vec3 n = normalize(vec3(cy * nl.x + sy * nl.z, nl.y, -sy * nl.x + cy * nl.z));
        vec3 col = alb * (uSunColor * max(dot(n, uSunDir), 0.0) * 0.85 * vVis + mix(uGndAmb, uSkyAmb, n.y * 0.5 + 0.5));
        col = mix(col, vFog.rgb, vFog.a);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------- the system
export function createVegetation(world, renderer, quality) {
  const { S } = world;
  const species = makeSpecies();
  const maps = [broadleafCard(13), broadleafCard(17, { hue: 84, light: 22, leafLen: 7, count: 620 }), needleCard(19), pineCard(29),
    frondCard(7), broadleafCard(23, { hue: 102, light: 19, leafLen: 6, count: 440 })];
  species.forEach((s, i) => {
    s.map = maps[i];
    const bb = s.near.boundingBox; s.center = bb.getCenter(new THREE.Vector3()); s.ry = (bb.max.y - bb.min.y) / 2;
    const P = s.near.attributes.position; let rx = 0;
    for (let k = 0; k < P.count; k++) rx = Math.max(rx, Math.hypot(P.getX(k) - s.center.x, P.getZ(k) - s.center.z));
    s.rxz = rx;
  });
  const atlas = bake(renderer, species);

  // per-tree data for the core and the near context ring
  const nCore = S.tXY.length / 2, nFar = S.fXY ? S.fXY.length / 2 : 0, n = nCore + nFar;
  const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), YAW = new Float32Array(n), SC = new Float32Array(n), ST = new Float32Array(n), SP = new Uint8Array(n), RN = new Float32Array(n);
  const put = (i, xy, a, k) => {
    const x = xy[k * 2] / 10, z = -xy[k * 2 + 1] / 10, sp = Math.min(a[k * 3], species.length - 1), seed = a[k * 3 + 1], size = a[k * 3 + 2] / 255;
    const r = rng(i * 7 + seed), r1 = r(), r2 = r();
    X[i] = x; Z[i] = z; Y[i] = world.groundAt(x, z) - 0.08; SP[i] = sp; YAW[i] = r1 * Math.PI * 2; RN[i] = r2;
    SC[i] = sp === 5 ? 0.6 + size * 0.9 : 0.45 + size * 0.9;
    ST[i] = sp === 3 || sp === 4 ? 0.75 + r2 * 0.55 : 0.92 + r2 * 0.16;     // palms and pines vary in trunk length
  };
  for (let k = 0; k < nCore; k++) put(k, S.tXY, S.tA, k);
  for (let k = 0; k < nFar; k++) put(nCore + k, S.fXY, S.fA, k);
  let ext = world.H; for (let i = 0; i < n; i++) ext = Math.max(ext, Math.abs(X[i]) + 20, Math.abs(Z[i]) + 20);
  const CELL = 50, G = Math.ceil(2 * ext / CELL), cells = Array.from({ length: G * G }, () => []);
  for (let i = 0; i < n; i++) cells[Math.min(G - 1, Math.floor((Z[i] + ext) / CELL)) * G + Math.min(G - 1, Math.floor((X[i] + ext) / CELL))].push(i);

  const group = new THREE.Group();
  // impostors: every tree, bucketed into spatial chunks so whole chunks frustum-cull
  const IC = 8, isz = 2 * ext / IC, buckets = Array.from({ length: IC * IC }, () => []);
  for (let i = 0; i < n; i++) buckets[Math.min(IC - 1, Math.floor((Z[i] + ext) / isz)) * IC + Math.min(IC - 1, Math.floor((X[i] + ext) / isz))].push(i);
  const quadPos = new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3), quadIdx = new THREE.Uint16BufferAttribute([0, 1, 2, 0, 2, 3], 1);
  const impMat = impostorMaterial(atlas, species), impChunks = [];
  buckets.forEach((list, b) => {
    if (!list.length) return;
    const aPos = new Float32Array(list.length * 4), aParam = new Float32Array(list.length * 4);
    let ymin = Infinity, ymax = -Infinity;
    list.forEach((i, k) => { aPos.set([X[i], Y[i], Z[i], YAW[i]], k * 4); aParam.set([SC[i], SP[i], RN[i], ST[i]], k * 4); ymin = Math.min(ymin, Y[i]); ymax = Math.max(ymax, Y[i]); });
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', quadPos); g.setIndex(quadIdx);
    g.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 4)); g.setAttribute('aParam', new THREE.InstancedBufferAttribute(aParam, 4));
    g.instanceCount = list.length;
    const cx = -ext + (b % IC + 0.5) * isz, cz = -ext + (Math.floor(b / IC) + 0.5) * isz;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, (ymin + ymax) / 2 + 10, cz), Math.hypot(isz * 0.71, (ymax - ymin) / 2 + 20) + 15);
    const m = new THREE.Mesh(g, impMat); m.matrixAutoUpdate = false; m.userData.c = g.boundingSphere.center; m.userData.r = g.boundingSphere.radius;
    group.add(m); impChunks.push(m);
  });

  const fadeNear = new THREE.Vector4(0, 0, LOD.near, LOD.near + LOD.nearBand);
  const fadeMid = new THREE.Vector4(LOD.near, LOD.near + LOD.nearBand, LOD.far, LOD.far + LOD.farBand);
  const fadeAll = new THREE.Vector4(0, 0, LOD.far, LOD.far + LOD.farBand);
  const CAP = { near: quality === 'low' ? 900 : 1600, mid: quality === 'high' ? 9000 : 6000, refl: 1600, shad: 4000 };
  const LISTS = ['near', 'mid', 'refl', 'shad'];
  const meshes = species.map(sp => LISTS.map(kind => {
    const m = materials(sp, sp.map, kind === 'near' ? fadeNear : kind === 'mid' ? fadeMid : fadeAll);
    const im = new THREE.InstancedMesh(kind === 'near' ? sp.near : sp.mid, [m.bark, m.leaf], CAP[kind]);
    im.customDepthMaterial = m.depth; im.count = 0; im.frustumCulled = false;
    im.castShadow = kind === 'near' || kind === 'shad'; im.receiveShadow = kind === 'near' || kind === 'mid';
    if (kind === 'refl') im.layers.set(2);
    if (kind === 'shad') {                   // shadow pass only: draw zero instances in every color pass
      let saved = 0;
      im.onBeforeRender = () => { saved = im.count; im.count = 0; };
      im.onAfterRender = () => { im.count = saved; };
    }
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(im);
    return { im, kind, on: true };
  }));

  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), SV = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
  const last = new THREE.Vector3(1e9, 0, 0); let lastShadowR = 0, stats = {};
  function update(cam, shadowR, force = false) {
    if (!force && last.distanceToSquared(cam.position) < 9 && Math.abs(shadowR - lastShadowR) < 8) return;   // 3 m hysteresis
    last.copy(cam.position); lastShadowR = shadowR;
    const counts = species.map(() => [0, 0, 0, 0]);
    const putM = (s, l) => { const k = counts[s][l]++; if (k < CAP[LISTS[l]]) meshes[s][l].im.setMatrixAt(k, M); };
    const nearMax = LOD.near + LOD.nearBand, shadReach = shadowR * 1.45 + 8, reach = Math.max(LOD.far + LOD.farBand, shadReach);
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z, shadOn = cy - world.groundAt(cx, cz) < 160;
    const i0 = Math.max(0, Math.floor((cx - reach + ext) / CELL)), i1 = Math.min(G - 1, Math.floor((cx + reach + ext) / CELL));
    const j0 = Math.max(0, Math.floor((cz - reach + ext) / CELL)), j1 = Math.min(G - 1, Math.floor((cz + reach + ext) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (const t of cells[j * G + i]) {
      const d = Math.hypot(X[t] - cx, Z[t] - cz, Y[t] + 5 - cy);
      if (d > reach) continue;
      const s = SP[t];
      Q.setFromAxisAngle(UPV, YAW[t]); P.set(X[t], Y[t], Z[t]); SV.set(SC[t], SC[t] * ST[t], SC[t]); M.compose(P, Q, SV);
      if (d < nearMax) { putM(s, 0); putM(s, 2); }
      if (d > LOD.near && d < LOD.far + LOD.farBand) putM(s, 1);
      if (shadOn && d >= nearMax && d < shadReach && s !== 5) putM(s, 3);   // from high up, tree shadows are sub-texel
    }
    stats = { near: 0, mid: 0, refl: 0, shad: 0 };
    meshes.forEach((row, s) => row.forEach((o, l) => {
      o.im.count = Math.min(counts[s][l], CAP[o.kind]);
      o.im.instanceMatrix.clearUpdateRanges(); o.im.instanceMatrix.addUpdateRange(0, o.im.count * 16); o.im.instanceMatrix.needsUpdate = true;
      o.im.visible = o.on && o.im.count > 0;           // an empty list costs no draw call
      stats[o.kind] += o.im.count;
    }));
  }
  // reflection pass: near meshes off (their stand-ins on layer 2 take over), and mid starts at the camera
  function reflectionMode(on) {
    meshes.forEach(row => { row[0].on = !on; row[0].im.visible = !on && row[0].im.count > 0; });
    fadeMid.x = on ? 0 : LOD.near; fadeMid.y = on ? 0 : LOD.near + LOD.nearBand;
  }
  function cull(cam) {
    for (const m of impChunks) m.visible = Math.hypot(m.userData.c.x - cam.position.x, m.userData.c.z - cam.position.z) - m.userData.r < 3300;
  }
  function trunkAt(x, z, r = 0.35) {
    const i = Math.floor((x + ext) / CELL), j = Math.floor((z + ext) / CELL);
    for (let b = j - 1; b <= j + 1; b++) for (let a = i - 1; a <= i + 1; a++) {
      if (a < 0 || b < 0 || a >= G || b >= G) continue;
      for (const t of cells[b * G + a]) { const rr = r + species[SP[t]].coll * SC[t]; if ((X[t] - x) ** 2 + (Z[t] - z) ** 2 < rr * rr) return true; }
    }
    return false;
  }
  return { group, update, reflectionMode, cull, trunkAt, impChunks, meshes, species, atlas, count: n, get stats() { return stats; } };
}
