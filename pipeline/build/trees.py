"""Trees: where the satellite and the map say there is canopy, plant individual trees.

Canopy probability comes from WorldCover (tree cover, shrubland, built-up with gardens), graded by Sentinel-2 NDVI, and
raised by OpenStreetMap forests, parks and orchards. Mapped single trees (natural=tree) and tree rows are planted where
they stand. Species follow the biome and the elevation (conifers take over higher up in temperate and boreal regions),
and OSM's leaf_type wins inside a mapped forest. Nothing grows on roads, paving, water, buildings, cliffs or above the
tree line.
"""
import numpy as np
from scipy.ndimage import binary_dilation

from .. import geo
from .raster import Canvas

SPECIES = ["broad", "tall", "conifer", "pine", "palm", "shrub"]
# (broad, tall, conifer, pine, palm): forest mix, then town mix
MIX = {
    "tropical": ([0.55, 0.2, 0, 0, 0.25], [0.45, 0.1, 0, 0, 0.45]),
    "subtropical": ([0.45, 0.2, 0.05, 0.25, 0.05], [0.45, 0.2, 0, 0.15, 0.2]),
    "arid": ([0.3, 0.2, 0, 0.3, 0.2], [0.3, 0.15, 0, 0.15, 0.4]),
    "temperate": ([0.55, 0.15, 0.25, 0.05, 0], [0.7, 0.2, 0.07, 0.03, 0]),
    "boreal": ([0.15, 0.2, 0.5, 0.15, 0], [0.4, 0.3, 0.2, 0.1, 0]),
}
CONIFER_FROM = {"tropical": 2500, "subtropical": 1200, "arid": 1500, "temperate": 650, "boreal": 250}
# canopy probability per WorldCover class (trees, shrubs), before NDVI grading
WC_P = {10: (0.85, 0.05), 20: (0.08, 0.35), 30: (0.03, 0.04), 40: (0.004, 0.004), 50: (0.05, 0.03), 60: (0.004, 0.02),
        90: (0.03, 0.15), 95: (0.7, 0.2), 100: (0.0, 0.02)}


def mix_weights(biome, town, z, leaf):
    """Per-candidate species weights (n, 5) for the tree species."""
    forest, urban = (np.array(m, np.float64) for m in MIX.get(biome, MIX["temperate"]))
    w = np.where(town[:, None], urban[None, :], forest[None, :])
    z0 = CONIFER_FROM.get(biome, 650)
    up = np.clip((z - z0) / 500, 0, 3)
    w[:, 2] *= 1 + up * 1.4
    w[:, 3] *= 1 + up * 0.5
    w[:, 0] *= np.clip(1 - (z - z0 - 400) / 900, 0.08, 1)
    w[:, 1] *= np.clip(1 - (z - z0 - 400) / 900, 0.08, 1)
    w[leaf == 1, 0:2] = 0           # needle-leaved forest
    w[leaf == 1, 4] = 0
    w[leaf == 2, 2:4] = 0           # broad-leaved forest
    w += 1e-9
    return w / w.sum(1, keepdims=True)


def pick(w, rng):
    u = rng.random(len(w))[:, None]
    return (u > np.cumsum(w, 1)).sum(1).clip(0, w.shape[1] - 1)


def solve(cfg, data, F, T, shore_sd, road_sd, ground_extra, bmask_cover, biome, rng):
    half, C, M = cfg["half"], int(cfg["coverResolution"]), int(cfg["maskResolution"])
    dens = float(cfg["vegetation"]["density"])
    wc = data["wc"]
    s2 = data["s2"]
    ndvi = np.nan_to_num((s2["nir"] - s2["red"]) / (s2["nir"] + s2["red"] + 1e-6))
    canv = {k: Canvas(half, C) for k in ("forest", "park", "orchard", "scrub", "needle", "broadleaf", "town", "paved")}
    for a in F["areas"]:
        if a["cover"] in ("paved", "pier", "pitch"):
            canv["paved"].polygon(a["outer"], a["holes"])
        cv = {"forest": "forest", "park": "park", "farm": None, "scrub": "scrub", "urban": "town"}.get(a["cover"])
        if a["cover"] == "farm" and a.get("leaf") is None:
            continue
        if cv:
            canv[cv].polygon(a["outer"], a["holes"])
        if a.get("leaf") == "needleleaved":
            canv["needle"].polygon(a["outer"], a["holes"])
        elif a.get("leaf") == "broadleaved":
            canv["broadleaf"].polygon(a["outer"], a["holes"])
    blocked = binary_dilation(bmask_cover, iterations=1)
    # candidate grid, jittered
    g = max(3.0, 2 * half / 700)
    ax = np.arange(-half + g / 2, half, g)
    gx, gy = np.meshgrid(ax, ax)
    x = (gx + rng.uniform(-0.45, 0.45, gx.shape) * g).ravel()
    y = (gy + rng.uniform(-0.45, 0.45, gy.shape) * g).ravel()
    ac, ar = geo.area_px(x, y, half, C)
    mc, mr = geo.area_px(x, y, half, M)
    cls = geo.nearest(wc, ac, ar)
    nd = np.clip((geo.bilinear(ndvi, ac, ar) - 0.3) / 0.4, 0, 1)
    pt = np.zeros(len(x)); ps = np.zeros(len(x))
    for k, (a, b) in WC_P.items():
        m = cls == k
        pt[m], ps[m] = a, b
    pt *= 0.35 + 0.9 * nd
    on = lambda name: geo.nearest(canv[name].array(), ac, ar) > 127
    forest, park, scrub, town = on("forest"), on("park"), on("scrub"), on("town") | (cls == 50)
    pt = np.where(forest, np.maximum(pt, 0.65 + 0.3 * nd), pt)
    pt = np.where(park, np.maximum(pt, 0.08 + 0.25 * nd), pt)
    ps = np.where(scrub, np.maximum(ps, 0.4), ps)
    z = T.sample(x, y)
    pc, pr = geo.point_px(x, y, half, T.n)
    slope = geo.bilinear(T.slope_deg(), pc, pr)
    treeline = 3700 - 32 * abs(cfg["center"]["lat"])
    # mapped squares, car parks and pitches stay clear; built-up land in general does not (gardens, verges, courtyards)
    ok = ((geo.bilinear(shore_sd, mc, mr) > 0.7) & (geo.bilinear(road_sd, mc, mr) > 1.4) &
          ~(geo.nearest(canv["paved"].array(), ac, ar) > 127) & ~geo.nearest(blocked, ac, ar) & (slope < 48))
    pt *= np.clip((treeline - z) / 150, 0, 1)
    cell_scale = (g * g) / 9.0
    is_tree = ok & (rng.random(len(x)) < pt * 0.24 * dens * cell_scale)
    is_shrub = ok & ~is_tree & (rng.random(len(x)) < ps * 0.18 * dens * cell_scale)
    leaf = np.where(on("needle"), 1, np.where(on("broadleaf"), 2, 0))
    i = np.nonzero(is_tree)[0]
    sp = pick(mix_weights(biome, town[i], z[i], leaf[i]), rng)
    trees = [np.c_[x[i], y[i], sp, rng.integers(0, 256, len(i)), np.clip(rng.normal(0.62, 0.14, len(i)), 0.25, 1)]]
    j = np.nonzero(is_shrub)[0]
    trees.append(np.c_[x[j], y[j], np.full(len(j), 5), rng.integers(0, 256, len(j)), rng.uniform(0.3, 0.8, len(j))])
    # street trees: both sides of town streets, where the satellite sees canopy over the curb
    st = []
    for r in F["roads"]:
        if r["kind"] not in ("primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "pedestrian"):
            continue
        p = r["pts"]
        seg = np.hypot(*np.diff(p, axis=0).T)
        if seg.sum() < 15:
            continue
        cum = np.r_[0, np.cumsum(seg)]
        for d in np.arange(rng.uniform(3, 9), cum[-1] - 3, 11.0):
            k = min(np.searchsorted(cum, d, side="right") - 1, len(seg) - 1)
            t0 = (d - cum[k]) / max(seg[k], 1e-6)
            q = p[k] + (p[k + 1] - p[k]) * t0
            e = (p[k + 1] - p[k]) / max(seg[k], 1e-6)
            for side in (-1, 1):
                off = r["w"] / 2 + 1.6 + rng.uniform(0, 0.8)
                st.append((q[0] - e[1] * off * side, q[1] + e[0] * off * side))
    if st:
        st = np.array(st)
        sc_, sr_ = geo.area_px(st[:, 0], st[:, 1], half, C)
        sm_, sn_ = geo.area_px(st[:, 0], st[:, 1], half, M)
        green = np.clip((geo.bilinear(ndvi, sc_, sr_) - 0.18) / 0.3, 0, 1)
        good = ((geo.bilinear(road_sd, sm_, sn_) > 1.0) & (geo.bilinear(shore_sd, sm_, sn_) > 1.0) &
                ~geo.nearest(blocked, sc_, sr_) & (rng.random(len(st)) < green * 0.85 * dens))
        st = st[good]
        sp = pick(mix_weights(biome, np.ones(len(st), bool), T.sample(st[:, 0], st[:, 1]), np.zeros(len(st), int)), rng)
        trees.append(np.c_[st, sp, rng.integers(0, 256, len(st)), np.clip(rng.normal(0.66, 0.12, len(st)), 0.35, 1)])
    # mapped trees and tree rows
    pts = []
    for t in F["trees"]:
        pts.append((t["x"], t["y"], t.get("leaf"), t.get("h")))
    for row in F["tree_rows"]:
        p = row["pts"]
        seg = np.hypot(*np.diff(p, axis=0).T)
        L = seg.sum()
        for d in np.arange(3.5, L, 7.0):
            k = min(np.searchsorted(np.cumsum(seg), d), len(seg) - 1)
            t0 = (d - (np.cumsum(seg)[k] - seg[k])) / max(seg[k], 1e-6)
            q = p[k] + (p[k + 1] - p[k]) * t0
            pts.append((q[0] + rng.normal(0, 0.4), q[1] + rng.normal(0, 0.4), row.get("leaf"), None))
    if pts:
        px_ = np.array([q[0] for q in pts]); py_ = np.array([q[1] for q in pts])
        lf = np.array([1 if q[2] == "needleleaved" else 2 if q[2] == "broadleaved" else 0 for q in pts])
        sp = pick(mix_weights(biome, np.ones(len(pts), bool), T.sample(px_, py_), lf), rng)
        hs = np.array([q[3] or 0 for q in pts], np.float64)
        sc = np.where(hs > 0, np.clip(hs / 16, 0.25, 1), np.clip(rng.normal(0.6, 0.1, len(pts)), 0.3, 1))
        trees.append(np.c_[px_, py_, sp, rng.integers(0, 256, len(pts)), sc])
    # yard shrubs: a few against the walls of houses
    yard = []
    for b in F["buildings"]:
        if b["area"] > 400 or rng.random() > 0.55:
            continue
        o = b["outer"]
        for _ in range(int(rng.integers(1, 4))):
            k = int(rng.integers(0, len(o)))
            p0, p1 = o[k], o[(k + 1) % len(o)]
            e = p1 - p0
            L = np.hypot(*e)
            if L < 2:
                continue
            nrm = np.array([e[1], -e[0]]) / L
            q = p0 + e * rng.uniform(0.2, 0.8) + nrm * rng.uniform(1.3, 3.2)
            yard.append(q)
    if yard:
        yard = np.array(yard)
        yc, yr = geo.area_px(yard[:, 0], yard[:, 1], half, C)
        ym, yn = geo.area_px(yard[:, 0], yard[:, 1], half, M)
        good = ~geo.nearest(blocked, yc, yr) & (geo.bilinear(road_sd, ym, yn) > 0.8) & (geo.bilinear(shore_sd, ym, yn) > 0.8)
        yard = yard[good]
        trees.append(np.c_[yard, np.full(len(yard), 5), rng.integers(0, 256, len(yard)), rng.uniform(0.25, 0.6, len(yard))])
    allt = np.vstack(trees)
    allt = allt[(np.abs(allt[:, 0]) < half - 1) & (np.abs(allt[:, 1]) < half - 1)]
    cap = int(cfg["vegetation"]["maxTrees"])
    if len(allt) > cap:
        allt = allt[rng.choice(len(allt), cap, replace=False)]
    counts = np.bincount(allt[:, 2].astype(int), minlength=6)
    print("  trees: " + ", ".join(f"{SPECIES[k]} {counts[k]}" for k in range(6) if counts[k]))
    return allt
