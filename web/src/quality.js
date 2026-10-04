// Quality presets, picked from the GPU that WebGL reports. ?q=low|med|high overrides.
export const PRESETS = {
  low: { name: 'low', shadow: 1024, shadowR: 50, refl: 0.25, maxDpr: 1.0, minDpr: 0.5, detail: 0, grass: { radius: 16, spacing: 0.8 },
    lod: { near: 28, nearBand: 8, far: 110, farBand: 18 }, terrainLod: 0.75, terrainShadow: 256, msaa: false },
  med: { name: 'med', shadow: 2048, shadowR: 70, refl: 0.35, maxDpr: 1.5, minDpr: 0.6, detail: 1, grass: { radius: 24, spacing: 0.65 },
    lod: { near: 40, nearBand: 10, far: 150, farBand: 22 }, terrainLod: 1, terrainShadow: 512, msaa: true },
  high: { name: 'high', shadow: 4096, shadowR: 110, refl: 0.6, maxDpr: 2.0, minDpr: 0.75, detail: 2, grass: { radius: 34, spacing: 0.55 },
    lod: { near: 70, nearBand: 14, far: 240, farBand: 30 }, terrainLod: 1.6, terrainShadow: 1024, msaa: true },
};

export function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2'), e = gl.getExtension('WEBGL_debug_renderer_info');
    const n = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return n || '';
  } catch { return ''; }
}

export function pickPreset(qs, gpu) {
  if (PRESETS[qs.get('q')]) return PRESETS[qs.get('q')];
  const discrete = /NVIDIA|GeForce|Quadro|RTX|Radeon RX|Radeon Pro|Arc\(|Apple M\d (Pro|Max|Ultra)/i.test(gpu) && !/Radeon\(TM\) Graphics|Vega \d+ Graphics|UHD|Iris/i.test(gpu);
  const small = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (navigator.hardwareConcurrency || 8) <= 4;
  return discrete ? PRESETS.high : small ? PRESETS.low : PRESETS.med;
}
