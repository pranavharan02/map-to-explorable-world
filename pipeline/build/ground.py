"""Ground: land-cover weights for the terrain shader, contact shade, and the satellite macro color.

Three sources stack up. ESA WorldCover gives a class for every 10 m; Sentinel-2's vegetation index (NDVI) grades it
(a lawn and a dry field are both "grassland"); OpenStreetMap areas override both where they exist, because a mapped
park or car park is sharper than any 10 m pixel.

The satellite color is what the ground looks like from far away. Roofs are painted out of it first (normalized
convolution from the surrounding ground), or every building would stand on a smear of its own roof color.
"""
import numpy as np
from scipy.ndimage import binary_dilation, gaussian_filter

from .raster import Canvas, nconv
from .water import indices

# WorldCover class -> (grass, forest floor, bare, farm, paved)
WC = {10: (0.15, 0.85, 0, 0, 0), 20: (0.55, 0.15, 0.3, 0, 0), 30: (0.9, 0, 0.1, 0, 0), 40: (0.1, 0, 0.1, 0.8, 0),
      50: (0.3, 0, 0.1, 0, 0.5), 60: (0.1, 0, 0.9, 0, 0), 70: (0, 0, 1, 0, 0), 80: (0, 0, 1, 0, 0),
      90: (0.85, 0.1, 0.05, 0, 0), 95: (0.3, 0.7, 0, 0, 0), 100: (0.7, 0, 0.3, 0, 0)}
AREA = {"forest": (0.1, 0.9, 0, 0, 0), "park": (0.9, 0.05, 0.05, 0, 0), "scrub": (0.6, 0.2, 0.2, 0, 0), "grass": (1, 0, 0, 0, 0), "farm": (0.15, 0, 0.05, 0.8, 0),
        "bare": (0, 0, 1, 0, 0), "paved": (0, 0, 0, 0, 1), "pier": (0, 0, 0, 0, 1), "pitch": (0.1, 0, 0, 0, 0.9),
        "wetland": (0.8, 0.15, 0.05, 0, 0)}
ORDER = ["urban", "farm", "scrub", "forest", "wetland", "grass", "park", "bare", "pitch", "paved", "pier"]   # later wins


def solve(cfg, data, F, water_area):
    half, C = cfg["half"], int(cfg["coverResolution"])
    s2, wc = data["s2"], data["wc"]
    _, _, ndvi = indices(s2)
    W = np.zeros((C, C, 5), np.float32)
    for k, v in WC.items():
        W[wc == k] = v
    W[wc == 0] = (0.5, 0, 0.5, 0, 0)
    # NDVI grades the class: green pixels lean to grass, dry ones to bare earth
    g = np.clip((ndvi - 0.18) / 0.45, 0, 1)
    shift = (1 - g) * 0.5 * W[..., 0]
    W[..., 0] -= shift
    W[..., 2] += shift
    for kind in ORDER:
        cv = Canvas(half, C)
        for a in F["areas"]:
            if a["cover"] == kind:
                cv.polygon(a["outer"], a["holes"])
        m = gaussian_filter(cv.array().astype(np.float32) / 255, 0.6)
        if kind == "urban":   # residential and industrial landuse: some hard standing between the gardens
            W[..., 4] = np.maximum(W[..., 4], m * 0.25 * (1 - g))
            continue
        W = W * (1 - m[..., None]) + np.array(AREA[kind], np.float32) * m[..., None]
    bl = Canvas(half, C)
    for b in F["buildings"] + F["parts"]:
        bl.polygon(b["outer"])
    bmask = bl.mask()
    shade = np.clip(gaussian_filter(bmask.astype(np.float32), 1.6 * C / (2 * half)) * 1.5, 0, 1)
    W = np.clip(W, 0, 1)
    s = W.sum(-1, keepdims=True)
    W = np.where(s > 1, W / np.maximum(s, 1e-6), W)
    # macro color: reflectance -> display, with roofs (and unmapped bright roofs) in-painted from the ground around them
    rgb = np.dstack([s2["red"], s2["green"], s2["blue"]]).astype(np.float64)
    bright = rgb.mean(-1) > np.percentile(rgb.mean(-1), 97)
    hole = binary_dilation(bmask, iterations=1) | (bright & ~water_resized(water_area, C))
    keep = (~hole).astype(np.float64)
    fill = np.zeros_like(rgb)
    for i in range(3):
        near, den = nconv(rgb[..., i], keep, 3.0)
        wide, den2 = nconv(rgb[..., i], keep, 12.0)      # big roofs: reach further for ground to borrow from
        fill[..., i] = np.where(den > 0.02, near, np.where(den2 > 0.005, wide, rgb[..., i]))
    rgb = np.where(hole[..., None], fill, rgb)
    col = tone(rgb)
    cover = np.dstack([W[..., 0], W[..., 1], W[..., 2]])
    extra = np.dstack([W[..., 4], shade, W[..., 3]])
    return cover, extra, col, bmask


def water_resized(water_area, n):
    from .raster import resize
    return resize(water_area.astype(np.float32), n, order=1) > 0.5


def tone(rgb):
    """Surface reflectance to display sRGB: a fixed exposure and a gentle shoulder, so scenes match between worlds."""
    x = np.clip(np.nan_to_num(rgb), 0, None) * 3.4
    x = x / (1 + 0.25 * x)
    return np.clip(x, 0, 1) ** (1 / 2.2)
