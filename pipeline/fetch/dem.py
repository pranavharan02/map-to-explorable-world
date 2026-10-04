"""Elevation from the Terrain Tiles open dataset on AWS (Mapzen / Tilezen, "terrarium" PNG encoding).

The tiles merge SRTM, 3DEP, EU-DEM, ETOPO1 and several national models, so resolution runs from about 30 m
(SRTM) down to a few meters where a national lidar model exists. Each pixel stores
height = R * 256 + G + B / 256 - 32768 meters. No account is needed.
"""
import math
import os
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

from . import ensure_dir, request
from .. import geo

URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def zoom_for(cell_m, lat, zmax=15):
    """The coarsest zoom whose pixels are no larger than `cell_m` meters (capped at the data's useful maximum)."""
    for z in range(8, zmax + 1):
        if geo.tile_metres(z, lat) <= cell_m:
            return z
    return zmax


def _tile(z, x, y, cache):
    p = os.path.join(cache, f"{z}_{x}_{y}.png")
    if not os.path.exists(p):
        r = request("GET", URL.format(z=z, x=x, y=y), timeout=60)
        with open(p + ".part", "wb") as f:
            f.write(r.content)
        os.replace(p + ".part", p)
    a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


class Mosaic:
    """Terrain tiles covering a bounding box at one zoom, sampled bilinearly at arbitrary lon/lat."""

    def __init__(self, bbox, z, cache):
        ensure_dir(cache)
        w, s, e, n = bbox
        fx0, fy1 = geo.lonlat_to_tile(w, s, z)
        fx1, fy0 = geo.lonlat_to_tile(e, n, z)
        self.z = z
        self.tx0, self.ty0 = int(math.floor(fx0)), int(math.floor(fy0))
        tx1, ty1 = int(math.floor(fx1)), int(math.floor(fy1))
        jobs = [(z, x, y, cache) for y in range(self.ty0, ty1 + 1) for x in range(self.tx0, tx1 + 1)]
        if len(jobs) > 900:
            raise RuntimeError(f"{len(jobs)} terrain tiles at zoom {z}: the area is too large for this zoom")
        with ThreadPoolExecutor(8) as ex:
            tiles = list(ex.map(lambda j: _tile(*j), jobs))
        cols = tx1 - self.tx0 + 1
        rows = [np.hstack(tiles[r * cols:(r + 1) * cols]) for r in range(len(tiles) // cols)]
        self.dem = np.vstack(rows)
        print(f"  dem: {len(jobs)} tiles at z{z}, {self.dem.shape[1]} x {self.dem.shape[0]} px, "
              f"{self.dem.min():.0f}..{self.dem.max():.0f} m")

    def sample(self, lon, lat):
        tx, ty = geo.lonlat_to_tile(lon, lat, self.z)
        return geo.bilinear(self.dem, (tx - self.tx0) * 256 - 0.5, (ty - self.ty0) * 256 - 0.5)


def grid(frame, half, n, cache, bbox_pad=200.0, zmax=15):
    """Elevation on an n x n point grid over [-half, half]^2, plus the zoom used."""
    cell = 2 * half / (n - 1)
    z = zoom_for(cell, frame.lat0, zmax)
    m = Mosaic(frame.bbox(half, bbox_pad), z, cache)
    xs, ys = geo.point_axes(half, n)
    gx, gy = np.meshgrid(xs, ys)
    lon, lat = frame.to_lonlat(gx, gy)
    return m.sample(lon, lat), z
