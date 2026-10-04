"""Rasterizing vector features onto the world's grids, and the distance-field helpers built on top."""
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, gaussian_filter, zoom

from .. import geo


class Canvas:
    """An 8-bit drawing surface over [-half, half]^2 with n pixels per side (row 0 = north)."""

    def __init__(self, half, n, fill=0):
        self.half, self.n = half, n
        self.img = Image.new("L", (n, n), fill)
        self.d = ImageDraw.Draw(self.img)

    def px(self, pts):
        # PIL puts pixel centers on integer coordinates, which matches geo.area_px
        c, r = geo.area_px(pts[:, 0], pts[:, 1], self.half, self.n)
        return list(zip(c.tolist(), r.tolist()))

    def polygon(self, outer, holes=(), value=255):
        if len(outer) >= 3:
            self.d.polygon(self.px(outer), fill=value)
        for h in holes:
            if len(h) >= 3:
                self.d.polygon(self.px(h), fill=0)

    def line(self, pts, width_m, value=255):
        w = max(1, int(round(width_m / (2 * self.half / self.n))))
        p = self.px(pts)
        if len(p) >= 2:
            self.d.line(p, fill=value, width=w, joint="curve")
            if w > 2:   # round caps, so lines that meet at their ends join cleanly
                r = w / 2
                for (cx, cy) in (p[0], p[-1]):
                    self.d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=value)

    def array(self):
        return np.asarray(self.img)

    def mask(self):
        return np.asarray(self.img) > 127


def signed_distance(inside, px_m):
    """Signed distance in meters to the edge of a boolean mask: negative inside, positive outside."""
    if inside.all():
        return np.full(inside.shape, -1e4, np.float32)
    if not inside.any():
        return np.full(inside.shape, 1e4, np.float32)
    out = distance_transform_edt(~inside) - 0.5
    ins = distance_transform_edt(inside) - 0.5
    return (np.where(inside, -ins, out) * px_m).astype(np.float32)


def nconv(values, weights, sigma_px):
    """Normalized convolution: a weighted gaussian blur that fills gaps from the weighted neighborhood."""
    num = gaussian_filter(values * weights, sigma_px)
    den = gaussian_filter(weights.astype(np.float64), sigma_px)
    return num / np.maximum(den, 1e-9), den


def resize(a, n, order=1):
    """Resample a square array to n x n (area-grid aligned)."""
    if a.shape[0] == n:
        return a
    f = n / a.shape[0]
    out = zoom(a.astype(np.float32), f, order=order, mode="nearest", grid_mode=True)
    return out[:n, :n]


def downsample_mean(a, k):
    h, w = a.shape
    return a[: h // k * k, : w // k * k].reshape(h // k, k, w // k, k).mean(axis=(1, 3))
