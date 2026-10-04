"""Water: where it is, where its surface sits, and the terrain carved to hold it.

Where: Sentinel-2 sees open water directly through two water indices, NDWI (green vs near infrared) and MNDWI (green vs
short-wave infrared). Satellite water alone misses streams narrower than a 10 m pixel, and OpenStreetMap alone fails in
both directions (a lake multipolygon can swallow an island; a river polygon can be missing), so the two are combined:
OSM adds what the satellite cannot resolve, and strongly vegetated satellite pixels veto OSM water on top of them.
Shadowed mountainsides can look like water to both indices, so satellite water must also be flat.

Height: every connected water body gets a surface level from the elevation of its own banks. Lakes and the sea are
flat; a body whose banks drop more than a few meters (a river) gets a smoothly varying level instead. The terrain is
then carved below each level into a shelving bed, and the banks are raised just above it, so the shoreline the
renderer draws is where the terrain and the water surface actually cross.
"""
import numpy as np
from scipy.ndimage import binary_dilation, binary_opening, distance_transform_edt, find_objects, gaussian_filter, label

from .. import geo
from .raster import Canvas, nconv, resize, signed_distance


def indices(s2):
    g, nir, sw, r = s2["green"], s2["nir"], s2["swir16"], s2["red"]
    with np.errstate(all="ignore"):
        ndwi = (g - nir) / (g + nir + 1e-6)
        mndwi = (g - sw) / (g + sw + 1e-6)
        ndvi = (nir - r) / (nir + r + 1e-6)
    score = np.nan_to_num(np.maximum(ndwi, 0.8 * mndwi), nan=-1)
    votes = s2["water"] / np.maximum(s2["clear"], 1)
    return score, votes, np.nan_to_num(ndvi)


def drop_small(mask, min_px):
    lab, n = label(mask)
    if n == 0:
        return mask
    sizes = np.bincount(lab.ravel())
    small = sizes < min_px
    small[0] = False
    return mask & ~small[lab]


def satellite_water(s2, wc, slope, thr, px_m, n_out):
    """Boolean water mask from Sentinel-2 on an n_out x n_out area grid."""
    score, votes, ndvi = indices(s2)
    sc = resize(gaussian_filter(score, 0.6), n_out, order=3)
    vt = resize(votes, n_out, order=1)
    wcM = resize(wc.astype(np.float32), n_out, order=0)
    w = (sc > thr) & ((vt >= 0.5) | (sc > 0.25) | (wcM == 80)) & (slope < 12)
    w = binary_opening(w, iterations=1)
    return drop_small(w, 300 / px_m ** 2), resize(ndvi, n_out, order=1), sc


def solve_mask(cfg, data, F, T):
    half, M = cfg["half"], int(cfg["maskResolution"])
    px = 2 * half / M
    gx, gy = np.meshgrid(*geo.area_axes(half, M))
    c, r = geo.point_px(gx, gy, half, T.n)
    slope = geo.bilinear(T.slope_deg(), c, r)
    s2w, ndvi, score = satellite_water(data["s2"], data["wc"], slope, cfg["water"]["threshold"], px, M)
    big, small, lines, isl, solid = (Canvas(half, M) for _ in range(5))
    for w in F["water"]:
        (big if w["area"] > 5000 else small).polygon(w["outer"], w["holes"])
    for w in F["waterways"]:
        lines.line(w["pts"], w["w"])
    for o in F["islands"]:
        isl.polygon(o)
    for b in F["buildings"] + F["parts"]:
        solid.polygon(b["outer"])
    for a in F["areas"]:
        if a["cover"] == "pier":
            solid.polygon(a["outer"], a["holes"])
    vegetated = (ndvi > 0.45) & (score < -0.15)
    water = s2w | small.mask() | (big.mask() & ~vegetated) | lines.mask()
    water &= ~isl.mask() & ~solid.mask()
    # specks of "land" inside open water are noise; real islets are larger than ~40 m^2
    water |= ~drop_small(~water, 40 / px ** 2) & ~solid.mask() & ~isl.mask()
    sd = gaussian_filter(signed_distance(water, px), 0.7)
    print(f"  water: {water.mean():.1%} of the core ({s2w.mean():.1%} satellite, OSM polygons {len(F['water'])}, "
          f"waterways {len(F['waterways'])})")
    return water, sd


def solve_levels(water_area, T):
    """Water-surface level on T's point grid, carve the bed, raise the banks. Returns (levels, mask, bodies)."""
    half, n, cell, H = T.half, T.n, T.cell, T.H
    gx, gy = np.meshgrid(T.xs, T.ys)
    c, r = geo.area_px(gx, gy, half, water_area.shape[0])
    Wp = geo.nearest(water_area.astype(np.uint8), c, r) > 0
    if not Wp.any():
        return np.full(H.shape, H.min() - 50.0), Wp, []
    lab, nc = label(Wp, structure=np.ones((3, 3)))
    L = np.full(H.shape, np.nan)
    maxd = np.zeros(H.shape)
    sig = 40.0 / cell
    pad = int(3 * sig) + 3
    bodies = []
    for k, sl in enumerate(find_objects(lab), start=1):
        if sl is None:
            continue
        sl = (slice(max(0, sl[0].start - pad), min(n, sl[0].stop + pad)), slice(max(0, sl[1].start - pad), min(n, sl[1].stop + pad)))
        comp = lab[sl] == k
        ring = binary_dilation(comp, iterations=2) & ~Wp[sl]
        hs = H[sl][ring] if ring.sum() >= 3 else H[sl][comp]
        p10, p25, p90 = np.percentile(hs, [10, 25, 90])
        area = comp.sum() * cell * cell
        flat = (p90 - p10) < 3.0 or area > 0.15 * (2 * half) ** 2
        if flat:
            L[sl][comp] = p25
        else:
            v, den = nconv(np.where(ring, H[sl], 0.0), ring.astype(np.float64), sig)
            L[sl][comp] = np.where(den > 1e-4, v, p25)[comp]
        maxd[sl][comp] = 6.0 if flat else 2.2
        ys, xs = np.nonzero(comp)
        bodies.append(dict(level=round(float(p25), 2), area=round(float(area)), flat=bool(flat),
                           x=round(float(T.xs[sl[1].start + int(xs.mean())]), 1), y=round(float(T.ys[sl[0].start + int(ys.mean())]), 1)))
    # every land sample takes the level of its nearest water sample (the renderer's reflection plane uses this too)
    dist_out, idx = distance_transform_edt(~Wp, return_indices=True)
    Lext = L[idx[0], idx[1]]
    maxd = maxd[idx[0], idx[1]]
    d_in = distance_transform_edt(Wp) * cell
    d_out = dist_out * cell
    bed = Lext - np.clip(0.3 + 0.25 * np.maximum(d_in - cell * 0.5, 0), 0.3, maxd)
    Hn = np.where(Wp, bed, H)            # a shelving bed from the shore profile; DEM values under water are unreliable
    t = np.clip(d_out / 8.0, 0, 1)
    bank = Lext + 0.1 + 0.35 * t * t * (3 - 2 * t)
    Hn = np.where(~Wp & (d_out < 14), np.maximum(Hn, bank), Hn)
    band = np.exp(-np.minimum(d_in, d_out) ** 2 / (2 * 4.0 ** 2))
    Hn = Hn * (1 - band) + gaussian_filter(Hn, 0.8) * band
    T.H = Hn
    bodies.sort(key=lambda b: -b["area"])
    print(f"  water: {len(bodies)} bodies; largest {bodies[0]['area'] / 1e4:.1f} ha at {bodies[0]['level']:.1f} m"
          f"{' (flat)' if bodies[0]['flat'] else ' (sloping)'}")
    return Lext, Wp, bodies


def bank_guard(T, Lext, Wp):
    """Re-assert the minimum bank height after later terrain edits (road grading)."""
    d_out = distance_transform_edt(~Wp) * T.cell
    t = np.clip(d_out / 8.0, 0, 1)
    bank = Lext + 0.1 + 0.35 * t * t * (3 - 2 * t)
    T.H = np.where(~Wp & (d_out < 14), np.maximum(T.H, bank), T.H)
