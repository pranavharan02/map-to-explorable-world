// Shared environment: the sun for the world's latitude, longitude and time zone, a sky palette keyed by sun elevation,
// and the uniform objects every custom shader reads. Uniforms are shared objects, so one write updates all materials.
import * as THREE from 'three';

export const env = {
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() },
  uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
  uSkyAmb: { value: new THREE.Color() }, uGndAmb: { value: new THREE.Color() },
  uFogColor: { value: new THREE.Color() },
  uFogParams: { value: new THREE.Vector4(0.00035, 420, 0, 0) },   // haze density, scale height, base altitude, -
  uFogScatter: { value: new THREE.Color() },
  uTime: { value: 0 }, uNight: { value: 0 }, uWind: { value: new THREE.Vector2() }, uCloudCover: { value: 0.38 },
};

// ---------------------------------------------------------------- time zones
// With an IANA zone the browser does the daylight-saving arithmetic; otherwise a fixed offset in hours.
export function makeClock(meta) {
  const tz = meta.timeZone, fixed = (meta.tz ?? Math.round(meta.center.lon / 15)) * 60;
  let fmt = null;
  if (tz) {
    try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); }
    catch { fmt = null; }
  }
  // minutes the zone is ahead of UTC at instant ms
  const offset = (ms) => {
    if (!fmt) return fixed;
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000;
  };
  return {
    offset,
    localHour: (ms) => { const m = ((ms / 60000 + offset(ms)) % 1440 + 1440) % 1440; return m / 60; },
    // the instant at local hour h on the local day containing `ms`
    at(ms, h) {
      const off = offset(ms), day = Math.floor((ms / 60000 + off) / 1440) * 1440;
      let t = (day + h * 60 - off) * 60000;
      t = (day + h * 60 - offset(t)) * 60000;          // second pass settles daylight-saving changeovers
      return t;
    },
    label: tz || `UTC${fixed >= 0 ? '+' : '−'}${Math.floor(Math.abs(fixed) / 60)}${Math.abs(fixed) % 60 ? ':' + String(Math.abs(fixed) % 60).padStart(2, '0') : ''}`,
  };
}

// ---------------------------------------------------------------- sun position
// Low-precision solar ephemeris (Astronomical Almanac), good to about 0.01 degree for this century.
// Returns elevation and azimuth (from north, clockwise) in radians.
export function sunPosition(ms, lat, lon) {
  const n = ms / 864e5 + 2440587.5 - 2451545.0, rad = Math.PI / 180;
  const L = (280.46 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, eps = (23.439 - 4e-7 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = ((gmst * 15 + lon) * rad - ra), phi = lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { el, az: (az + 2 * Math.PI) % (2 * Math.PI) };
}

// direction to an (elevation, azimuth) in the three.js frame (x east, y up, z south)
export const dirFrom = (el, az, v = new THREE.Vector3()) => v.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));

// ---------------------------------------------------------------- palette
// linear RGB keyed by sun elevation in degrees; intensities are pre-exposure
const KEYS = [
  { e: -14, zen: [0.003, 0.005, 0.014], hor: [0.008, 0.011, 0.024], sun: [0, 0, 0], sky: [0.016, 0.022, 0.045], gnd: [0.005, 0.005, 0.007], fog: [0.01, 0.013, 0.024] },
  { e: -5, zen: [0.025, 0.045, 0.12], hor: [0.28, 0.19, 0.2], sun: [0, 0, 0], sky: [0.08, 0.09, 0.15], gnd: [0.025, 0.022, 0.026], fog: [0.17, 0.14, 0.16] },
  { e: 0.5, zen: [0.09, 0.15, 0.34], hor: [0.95, 0.5, 0.27], sun: [1.5, 0.52, 0.18], sky: [0.22, 0.23, 0.31], gnd: [0.08, 0.065, 0.05], fog: [0.68, 0.48, 0.37] },
  { e: 6, zen: [0.14, 0.27, 0.58], hor: [0.95, 0.7, 0.5], sun: [2.4, 1.3, 0.62], sky: [0.34, 0.4, 0.53], gnd: [0.14, 0.12, 0.09], fog: [0.76, 0.67, 0.58] },
  { e: 16, zen: [0.13, 0.31, 0.7], hor: [0.7, 0.78, 0.86], sun: [2.9, 2.4, 1.85], sky: [0.42, 0.52, 0.7], gnd: [0.19, 0.18, 0.14], fog: [0.66, 0.74, 0.82] },
  { e: 55, zen: [0.09, 0.26, 0.68], hor: [0.62, 0.73, 0.86], sun: [3.2, 3.0, 2.7], sky: [0.46, 0.57, 0.76], gnd: [0.23, 0.22, 0.18], fog: [0.64, 0.72, 0.84] },
];
const COLS = ['zen', 'hor', 'sun', 'sky', 'gnd', 'fog'];
function palette(e) {
  let i = 0; while (i < KEYS.length - 2 && e > KEYS[i + 1].e) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  let t = Math.min(1, Math.max(0, (e - a.e) / (b.e - a.e))); t = t * t * (3 - 2 * t);
  const o = {}; for (const k of COLS) o[k] = new THREE.Color(...a[k].map((v, j) => v + (b[k][j] - v) * t));
  return o;
}

// set every environment uniform and the scene lights for an instant
export function applySun(ms, meta, lights, renderer) {
  const { el, az } = sunPosition(ms, meta.center.lat, meta.center.lon);
  const e = el * 180 / Math.PI, P = palette(e);
  const night = Math.min(1, Math.max(0, (-e - 1) / 8));
  // at night the key light becomes a weak, cool moon high in the opposite sky
  const key = e < -1 ? { el: 0.75, az: az + Math.PI } : { el: Math.max(el, -0.02), az };
  dirFrom(key.el, key.az, env.uSunDir.value);
  const sun = P.sun.clone();
  if (night > 0) sun.lerp(new THREE.Color(0.045, 0.06, 0.1), night);
  env.uSunColor.value.copy(sun);
  env.uZenith.value.copy(P.zen); env.uHorizon.value.copy(P.hor); env.uSkyAmb.value.copy(P.sky); env.uGndAmb.value.copy(P.gnd);
  env.uFogColor.value.copy(P.fog); env.uNight.value = night;
  const golden = Math.exp(-(((e - 5) / 9) ** 2));
  env.uFogScatter.value.copy(sun).multiplyScalar(0.06 + 0.22 * golden);
  lights.sun.color.copy(sun); lights.sun.intensity = Math.PI;        // three divides Lambert by pi: this gives albedo x color
  lights.hemi.color.copy(P.sky); lights.hemi.groundColor.copy(P.gnd); lights.hemi.intensity = Math.PI;
  renderer.toneMappingExposure = 0.74 + night * 0.9;
  return { elevation: e, azimuth: az * 180 / Math.PI, night };
}
