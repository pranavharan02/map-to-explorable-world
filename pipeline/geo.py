"""Coordinate frames, grids and tile maths shared by every pipeline stage.

A world lives in a local tangent frame measured in meters from its center: x points east and y points north. Over the
few kilometres a browser world covers, this equirectangular frame is accurate to well under a meter, which is far below
the resolution of every input dataset. The web app maps (x, y) to three.js (x, -z).

Two kinds of grid are used:

* area grids (images): n x n pixels covering [-half, half]^2, pixel centers at -half + (i + 0.5) * 2 half / n,
  row 0 at the north edge. Masks, land cover and satellite color use these.
* point grids (heightfields): n x n samples with the first and last sample exactly on the edges. The terrain mesh
  uses these, so its corner vertices land on the world boundary.
"""
import math

import numpy as np


class Frame:
    """Local metric frame centered on (lat0, lon0)."""

    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = float(lat0), float(lon0)
        p = math.radians(self.lat0)
        # meters per degree on the WGS84 ellipsoid (standard series expansions)
        self.ky = 111132.954 - 559.822 * math.cos(2 * p) + 1.175 * math.cos(4 * p)
        self.kx = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p) + 0.118 * math.cos(5 * p)

    def to_xy(self, lon, lat):
        return (np.asarray(lon) - self.lon0) * self.kx, (np.asarray(lat) - self.lat0) * self.ky

    def to_lonlat(self, x, y):
        return self.lon0 + np.asarray(x) / self.kx, self.lat0 + np.asarray(y) / self.ky

    def bbox(self, half, pad=0.0):
        """(west, south, east, north) in degrees for the square [-half, half]^2 plus `pad` meters."""
        r = half + pad
        return (self.lon0 - r / self.kx, self.lat0 - r / self.ky, self.lon0 + r / self.kx, self.lat0 + r / self.ky)


def area_axes(half, n):
    """Pixel-center coordinates of an n x n area grid: xs west -> east, ys north -> south."""
    c = (np.arange(n) + 0.5) * (2 * half / n)
    return -half + c, half - c


def point_axes(half, n):
    """Sample coordinates of an n x n point grid: xs west -> east, ys north -> south, edges included."""
    c = np.linspace(-half, half, n)
    return c, c[::-1].copy()


def area_px(x, y, half, n):
    """Fractional pixel coordinates (column, row) of local points in an area grid; pixel centers are integers."""
    return (np.asarray(x) + half) / (2 * half) * n - 0.5, (half - np.asarray(y)) / (2 * half) * n - 0.5


def point_px(x, y, half, n):
    """Fractional sample coordinates (column, row) of local points in a point grid."""
    return (np.asarray(x) + half) / (2 * half) * (n - 1), (half - np.asarray(y)) / (2 * half) * (n - 1)


def bilinear(a, col, row):
    """Bilinear sample of a 2D array at fractional (col, row), clamped to the edges."""
    h, w = a.shape
    col = np.clip(np.asarray(col, dtype=np.float64), 0, w - 1.000001)
    row = np.clip(np.asarray(row, dtype=np.float64), 0, h - 1.000001)
    i, j = col.astype(np.int64), row.astype(np.int64)
    u, v = col - i, row - j
    return ((a[j, i] * (1 - u) + a[j, i + 1] * u) * (1 - v) + (a[j + 1, i] * (1 - u) + a[j + 1, i + 1] * u) * v)


def nearest(a, col, row):
    h, w = a.shape
    i = np.clip(np.rint(col).astype(np.int64), 0, w - 1)
    j = np.clip(np.rint(row).astype(np.int64), 0, h - 1)
    return a[j, i]


# ---------------------------------------------------------------- Web Mercator tiles

def lonlat_to_tile(lon, lat, z):
    """Fractional XYZ tile coordinates (x, y) of a point at zoom z."""
    n = 2 ** z
    lat = np.clip(np.asarray(lat, dtype=np.float64), -85.0511, 85.0511)
    x = (np.asarray(lon, dtype=np.float64) + 180.0) / 360.0 * n
    y = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def tile_metres(z, lat):
    """Ground size of one 256-pixel tile pixel, in meters, at latitude `lat`."""
    return 40075016.686 * math.cos(math.radians(lat)) / (2 ** z) / 256


def polygon_area(ring):
    """Unsigned area of a ring of (x, y) points (shoelace formula)."""
    r = np.asarray(ring, dtype=np.float64)
    x, y = r[:, 0], r[:, 1]
    return abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2


def signed_area(ring):
    r = np.asarray(ring, dtype=np.float64)
    x, y = r[:, 0], r[:, 1]
    return float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2


def point_in_ring(px, py, ring):
    """Even-odd point-in-polygon test for one point against a ring of (x, y) points."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside
