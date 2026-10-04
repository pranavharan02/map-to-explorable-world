// Atmosphere shared by every material: exponential height fog with sun in-scattering, drifting cloud shadows, and the
// terrain's own large-scale shadows (see terrainshadow.js), plus the sky dome.
//
// Built-in three.js materials get all of it through shader-chunk overrides: fog is mixed into the lit color before
// tone mapping (three normally fogs the tone-mapped color, which washes out at dusk), and direct light is scaled by
// the sun's visibility. Custom ShaderMaterials include ATMO_GLSL and call worldFog() / sunVisibility() themselves.
import * as THREE from 'three';
import { env } from './env.js';

Object.assign(env, {
  uNoise: { value: null },
  uTerrainShadow: { value: null }, uFarShadow: { value: null },
  uShadowExt: { value: new THREE.Vector4(1000, 1000, 0, 0) },    // core half, far half, far shadow present, cloud height
});
// fog-private aliases, so ATMO_GLSL never collides with a shader's own uSunDir or uFogColor declarations
env.uAtmoSun = env.uSunDir; env.uAtmoFog = env.uFogColor; env.uAtmoNoise = env.uNoise;

export const ATMO_GLSL = /* glsl */`
  uniform vec4 uFogParams, uShadowExt; uniform vec3 uFogScatter, uAtmoSun, uAtmoFog; uniform float uCloudCover;
  uniform vec2 uWind; uniform sampler2D uAtmoNoise, uTerrainShadow, uFarShadow;
  // optical depth of exponential height fog between a and b, measured from a base altitude
  float fogDepth(vec3 a, vec3 b) {
    float L = length(b - a), y0 = max(a.y - uFogParams.z, 0.0), y1 = max(b.y - uFogParams.z, 0.0), dy = y1 - y0;
    float H = uFogParams.y, e0 = exp(-y0 / H), e1 = exp(-y1 / H);
    return uFogParams.x * L * (abs(dy) < 0.05 ? e0 : (e0 - e1) * H / dy);
  }
  vec4 worldFog(vec3 p) {
    vec3 v = normalize(p - cameraPosition); float mu = max(dot(v, uAtmoSun), 0.0);
    vec3 col = uAtmoFog + uFogScatter * (0.35 * pow(mu, 5.0) + 1.1 * pow(mu, 40.0));
    return vec4(col, 1.0 - exp(-fogDepth(cameraPosition, p)));
  }
  // cloud coverage over p, read from the same noise the sky dome draws, projected along the sun onto the deck
  float cloudShade(vec3 p) {
    float h = max(uShadowExt.w - p.y, 0.0);
    vec2 q = (p.xz + uAtmoSun.xz / max(uAtmoSun.y, 0.12) * h) * 0.000055 + uWind;
    float n = texture2D(uAtmoNoise, q).r * 0.65 + texture2D(uAtmoNoise, q * 3.1 + 0.37).g * 0.35;
    float c = smoothstep(1.0 - uCloudCover - 0.08, 1.0 - uCloudCover + 0.22, n);
    return 1.0 - 0.62 * c;
  }
  float terrainShade(vec3 p) {
    vec2 uv = (p.xz + uShadowExt.x) / (2.0 * uShadowExt.x);
    if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) return texture2D(uTerrainShadow, uv).r;
    if (uShadowExt.z < 0.5) return 1.0;
    uv = (p.xz + uShadowExt.y) / (2.0 * uShadowExt.y);
    return texture2D(uFarShadow, clamp(uv, 0.0, 1.0)).r;
  }
  float sunVisibility(vec3 p) { return cloudShade(p) * terrainShade(p); }`;

let installed = false;
export function installChunks() {
  if (installed) return; installed = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = '#ifdef USE_FOG\n varying vec3 vFogWorld;\n#endif';
  // world position from the view-space position: correct for plain, skinned and instanced meshes alike
  C.fog_vertex = '#ifdef USE_FOG\n vFogWorld = transpose(mat3(viewMatrix)) * mvPosition.xyz + cameraPosition;\n#endif';
  C.fog_pars_fragment = '#ifdef USE_FOG\n uniform vec3 fogColor; varying vec3 vFogWorld;\n#ifdef FOG_EXP2\n uniform float fogDensity;\n#else\n uniform float fogNear; uniform float fogFar;\n#endif\n' + ATMO_GLSL + '\n#endif';
  C.fog_fragment = '';
  C.opaque_fragment = '#ifdef USE_FOG\n{ vec4 fo = worldFog(vFogWorld); outgoingLight = mix(outgoingLight, fo.rgb, fo.a); }\n#endif\n' + C.opaque_fragment;
  C.lights_fragment_end += '\n#ifdef USE_FOG\n reflectedLight.directDiffuse *= sunVisibility(vFogWorld);\n#endif\n';
}

const ATMO_UNIFORMS = () => ({
  uFogParams: env.uFogParams, uFogScatter: env.uFogScatter, uAtmoSun: env.uSunDir, uAtmoFog: env.uFogColor,
  uCloudCover: env.uCloudCover, uWind: env.uWind, uAtmoNoise: env.uNoise, uTerrainShadow: env.uTerrainShadow,
  uFarShadow: env.uFarShadow, uShadowExt: env.uShadowExt,
});
// built-in materials need the atmosphere uniforms: wrap each material's onBeforeCompile once
export function injectUniforms(root) {
  const seen = new Set();
  root.traverse(o => {
    for (const m of [].concat(o.material || [], o.customDepthMaterial || [])) {
      if (!m || seen.has(m) || m.isShaderMaterial || m.userData.atmo) continue;
      seen.add(m); m.userData.atmo = true;
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = function (sh, r) {
        prev.call(this, sh, r);
        for (const [k, v] of Object.entries(ATMO_UNIFORMS())) if (!sh.uniforms[k]) sh.uniforms[k] = v;
      };
    }
  });
}

// ---------------------------------------------------------------- sky dome
export function createSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...env },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uFogColor; uniform float uNight, uTime, uCloudCover; uniform vec2 uWind; uniform sampler2D uNoise;
      uniform vec4 uShadowExt;
      varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0), mu = dot(d, uSunDir);
        vec3 col = mix(uHorizon, uZenith, pow(h, 0.45));
        col += uSunColor * (0.08 * pow(max(mu, 0.0), 5.0) + 0.24 * pow(max(mu, 0.0), 60.0)) * (1.0 - 0.6 * h);
        float disc = smoothstep(0.99985, 0.99993, mu) * (1.0 - uNight);
        // a cumulus deck on a plane ~1.5 km up: two octaves of the shared noise, lit from the sun's side
        float cover = 0.0; vec3 cloud = vec3(0.0);
        if (d.y > 0.0) {
          // the same deck that cloudShade() projects shadows from, so shadows line up with the clouds overhead
          vec2 q = (cameraPosition.xz + d.xz / (d.y + 0.03) * max(uShadowExt.w - cameraPosition.y, 200.0)) * 0.000055 + uWind;
          float n = texture2D(uNoise, q).r * 0.65 + texture2D(uNoise, q * 3.1 + 0.37).g * 0.35;
          float fine = texture2D(uNoise, q * 9.0).b;
          cover = smoothstep(1.0 - uCloudCover - 0.08, 1.0 - uCloudCover + 0.22, n - (fine - 0.5) * 0.08) * smoothstep(0.0, 0.14, d.y);
          float lit = smoothstep(0.35, 0.95, n + 0.25 * max(mu, 0.0));
          vec3 base = uHorizon * 0.55 + uZenith * 0.25;
          vec3 top = uSunColor * 0.32 + uHorizon * 0.62;
          cloud = mix(base, top, lit) + uSunColor * 0.35 * pow(max(mu, 0.0), 6.0);
          cloud = mix(cloud, uHorizon, smoothstep(0.25, 0.0, d.y) * 0.6);          // distant clouds melt into the haze
        }
        col += uSunColor * 16.0 * disc * (1.0 - cover);
        col += vec3(step(0.9984, hash(floor(d * 430.0)))) * 0.55 * uNight * smoothstep(0.04, 0.3, d.y) * (1.0 - cover);
        col = mix(col, cloud, cover * 0.94);
        col = mix(col, uFogColor, (1.0 - smoothstep(-0.03, 0.08, d.y)) * 0.9);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, depthFunc: THREE.LessEqualDepth,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), mat);
  mesh.frustumCulled = false; mesh.renderOrder = 2;            // last among opaques: only uncovered pixels pay for the sky
  mesh.onBeforeRender = (r, s, cam) => { mesh.position.copy(cam.position); mesh.updateMatrixWorld(); };
  return mesh;
}
