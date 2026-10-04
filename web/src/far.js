// The context ring: real relief and satellite color out to the horizon. It is never walked on, so one cheap custom
// shader lights it (sun, sky, terrain and cloud shadows, fog) and shades its water from the shore distance field.
import * as THREE from 'three';
import { env } from './env.js';
import { ATMO_GLSL } from './atmosphere.js';

export function createFar(world, tex, data, normalTex) {
  const fm = world.meta.far;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...env, uFar: { value: tex.far }, uFarN: { value: normalTex }, uHalf: { value: world.H }, uFarHalf: { value: fm.half }, uN: { value: fm.n },
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uFar, uFarN; uniform float uHalf, uFarHalf, uN, uNight, uTime;
      uniform vec3 uSunDir, uSunColor, uSkyAmb, uGndAmb, uZenith, uHorizon;
      ${ATMO_GLSL}
      varying vec3 vW;
      void main() {
        if (abs(vW.x) < uHalf - 0.5 && abs(vW.z) < uHalf - 0.5) discard;          // the detailed core is drawn here
        vec2 uv = (vW.xz + uFarHalf) / (2.0 * uFarHalf);
        vec4 f = texture2D(uFar, uv);
        float sd = (f.a * 255.0 - 128.0) * 2.0;
        vec3 sat = pow(f.rgb, vec3(2.2));
        vec3 n = normalize(texture2D(uFarN, (uv * (uN - 1.0) + 0.5) / uN).xyz * 2.0 - 1.0);
        vec3 V = normalize(cameraPosition - vW);
        float vis = sunVisibility(vW);
        vec3 col;
        if (sd < 0.0) {                                                              // water: sky reflection, Fresnel, glint
          float F = 0.02 + 0.98 * pow(1.0 - max(V.y, 0.0), 5.0);
          vec3 R = reflect(-V, vec3(0.0, 1.0, 0.0));
          vec3 sky = mix(uHorizon, uZenith, pow(max(R.y, 0.0), 0.45));
          vec3 body = sat * 0.55 * (uSkyAmb + uSunColor * 0.25 * max(uSunDir.y, 0.0));
          col = mix(body, sky, F) + uSunColor * pow(max(dot(R, uSunDir), 0.0), 600.0) * 6.0 * vis * (1.0 - uNight);
          col = mix(col, body * 1.4, smoothstep(-14.0, 0.0, sd) * 0.5);                // murkier shallows at the shore
        } else {
          float ndl = max(dot(n, uSunDir), 0.0);
          vec3 amb = mix(uGndAmb, uSkyAmb, n.y * 0.5 + 0.5);
          col = sat * 0.95 * (uSunColor * ndl * vis + amb);
        }
        vec4 fo = worldFog(vW); col = mix(col, fo.rgb, fo.a);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const group = new THREE.Group();
  for (const b of data.blocks) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.lods[0].position, 3));
    g.setIndex(new THREE.BufferAttribute(b.lods[0].index, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); m.matrixAutoUpdate = false; m.renderOrder = 1;   // after the core, so its pixels fail the depth test early
    group.add(m);
  }
  return group;
}
