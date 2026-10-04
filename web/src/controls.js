// Walking (pointer lock; collides with buildings, trunks, steep slopes and deep water), free flight, and a drone tour
// along the package's tour points. Touch: drag one finger to look, hold a second finger down to move forward.
import * as THREE from 'three';

const EYE = 1.65;

export function createControls(camera, dom, world, hooks) {
  const keys = new Set();
  let mode = 'walk', locked = false, yaw = 0, pitch = -0.05, flySpeed = 22, vy = 0, sens = 1, bob = 0, stepDist = 0;
  const pos = new THREE.Vector3();
  const H = world.H;
  const blocked = (x, z) => {
    if (Math.abs(x) > H - 25 || Math.abs(z) > H - 25) return true;
    if (world.waterAt(x, z) > 0.5 && world.levelAt(x, z) - world.heightAt(x, z) > 0.9) return true;   // wade, don't swim
    if (hooks.building?.(x, z, 0.55)) return true;                // keep the 0.35 m near plane clear of walls
    if (hooks.trunk?.(x, z)) return true;
    return false;
  };
  const steepFrom = (x0, z0, x1, z1) => {
    const d = Math.hypot(x1 - x0, z1 - z0);
    return d > 0 && (world.heightAt(x1, z1) - world.heightAt(x0, z0)) / d > 1.2;              // ~50 degrees uphill
  };

  addEventListener('keydown', e => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    keys.add(e.code);
    if (e.code === 'KeyF') setMode(mode === 'fly' ? 'walk' : 'fly');
    if (e.code === 'KeyG') setMode(mode === 'tour' ? 'fly' : 'tour');
    if (/^Digit[1-9]$/.test(e.code)) view(+e.code.slice(5) - 1);
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  dom.addEventListener('click', () => { if (!locked && mode !== 'tour') dom.requestPointerLock?.(); });
  document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === dom; hooks.onLock?.(locked); });
  addEventListener('mousemove', e => {
    if (!locked) return;
    yaw -= e.movementX * 0.0022 * sens; pitch = Math.max(-1.45, Math.min(1.45, pitch - e.movementY * 0.0022 * sens));
  });
  let touchFwd = false; const touches = new Map();
  dom.addEventListener('touchstart', e => { for (const t of e.changedTouches) touches.set(t.identifier, [t.clientX, t.clientY]); touchFwd = touches.size >= 2; e.preventDefault(); }, { passive: false });
  dom.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      const p = touches.get(t.identifier); if (!p) continue;
      if (touches.size === 1) { yaw -= (t.clientX - p[0]) * 0.005 * sens; pitch = Math.max(-1.45, Math.min(1.45, pitch - (t.clientY - p[1]) * 0.005 * sens)); }
      touches.set(t.identifier, [t.clientX, t.clientY]);
    }
    e.preventDefault();
  }, { passive: false });
  const tend = e => { for (const t of e.changedTouches) touches.delete(t.identifier); touchFwd = touches.size >= 2; };
  dom.addEventListener('touchend', tend); dom.addEventListener('touchcancel', tend);
  addEventListener('wheel', e => { if (mode === 'fly') flySpeed = Math.max(3, Math.min(250, flySpeed * (e.deltaY > 0 ? 0.85 : 1.18))); }, { passive: true });

  // viewpoints from the package; heading is the direction faced, in the package frame (radians from east, north up)
  const views = (world.meta.views || []).map(v => ({ ...v, z: -v.y, yaw: Math.atan2(-Math.cos(v.heading), Math.sin(v.heading)) }));
  function nudgeFree() {
    for (let r = 1; r < 60; r += 1) for (let a = 0; a < 16; a++) {
      const x = pos.x + Math.cos(a / 16 * 6.283) * r, z = pos.z + Math.sin(a / 16 * 6.283) * r;
      if (!blocked(x, z)) { pos.x = x; pos.z = z; return; }
    }
  }
  // how far you can see along a heading before a wall, a trunk or rising ground gets in the way (max 90 m)
  function sightline(a) {
    const dx = -Math.sin(a), dz = -Math.cos(a), eye = world.heightAt(pos.x, pos.z) + EYE;
    for (let d = 2; d <= 90; d += 2) {
      const x = pos.x + dx * d, z = pos.z + dz * d;
      if (hooks.building?.(x, z, 0.2) || hooks.trunk?.(x, z, 0.1) || world.heightAt(x, z) > eye + d * 0.12) return d;
    }
    return 90;
  }
  function view(i) {
    const v = views[i]; if (!v) return false;
    pos.set(v.x, 0, v.z); yaw = v.yaw; pitch = v.mode === 'fly' ? -0.42 : -0.04;
    if (v.mode === 'fly') { pos.y = world.groundAt(v.x, v.z) + (v.agl || 120); setMode('fly'); }
    else {
      setMode('walk'); if (blocked(pos.x, pos.z)) nudgeFree(); pos.y = world.heightAt(pos.x, pos.z) + EYE; vy = 0;
      // keep the suggested heading if it has a view; otherwise turn to the longest clear sightline near it
      let best = yaw, score = -1;
      for (let k = 0; k < 32; k++) {
        const a = v.yaw + (k / 32) * Math.PI * 2, s = sightline(a) + 25 * Math.cos(a - v.yaw);
        if (s > score) { score = s; best = a; }
      }
      yaw = best;
    }
    hooks.onView?.(v);
    return true;
  }
  // the drone tour: a centripetal Catmull-Rom loop through the package's tour points
  const tourPts = (world.meta.tour || []).map(t => new THREE.Vector3(t.x, 0, -t.y));
  tourPts.forEach((p, k) => { p.y = Math.max(world.groundAt(p.x, p.z), world.levelAt?.(p.x, p.z) ?? -1e9) + world.meta.tour[k].agl; });
  const tour = tourPts.length > 3 ? new THREE.CatmullRomCurve3(tourPts, true, 'centripetal', 0.5) : null;
  const tourLen = tour ? tour.getLength() : 1; let tourS = 0, lastCap = -1;
  function setMode(m) {
    if (m === 'tour' && !tour) m = 'fly';
    if (m === 'walk' && mode !== 'walk') { if (blocked(pos.x, pos.z)) nudgeFree(); pos.y = world.heightAt(pos.x, pos.z) + EYE; vy = 0; }
    if (m === 'tour') { tourS = 0; lastCap = -1; document.exitPointerLock?.(); }
    if (mode === 'tour' && m !== 'tour') hooks.onCaption?.('');
    mode = m; hooks.onMode?.(m);
  }

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), mv = new THREE.Vector3(), look = new THREE.Vector3();
  function update(dt) {
    if (mode === 'tour') {
      tourS = (tourS + dt * 16 / tourLen) % 1;
      const p = tour.getPointAt(tourS), ahead = tour.getPointAt((tourS + 0.02) % 1);
      pos.copy(p);
      const floor = Math.max(world.groundAt(p.x, p.z), world.levelAt(p.x, p.z)) + 25;
      if (pos.y < floor) pos.y = floor;
      look.copy(ahead).sub(p); look.y -= 6 + (p.y - world.groundAt(p.x, p.z)) * 0.3;
      yaw = Math.atan2(-look.x, -look.z); pitch = Math.atan2(look.y, Math.hypot(look.x, look.z));
      const k = Math.round(tourS * world.meta.tour.length) % world.meta.tour.length;
      if (k !== lastCap) { lastCap = k; const c = world.meta.tour[k].caption; if (c) hooks.onCaption?.(c); }
      if (['KeyW', 'KeyS', 'KeyA', 'KeyD'].some(c => keys.has(c))) setMode('fly');
    } else {
      fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw)); right.set(-fwd.z, 0, fwd.x);
      mv.set(0, 0, 0);
      if (keys.has('KeyW') || keys.has('ArrowUp') || touchFwd) mv.add(fwd);
      if (keys.has('KeyS') || keys.has('ArrowDown')) mv.sub(fwd);
      if (keys.has('KeyD') || keys.has('ArrowRight')) mv.add(right);
      if (keys.has('KeyA') || keys.has('ArrowLeft')) mv.sub(right);
      const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
      if (mode === 'walk') {
        const depth = world.waterAt(pos.x, pos.z) > 0.5 ? Math.max(0, world.levelAt(pos.x, pos.z) - world.heightAt(pos.x, pos.z)) : 0;
        if (mv.lengthSq() > 0) mv.normalize().multiplyScalar((run ? 7.5 : 3.4) * dt * (1 - Math.min(0.6, depth)));
        const nx = pos.x + mv.x, nz = pos.z + mv.z;
        const ok = (x, z) => !blocked(x, z) && !steepFrom(pos.x, pos.z, x, z);
        if (ok(nx, nz)) { pos.x = nx; pos.z = nz; } else if (ok(nx, pos.z)) pos.x = nx; else if (ok(pos.x, nz)) pos.z = nz;
        const g = world.heightAt(pos.x, pos.z) + EYE;
        if (keys.has('Space') && pos.y <= g + 0.02) vy = 4.3;
        vy -= 9.8 * dt; pos.y += vy * dt;
        if (pos.y < g) { pos.y = g; vy = 0; }
        bob += mv.length() * 2.1;
        stepDist += mv.length();
        if (stepDist > (run ? 1.1 : 0.75)) { stepDist = 0; hooks.onStep?.(depth > 0.05 ? 'water' : world.roadAt(pos.x, pos.z) < 0 ? 'road' : 'ground'); }
      } else {
        const s = flySpeed * (run ? 3 : 1) * dt;
        const f3 = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
        if (keys.has('KeyW') || touchFwd) pos.addScaledVector(f3, s);
        if (keys.has('KeyS')) pos.addScaledVector(f3, -s);
        if (keys.has('KeyD')) pos.addScaledVector(right, s);
        if (keys.has('KeyA')) pos.addScaledVector(right, -s);
        if (keys.has('Space')) pos.y += s;
        if (keys.has('KeyQ') || keys.has('KeyC')) pos.y -= s;
        const lim = (world.meta.far?.half ?? H) - 50;
        pos.x = Math.max(-lim, Math.min(lim, pos.x)); pos.z = Math.max(-lim, Math.min(lim, pos.z));
        const floor = Math.max(world.groundAt(pos.x, pos.z), world.levelAt(pos.x, pos.z)) + 1.5;
        pos.y = Math.max(floor, Math.min(floor + 3000, pos.y));
      }
    }
    camera.position.copy(pos);
    if (mode === 'walk') camera.position.y += Math.sin(bob) * 0.022;
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }
  return {
    update, view, setMode, blocked, views,
    get mode() { return mode; }, get locked() { return locked; }, get yaw() { return yaw; }, get pitch() { return pitch; },
    setPose(p, y, pi) { pos.copy(p); yaw = y; pitch = pi; },
    get sensitivity() { return sens; }, set sensitivity(v) { sens = v; },
  };
}
