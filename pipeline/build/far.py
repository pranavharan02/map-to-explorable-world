"""The context ring: real relief, satellite color and water out to the horizon around the walkable core.

Nothing out here is walkable, so it is cheap: a coarse heightfield, one color image, a shore distance field for the
water, and impostor-only trees on the near part of the ring. The core heightfield overwrites the ring's own samples
inside the core box, so the seam at the core edge lines up.
"""
import numpy as np
from scipy.ndimage import binary_dilation, distance_transform_edt, find_objects, gaussian_filter, label

from .. import geo
from .ground import tone
from .raster import resize, signed_distance
from .trees import mix_weights, pick
from .water import satellite_water

FAR_N = 513     # heightfield samples per side
FAR_C = 1024    # color pixels per side


def solve(cfg, data, T, biome, rng, core_level=None, core_water=None):
    half, far = cfg["half"], cfg["far"]
    H = gaussian_filter(np.asarray(data["dem_far"], np.float64), 0.6)
    cell = 2 * far / (FAR_N - 1)
    xs, ys = geo.point_axes(far, FAR_N)
    gx, gy = np.meshgrid(xs, ys)
    inner = (np.abs(gx) <= half) & (np.abs(gy) <= half)
    H[inner] = T.sample(gx[inner], gy[inner])
    gyy, gxx = np.gradient(H, cell)
    slope = np.degrees(np.arctan(np.hypot(gxx, gyy)))
    ac, ar = geo.area_px(*np.meshgrid(*geo.area_axes(far, FAR_C)), far, FAR_C)
    pc, pr = geo.point_px(*np.meshgrid(*geo.area_axes(far, FAR_C)), far, FAR_N)
    slope_c = geo.bilinear(slope, pc, pr)
    water, ndvi, _ = satellite_water(data["s2_far"], data["wc_far"], slope_c, cfg["water"]["threshold"], 2 * far / FAR_C, FAR_C)
    # flat level per far water body, from its banks; the ring heightfield sits exactly on it over water
    c, r = geo.area_px(gx, gy, far, FAR_C)
    Wp = geo.nearest(water.astype(np.uint8), c, r) > 0
    Wp &= ~inner
    lab, n = label(Wp)
    for k, sl in enumerate(find_objects(lab), start=1):
        if sl is None:
            continue
        sl = (slice(max(0, sl[0].start - 3), sl[0].stop + 3), slice(max(0, sl[1].start - 3), sl[1].stop + 3))
        comp = lab[sl] == k
        ring = binary_dilation(comp, iterations=2) & ~Wp[sl]
        if ring.sum() < 2:
            continue
        level = np.percentile(H[sl][ring], 25)
        if core_level is not None:   # touches the core box: take the level of the core water it continues
            touch = binary_dilation(comp, iterations=2) & inner[sl]
            if touch.any():
                tx, ty = gx[sl][touch], gy[sl][touch]
                pc, pr = geo.point_px(tx, ty, half, T.n)
                wet = geo.nearest(core_water.astype(np.uint8), pc, pr) > 0
                if wet.any():
                    level = float(np.median(geo.bilinear(core_level, pc[wet], pr[wet])))
        H[sl][comp] = level
    sd = signed_distance(water, 2 * far / FAR_C)
    rgb = np.dstack([data["s2_far"][b] for b in ("red", "green", "blue")])
    col = tone(rgb)
    print(f"  far: {2 * far / 1000:.0f} km ring, relief {H.min():.0f}..{H.max():.0f} m, water {water.mean():.1%}")
    trees = far_trees(cfg, data, H, far, water, ndvi, slope, biome, rng) if cfg["vegetation"]["farTrees"] else np.zeros((0, 5))
    return dict(H=H, sd=sd, col=col, trees=trees)


def far_trees(cfg, data, H, far, water, ndvi, slope, biome, rng):
    half = cfg["half"]
    R = min(far, half + 1900, 3150)
    g = 9.0
    ax = np.arange(-R + g / 2, R, g)
    gx, gy = np.meshgrid(ax, ax)
    x = (gx + rng.uniform(-0.45, 0.45, gx.shape) * g).ravel()
    y = (gy + rng.uniform(-0.45, 0.45, gy.shape) * g).ravel()
    keep = (np.abs(x) > half + 4) | (np.abs(y) > half + 4)
    x, y = x[keep], y[keep]
    ac, ar = geo.area_px(x, y, far, FAR_C)
    pc, pr = geo.point_px(x, y, far, FAR_N)
    cls = geo.nearest(data["wc_far"], ac, ar)
    nd = np.clip((geo.bilinear(ndvi, ac, ar) - 0.3) / 0.4, 0, 1)
    z = geo.bilinear(H, pc, pr)
    treeline = 3700 - 32 * abs(cfg["center"]["lat"])
    p = np.where(cls == 10, 0.6 + 0.35 * nd, np.where(cls == 50, 0.08 * nd, np.where(cls == 20, 0.15, 0.03 * nd)))
    p *= (~geo.nearest(water, ac, ar)) * (geo.bilinear(slope, pc, pr) < 50) * np.clip((treeline - z) / 150, 0, 1)
    sel = rng.random(len(x)) < p * 0.8 * float(cfg["vegetation"]["density"])
    x, y, z = x[sel], y[sel], z[sel]
    sp = pick(mix_weights(biome, cls[sel] == 50, z, np.zeros(len(x), int)), rng)
    out = np.c_[x, y, sp, rng.integers(0, 256, len(x)), np.clip(rng.normal(0.7, 0.12, len(x)), 0.35, 1)]
    cap = 140000
    if len(out) > cap:
        out = out[rng.choice(len(out), cap, replace=False)]
    print(f"  far: {len(out)} impostor trees out to {R / 1000:.1f} km")
    return out
