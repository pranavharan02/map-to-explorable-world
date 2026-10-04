"""Sentinel-2 L2A surface reflectance from the Element 84 Earth Search catalog (public COGs on AWS, no account).

The catalog's cloud figure is for a whole 110 km tile, which says little about one small town, so scenes are ranked
by the cloud fraction inside the world's own box, read from each scene's scene-classification band (SCL, 20 m). The
clearest few scenes are then combined into a per-pixel median of their clear observations, which removes the clouds,
shadows and haze that any single scene still has.
"""
import json
import os

import numpy as np
import rasterio
from rasterio.warp import transform, transform_bounds
from rasterio.windows import from_bounds

from . import gdal_env, request
from .. import geo

STAC = "https://earth-search.aws.element84.com/v1/search"
BANDS = ["red", "green", "blue", "nir", "swir16"]
# SCL classes: 0 no data, 1 saturated, 2 dark area, 3 cloud shadow, 4 vegetation, 5 bare, 6 water, 7 unclassified,
# 8 cloud (medium), 9 cloud (high), 10 thin cirrus, 11 snow or ice
CLEAR = np.array([0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1], bool)


def search(bbox, cfg, cache):
    p = os.path.join(cache, "s2_search.json")
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    s2 = cfg["sentinel2"]
    body = {"collections": ["sentinel-2-l2a"], "bbox": list(bbox),
            "datetime": f"{s2['from']}T00:00:00Z/{s2['to']}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lt": s2["maxCloud"]}}, "limit": 100}
    feats, page = [], 0
    while page < 8:
        doc = request("POST", STAC, json=body, timeout=120).json()
        feats += doc.get("features", [])
        nxt = next((l for l in doc.get("links", []) if l.get("rel") == "next"), None)
        if not nxt or not doc.get("features"):
            break
        body = nxt.get("body") or {**body, "next": nxt.get("href")}
        page += 1
    months = s2.get("months")
    if months:
        feats = [f for f in feats if int(f["properties"]["datetime"][5:7]) in months]
    feats.sort(key=lambda f: f["properties"].get("eo:cloud_cover", 100))
    with open(p, "w") as f:
        json.dump(feats, f)
    print(f"  s2: {len(feats)} candidate scenes")
    return feats


def _scale(item, asset):
    """Reflectance = DN * scale + offset.

    Processing baseline 04.00 (January 2022) added 1000 to every L2A value. Earth Search has already removed that
    offset from the pixels of items marked `earthsearch:boa_offset_applied`, but their raster metadata still lists
    offset -0.1, so the flag wins over the metadata."""
    rb = (asset.get("raster:bands") or [{}])[0]
    props = item["properties"]
    if props.get("earthsearch:boa_offset_applied"):
        return float(rb.get("scale", 1e-4)), 0.0
    if "raster:bands" in asset:
        return float(rb.get("scale", 1e-4)), float(rb.get("offset", 0.0))
    baseline = float(props.get("s2:processing_baseline", "0") or 0)
    return 1e-4, (-0.1 if baseline >= 4.0 else 0.0)


def _read(asset, bbox, out_shape=None):
    """Read the part of a COG that covers bbox (lon/lat). Returns data, its affine transform and its CRS."""
    with rasterio.Env(**gdal_env()):
        with rasterio.open(asset["href"]) as ds:
            b = transform_bounds("EPSG:4326", ds.crs, *bbox, densify_pts=21)
            win = from_bounds(*b, ds.transform).round_offsets().round_lengths()
            a = ds.read(1, window=win, boundless=True, fill_value=0, out_shape=out_shape)
            tr = ds.window_transform(win)
            if out_shape is not None:   # resampled read: scale the transform to the output grid
                tr = tr * tr.scale(win.width / out_shape[1], win.height / out_shape[0])
            return a, tr, ds.crs


def _sampler(frame, half, n, crs, tr, area=True):
    """Fractional (col, row) in a scene raster for every pixel of an n x n local grid."""
    xs, ys = geo.area_axes(half, n) if area else geo.point_axes(half, n)
    gx, gy = np.meshgrid(xs, ys)
    lon, lat = frame.to_lonlat(gx, gy)
    ux, uy = transform("EPSG:4326", crs, lon.ravel().tolist(), lat.ravel().tolist())
    inv = ~tr
    col, row = inv * (np.asarray(ux), np.asarray(uy))
    return (np.asarray(col) - 0.5).reshape(gx.shape), (np.asarray(row) - 0.5).reshape(gx.shape)


def composite(frame, half, n, cfg, cache, label, k=None):
    """Median-composite reflectance (red, green, blue, nir, swir16) on an n x n area grid, plus clear-sky counts.

    Results are cached as `<label>.npz`. Returns a dict of float32 arrays and the list of scene ids used."""
    p = os.path.join(cache, f"{label}.npz")
    if os.path.exists(p):
        z = np.load(p, allow_pickle=True)
        return {b: z[b] for b in BANDS + ["clear", "water"]}, list(z["scenes"])
    bbox = frame.bbox(half, 60)
    feats = search(frame.bbox(half, 0), cfg, cache)
    if not feats:
        raise RuntimeError("no Sentinel-2 scenes matched; widen sentinel2.from/to/months or raise maxCloud")
    k = k or int(cfg["sentinel2"]["scenes"])
    # rank the clearest catalog scenes by their cloud fraction inside the box
    ranked = []
    for f in feats[:16]:
        try:
            scl, tr, crs = _read(f["assets"]["scl"], bbox)
        except Exception as ex:
            print(f"  s2: skip {f['id']} ({ex})")
            continue
        c, r = _sampler(frame, half, 64, crs, tr)
        cls = geo.nearest(scl, c, r).astype(int)
        clear = CLEAR[np.clip(cls, 0, 11)].mean()
        ranked.append((clear, f))
        print(f"  s2: {f['id']}  clear {clear:.0%}")
        if sum(1 for q, _ in ranked if q > 0.97) >= k:
            break
    ranked.sort(key=lambda t: -t[0])
    use = [f for q, f in ranked[:k] if q > 0.25] or [ranked[0][1]]
    stack = {b: [] for b in BANDS}
    masks, waters = [], []
    for f in use:
        ref, tr, crs = _read(f["assets"]["red"], bbox)
        c, r = _sampler(frame, half, n, crs, tr)
        for b in BANDS:
            a = f["assets"][b]
            if b in ("red", "green", "blue", "nir"):
                arr = ref if b == "red" else _read(a, bbox)[0]
                cc, rr = c, r
            else:   # 20 m band: same footprint, half the pixels
                arr, tr2, _ = _read(a, bbox)
                cc, rr = _sampler(frame, half, n, crs, tr2)
            sc, off = _scale(f, a)
            v = geo.bilinear(arr.astype(np.float32), cc, rr) * sc + off
            v[geo.nearest(arr, cc, rr) == 0] = np.nan              # no-data
            stack[b].append(v.astype(np.float32))
        scl, tr3, _ = _read(f["assets"]["scl"], bbox)
        cc, rr = _sampler(frame, half, n, crs, tr3)
        cls = np.clip(geo.nearest(scl, cc, rr).astype(int), 0, 11)
        masks.append(CLEAR[cls] & np.isfinite(stack["red"][-1]))
        waters.append(cls == 6)
    m = np.stack(masks)
    out = {}
    for b in BANDS:
        s = np.stack(stack[b])
        clear = np.where(m, s, np.nan)
        with np.errstate(all="ignore"):
            med = np.nanmedian(clear, axis=0)
            fallback = np.nanmedian(s, axis=0)
        out[b] = np.where(np.isfinite(med), med, fallback).astype(np.float32)
    # pixels that no scene covers at all (outside every tile footprint) take their nearest covered neighbor
    hole = ~np.isfinite(np.stack([np.stack(stack[b]) for b in BANDS])).any(axis=(0, 1))
    if hole.any() and not hole.all():
        from scipy.ndimage import distance_transform_edt
        idx = distance_transform_edt(hole, return_indices=True)[1]
        for b in BANDS:
            out[b] = out[b][idx[0], idx[1]]
    out["clear"] = m.sum(0).astype(np.uint8)
    out["water"] = (np.stack(waters) & m).sum(0).astype(np.uint8)       # how many clear looks said "water"
    ids = [f["id"] for f in use]
    np.savez_compressed(p, **out, scenes=np.array(ids))
    print(f"  s2: {label} composite of {len(use)} scenes, {n} x {n} px")
    return out, ids


def scene_dates(ids):
    """'S2B_33TUN_20240814_0_L2A' -> '2024-08-14'."""
    out = []
    for i in ids:
        d = next((p for p in str(i).split("_") if len(p) == 8 and p.isdigit()), None)
        if d:
            out.append(f"{d[:4]}-{d[4:6]}-{d[6:]}")
    return sorted(set(out))
