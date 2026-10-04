"""ESA WorldCover 2021 v200: a global 10 m land-cover map (CC BY 4.0), read as windows from its public COGs on AWS.

Classes: 10 tree cover, 20 shrubland, 30 grassland, 40 cropland, 50 built-up, 60 bare or sparse vegetation,
70 snow and ice, 80 permanent water, 90 herbaceous wetland, 95 mangroves, 100 moss and lichen.
"""
import math
import os

import numpy as np
import rasterio
from rasterio.windows import from_bounds

from . import gdal_env
from .. import geo

URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"


def _tile_name(lat, lon):
    la, lo = int(math.floor(lat / 3) * 3), int(math.floor(lon / 3) * 3)
    return f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"


def grid(frame, half, n, cache, label):
    """WorldCover class codes on an n x n area grid (nearest neighbor). Cached as `<label>.npy`. 0 = unknown."""
    p = os.path.join(cache, f"{label}.npy")
    if os.path.exists(p):
        return np.load(p)
    w, s, e, nn = frame.bbox(half, 30)
    xs, ys = geo.area_axes(half, n)
    gx, gy = np.meshgrid(xs, ys)
    lon, lat = frame.to_lonlat(gx, gy)
    out = np.zeros((n, n), np.uint8)
    tiles = {_tile_name(la, lo) for la in (s, nn) for lo in (w, e)}
    with rasterio.Env(**gdal_env()):
        for t in sorted(tiles):
            try:
                with rasterio.open(URL.format(tile=t)) as ds:
                    tb = ds.bounds
                    bw, bs, be, bn = max(w, tb.left), max(s, tb.bottom), min(e, tb.right), min(nn, tb.top)
                    if bw >= be or bs >= bn:
                        continue
                    win = from_bounds(bw, bs, be, bn, ds.transform).round_offsets().round_lengths()
                    a = ds.read(1, window=win, boundless=True, fill_value=0)
                    tr = ds.window_transform(win)
                    col, row = ~tr * (lon, lat)
                    inside = (lon >= bw) & (lon < be) & (lat >= bs) & (lat < bn)
                    v = geo.nearest(a, np.asarray(col) - 0.5, np.asarray(row) - 0.5)
                    out[inside] = v[inside]
            except rasterio.errors.RasterioIOError as ex:
                print(f"  worldcover: tile {t} unavailable ({ex}); continuing without it")
    np.save(p, out)
    vals, cnt = np.unique(out, return_counts=True)
    print(f"  worldcover: {label} " + ", ".join(f"{v}:{c / out.size:.0%}" for v, c in zip(vals, cnt) if c / out.size > 0.01))
    return out
