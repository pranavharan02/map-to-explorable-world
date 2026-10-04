// Water: worker-built surfaces at every water body's own level, and a reduced-resolution planar reflection.
//
// The reflection renders the scene from a camera mirrored in the water plane nearest to the viewer, with an oblique
// near plane at the waterline so nothing below the surface leaks in. It draws a lighter scene (stand-in trees, no
// shadows, no grass), and it is skipped entirely while an occlusion query says no water reached the screen.
import * as THREE from 'three';
import { env } from './env.js';
import { ATMO_GLSL } from './atmosphere.js';
import { HEIGHT_GLSL } from './world.js';

export function createWater(world, tex, meshes, normalTex, renderer) {
  const rt = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType });
  rt.texture.generateMipmaps = false;
  const texMatrix = new THREE.Matrix4();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...env, uRipple: { value: normalTex }, uRefl: { value: rt.texture }, uTexMatrix: { value: texMatrix }, uReflOn: { value: 0 },
      uPlaneY: { value: 0 }, uHeight: { value: tex.height }, uN: { value: world.n }, uHalf: { value: world.H }, uColor: { value: tex.color },
    },
    vertexShader: /* glsl */`
      uniform mat4 uTexMatrix; varying vec3 vW; varying vec4 vRc;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vRc = uTexMatrix * w; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uRipple, uRefl, uHeight, uColor; uniform float uReflOn, uPlaneY, uN, uHalf, uTime, uNight;
      uniform vec3 uSunDir, uSunColor, uSkyAmb, uZenith, uHorizon;
      varying vec3 vW; varying vec4 vRc;
      ${HEIGHT_GLSL}
      ${ATMO_GLSL}
      void main() {
        float depth = vW.y - gridHeight(uHeight, uN, uHalf, vW.xz);
        if (depth < -0.02) discard;
        float t = uTime;
        vec3 a = texture2D(uRipple, vW.xz * 0.05 + vec2(t * 0.012, t * 0.007)).xzy * 2.0 - 1.0;
        vec3 b = texture2D(uRipple, vW.xz * 0.19 + vec2(-t * 0.019, t * 0.023)).xzy * 2.0 - 1.0;
        vec3 c = texture2D(uRipple, vW.xz * 0.009 + vec2(t * 0.003, -t * 0.002)).xzy * 2.0 - 1.0;
        vec3 V = cameraPosition - vW; float dist = length(V); V /= dist;
        float calm = 0.5 + 0.5 * smoothstep(0.0, 4.0, depth);                   // sheltered shallows are glassier
        vec3 N = normalize(vec3(0.0, 1.0, 0.0) + (a * 0.1 + b * 0.055 + c * 0.11) * vec3(1.0, 0.0, 1.0) * calm * mix(1.0, 0.3, smoothstep(60.0, 800.0, dist)));
        float F = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        vec3 sky = mix(uHorizon, uZenith, pow(max(R.y, 0.0), 0.45));
        // the planar reflection is only valid on (or near) its own plane and fades to the sky far away
        float useRefl = uReflOn * (1.0 - smoothstep(0.6, 2.0, abs(vW.y - uPlaneY))) * (1.0 - smoothstep(500.0, 900.0, dist));
        vec3 refl = mix(sky, texture2D(uRefl, vRc.xy / vRc.w + N.xz * 0.04).rgb, useRefl);
        // body color: what Sentinel-2 saw here (emerald lake, brown river, blue sea), lit by sky and sun
        vec3 sat = texture2D(uColor, (vW.xz + uHalf) / (2.0 * uHalf)).rgb;
        vec3 body = sat * 0.55 * (uSkyAmb + uSunColor * 0.25 * max(uSunDir.y, 0.0));     // same formula as the context ring (far.js)
        vec3 bed = vec3(0.13, 0.11, 0.08) * (uSkyAmb + uSunColor * max(uSunDir.y, 0.0) * 0.5);
        body = mix(bed, body, smoothstep(0.0, 1.6, depth));
        vec3 col = mix(body, refl, F);
        float vis = sunVisibility(vW);
        float sp = max(dot(R, uSunDir), 0.0);
        col += uSunColor * (pow(sp, 900.0) * 9.0 + pow(sp, 90.0) * 0.16) * (1.0 - uNight) * vis;
        vec4 fo = worldFog(vW); col = mix(col, fo.rgb, fo.a);
        gl_FragColor = vec4(col, smoothstep(-0.02, 0.35, depth));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: true,
  });
  const group = new THREE.Group();
  const gl = renderer.getContext();
  const queries = [];
  for (const a of meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
    g.setIndex(new THREE.BufferAttribute(a.index, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); m.matrixAutoUpdate = false; m.renderOrder = 5;
    // one occlusion query per surface, read back a frame later: did any water pixel survive the depth test?
    const q = { q: null, active: false, pending: false };
    queries.push(q);
    m.onBeforeRender = () => { if (q.pending || q.active || capturing) return; q.q ??= gl.createQuery(); gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, q.q); q.active = true; };
    m.onAfterRender = () => { if (q.active) { gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE); q.active = false; q.pending = true; q.frame = frame; } };
    group.add(m);
  }
  let capturing = false, frame = 0, seen = true, scale = 0.35, enabled = meshes.length > 0;
  function poll() {
    let any = false, known = false;
    for (const q of queries) {
      if (q.pending && gl.getQueryParameter(q.q, gl.QUERY_RESULT_AVAILABLE)) { q.result = gl.getQueryParameter(q.q, gl.QUERY_RESULT) > 0; q.pending = false; q.seenAt = frame; }
      if (q.seenAt !== undefined && frame - q.seenAt < 3) { known = true; any = any || q.result; }
    }
    seen = known ? any : true;
  }

  const vcam = new THREE.PerspectiveCamera(), plane = new THREE.Plane(), clip = new THREE.Vector4(), qv = new THREE.Vector4();
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const fwd = new THREE.Vector3(), up = new THREE.Vector3(), size = new THREE.Vector2();
  function render(scene, camera, before, after) {
    frame++;
    poll();
    const y = world.levelAt(camera.position.x, camera.position.z);
    mat.uniforms.uPlaneY.value = y;
    const on = enabled && seen && camera.position.y > y + 0.05;
    mat.uniforms.uReflOn.value = on ? 1 : 0;
    if (!on) return;
    renderer.getDrawingBufferSize(size);
    // high above the water, reflected detail is tiny on screen: a coarser reflection looks the same
    const k = scale * Math.max(0.55, Math.min(1, 1.15 - (camera.position.y - y) / 400));
    const w = Math.max(64, Math.round(size.x * k)), h = Math.max(64, Math.round(size.y * k));
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    vcam.copy(camera);
    vcam.position.y = 2 * y - camera.position.y;
    camera.getWorldDirection(fwd); fwd.y = -fwd.y;
    up.set(0, 1, 0).applyQuaternion(camera.quaternion); up.y = -up.y;
    vcam.up.copy(up); vcam.lookAt(vcam.position.clone().add(fwd)); vcam.updateMatrixWorld();
    vcam.projectionMatrix.copy(camera.projectionMatrix);
    // oblique near plane on the water (Lengyel 2005): the clip volume starts exactly at the surface
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, y, 0)).applyMatrix4(vcam.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const P = vcam.projectionMatrix.elements;
    qv.set((Math.sign(clip.x) + P[8]) / P[0], (Math.sign(clip.y) + P[9]) / P[5], -1, (1 + P[10]) / P[14]);
    clip.multiplyScalar(2 / clip.dot(qv));
    P[2] = clip.x; P[6] = clip.y; P[10] = clip.z + 1 - 0.002; P[14] = clip.w;
    vcam.projectionMatrixInverse.copy(vcam.projectionMatrix).invert();
    texMatrix.copy(bias).multiply(vcam.projectionMatrix).multiply(vcam.matrixWorldInverse);
    vcam.layers.set(0); vcam.layers.enable(2);                  // layer 2: reflection-only stand-ins
    group.visible = false; capturing = true;
    const prev = renderer.getRenderTarget(), auto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    before?.();
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, vcam);
    after?.();
    renderer.setRenderTarget(prev); renderer.shadowMap.autoUpdate = auto;
    group.visible = true; capturing = false;
  }
  return {
    group, render, rt, uniforms: mat.uniforms,
    setScale(s) { scale = s; }, setEnabled(e) { enabled = e && meshes.length > 0; }, get onScreen() { return seen; },
  };
}
