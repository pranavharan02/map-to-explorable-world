"""Elevation -> a walkable heightfield.

Satellite-derived elevation (SRTM in most of the world) is a surface model: buildings and tree crowns sit on it as
bumps, and its 30 m staircase shows as facets when you stand on it. A gray opening (an erosion followed by a dilation)
removes positive features narrower than its window while keeping hills, and a light gaussian blur smooths the facets.
In `auto` mode the opening only applies where buildings or tree cover stand, so bare ridges and peaks keep their crest.
"""
import numpy as np
from scipy.ndimage import gaussian_filter, grey_opening

from .. import geo
from .raster import Canvas


class Terrain:
    def __init__(self, cfg, data, F):
        self.half = half = cfg["half"]
        self.n = n = int(cfg["terrain"]["resolution"])
        self.cell = cell = 2 * half / (n - 1)
        H = np.asarray(data["dem"], dtype=np.float64)
        self.xs, self.ys = geo.point_axes(half, n)
        mode = cfg["terrain"]["debump"]
        if mode == "auto":
            score = self.surface_model_score(H, F)
            rough = self.built_roughness(H, data["wc"])
            mode = (score is not None and score > 1.2) or (rough is not None and rough > 1.4)
            print(f"  terrain: footprints {score if score is not None else float('nan'):+.1f} m above their surroundings, "
                  f"built-up roughness {rough if rough is not None else float('nan'):.1f} m "
                  f"-> {'surface model, removing bumps' if mode else 'bare-earth model, keeping it'}")
        if mode:
            win = max(3, int(round(36 / cell)) | 1)
            bump = H - grey_opening(H, size=(win, win))
            # only where objects stand, and never on steep ground, where an opening would shave real ridges
            gy, gx = np.gradient(gaussian_filter(H, 8 / cell), cell)
            steep = np.degrees(np.arctan(np.hypot(gx, gy)))
            bump = np.minimum(bump, 30) * self.cover_weight(data["wc"], F) * np.clip(1 - (steep - 8) / 14, 0, 1)
            H = H - bump
            print(f"  terrain: removed bumps up to {bump.max():.1f} m (window {win * cell:.0f} m)")
        s = float(cfg["terrain"]["smooth"]) / cell
        if s > 0.2:
            H = gaussian_filter(H, s)
        self.H = H

    def surface_model_score(self, H, F):
        """How far building footprints stand above the ground just around them, in meters.

        In a surface model (SRTM) roofs lift the elevation, so footprints read several meters high; in a bare-earth
        model (most national lidar models) they read about zero. None when there are too few buildings to tell."""
        blds = [b for b in F["buildings"] if 60 < b["area"] < 5000][:800]
        if len(blds) < 15:
            return None
        # residuals against a 25 m blur, so a building on a slope does not count as a bump
        resid = H - gaussian_filter(H, 25 / self.cell)
        ang = np.linspace(0, 2 * np.pi, 12, endpoint=False)
        diff = []
        for b in blds:
            c = b["outer"].mean(0)
            r = max(float(np.hypot(*(b["outer"] - c).T).max()), 4.0) + 12
            here = geo.bilinear(resid, *geo.point_px(c[0], c[1], self.half, self.n))
            ring = geo.bilinear(resid, *geo.point_px(c[0] + np.cos(ang) * r, c[1] + np.sin(ang) * r, self.half, self.n))
            diff.append(float(here) - float(np.median(ring)))
        return float(np.median(diff))

    def built_roughness(self, H, wc):
        """Median absolute residual (meters) of the elevation over built-up land, against a 25 m blur.

        A dense city defeats the footprint test (every footprint's neighbor is another building), but a surface model
        of a city is rough at the scale of buildings, while a bare-earth model is smooth there."""
        built = self.from_area((wc == 50).astype(np.float64)) > 0.5
        if built.sum() < 2000:
            return None
        resid = H - gaussian_filter(H, 25 / self.cell)
        return float(np.median(np.abs(resid[built])))

    def cover_weight(self, wc, F):
        """0..1 on the point grid: where buildings or canopy can bias a surface model upwards."""
        c = Canvas(self.half, wc.shape[0])
        for b in F["buildings"] + F["parts"]:
            c.polygon(b["outer"])
        m = c.mask() | np.isin(wc, (10, 50, 95))
        w = gaussian_filter(m.astype(np.float64), 4)
        return np.clip(self.from_area(w) * 1.3, 0, 1)

    def from_area(self, a):
        """Sample an area-grid array (any resolution) at this heightfield's points."""
        gx, gy = np.meshgrid(self.xs, self.ys)
        c, r = geo.area_px(gx, gy, self.half, a.shape[0])
        return geo.bilinear(a, c, r)

    def sample(self, x, y):
        c, r = geo.point_px(x, y, self.half, self.n)
        return geo.bilinear(self.H, c, r)

    def slope_deg(self):
        gy, gx = np.gradient(self.H, self.cell)
        return np.degrees(np.arctan(np.hypot(gx, gy)))
