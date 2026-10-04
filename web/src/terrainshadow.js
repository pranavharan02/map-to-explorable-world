// Terrain shadows at the scale of mountains. The sun's shadow map only covers a hundred meters or so around the viewer;
// beyond it, a valley at dusk would stay sunlit. So the heightfield itself is ray-marched toward the sun, once per
// texel of a top-down visibility texture, and every material multiplies its direct light by that texture.
//
// The march runs on the GPU in a single full-screen pass, only when the sun has moved (a quarter of the rows per frame
// while it keeps moving), so in a still scene it costs nothing at all.
import * as THREE from 'three';
import { env } from './env.js';
import { HEIGHT_GLSL } from './world.js';

export function createTerrainShadow(renderer, world, tex, size = 512) {
  const H = world.H, fm = world.meta.far;
  const hm = world.meta.height;
  const maxH = hm.lo + 65535 * hm.scale;
  const opts = { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
  const core = new THREE.WebGLRenderTarget(size, size, opts);
  const farRT = fm ? new THREE.WebGLRenderTarget(256, 256, opts) : null;
  env.uTerrainShadow.value = core.texture;
  env.uFarShadow.value = farRT ? farRT.texture : core.texture;
  env.uShadowExt.value.set(H, fm ? fm.half : H, fm ? 1 : 0, env.uShadowExt.value.w);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uH: { value: tex.height }, uN: { value: hm.n }, uHalf: { value: H },
      uFH: { value: tex.farHeight || tex.height }, uFN: { value: fm ? fm.n : hm.n }, uFarHalf: { value: fm ? fm.half : H },
      uExt: { value: H }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uMaxH: { value: maxH },
      uHasFar: { value: fm ? 1 : 0 }, uStep: { value: 2.5 },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: HEIGHT_GLSL + /* glsl */`
      uniform sampler2D uH, uFH; uniform float uN, uHalf, uFN, uFarHalf, uExt, uMaxH, uHasFar, uStep; uniform vec3 uSun;
      varying vec2 vUv;
      float heightAt(vec2 xz) {
        if (abs(xz.x) < uHalf && abs(xz.y) < uHalf) return gridHeight(uH, uN, uHalf, xz);
        if (uHasFar > 0.5 && abs(xz.x) < uFarHalf && abs(xz.y) < uFarHalf) return gridHeight(uFH, uFN, uFarHalf, xz);
        return -1e4;
      }
      void main() {
        vec2 xz = (vUv * 2.0 - 1.0) * uExt;
        if (uSun.y <= 0.0) { gl_FragColor = vec4(1.0); return; }
        vec3 p0 = vec3(xz.x, heightAt(xz) + 0.6, xz.y);
        float vis = 1.0, t = uStep * 1.5;
        for (int i = 0; i < 44; i++) {
          vec3 p = vec3(p0.x, p0.y, p0.z) + vec3(uSun.x, uSun.y, uSun.z) * t;
          if (p.y > uMaxH) break;
          float d = p.y - heightAt(p.xz);
          vis = min(vis, smoothstep(-0.015 * t, 0.025 * t + 0.5, d));     // penumbra widens with distance
          if (vis <= 0.0) break;
          t *= 1.16;
          t += uStep;
        }
        gl_FragColor = vec4(vis, vis, vis, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat), scene = new THREE.Scene(), cam = new THREE.Camera();
  quad.frustumCulled = false; scene.add(quad);
  const last = new THREE.Vector3(9, 9, 9);
  let band = 4, bands = 4;
  function pass(rt, ext, step, y0, y1) {
    mat.uniforms.uExt.value = ext; mat.uniforms.uStep.value = step;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    rt.scissor.set(0, y0, rt.width, y1 - y0); rt.scissorTest = true;
    renderer.setRenderTarget(rt); renderer.render(scene, cam);
    rt.scissorTest = false; renderer.setRenderTarget(prev); renderer.autoClear = auto;
  }
  // call every frame; `full` forces a complete refresh (after a jump in time)
  function update(full = false) {
    const s = env.uSunDir.value;
    if (full || last.angleTo(s) > 0.004) {
      if (full || band >= bands) band = 0;                 // start a new sweep
      last.copy(s); mat.uniforms.uSun.value.copy(s);
      if (full) band = bands;
    }
    if (full) {
      pass(core, H, 2 * H / size, 0, size);
      if (farRT) pass(farRT, fm.half, 2 * fm.half / 256, 0, 256);
      return;
    }
    if (band < bands) {
      const rows = size / bands;
      pass(core, H, 2 * H / size, band * rows, (band + 1) * rows);
      if (farRT && band === bands - 1) pass(farRT, fm.half, 2 * fm.half / 256, 0, 256);
      band++;
    }
  }
  return { update, core, far: farRT };
}
