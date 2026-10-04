"""Roads and railways as a signed distance field, plus terrain grading.

Roads are not meshes: the terrain shader paints them from a distance field (meters to the nearest road edge, negative
on the road). Bilinear filtering of a distance field keeps edges sharp at any magnification, which a rasterized mask
cannot do, and a road drapes over any terrain without z-fighting. The field is rasterized at twice the output
resolution and averaged down, which puts edges within about a quarter of a pixel.

Grading levels the terrain across each road towards a smoothed centerline height, so a road on a slope sits in a cut
instead of tilting sideways.
"""
import numpy as np
from scipy.ndimage import distance_transform_edt, gaussian_filter
from PIL import Image, ImageDraw

from .. import geo
from .raster import Canvas, downsample_mean, signed_distance

VEHICLE = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
           "service", "road", "busway", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
           "pedestrian", "track"}


def solve(cfg, F, T):
    half, M = cfg["half"], int(cfg["maskResolution"])
    ways = sorted(F["roads"] + F["rails"], key=lambda r: r["surf"])
    hi = Canvas(half, M * 2)
    for r in ways:
        hi.line(r["pts"], r["w"])
    px = 2 * half / M
    sd = downsample_mean(signed_distance(hi.mask(), px / 2), 2)
    # surface class of the nearest road, so markings and colors stay consistent up to each edge
    cls = Canvas(half, M)
    for r in ways:
        cls.line(r["pts"], max(r["w"], px * 1.5), value=int(round(1 + 254 * r["surf"])))
    a = cls.array()
    if (a > 0).any():
        idx = distance_transform_edt(a == 0, return_indices=True)[1]
        surf = a[idx[0], idx[1]].astype(np.float32)
        surf = (surf - 1) / 254
    else:
        surf = np.zeros((M, M), np.float32)
    print(f"  roads: {len(F['roads'])} roads, {len(F['rails'])} railways, {len(F['bridges'])} bridges; "
          f"{(sd < 0).mean():.1%} of the core is road")
    return sd.astype(np.float32), np.clip(surf, 0, 1).astype(np.float32)


def grade(cfg, F, T, water_pts):
    """Blend the terrain across vehicle roads towards a smoothed centerline height."""
    if not cfg["terrain"]["gradeRoads"]:
        return
    half, n, cell = T.half, T.n, T.cell
    roads = [r for r in F["roads"] if r["kind"] in VEHICLE]
    if not roads:
        return
    na = n - 1                                   # an area grid whose pixel centers sit between the height samples
    img = Image.new("I", (na, na), 0)
    d = ImageDraw.Draw(img)
    halfw = np.zeros(len(roads) + 1)
    for k, r in enumerate(roads, start=1):
        c, rr = geo.area_px(r["pts"][:, 0], r["pts"][:, 1], half, na)
        d.line(list(zip(c.tolist(), rr.tolist())), fill=k, width=1)
        halfw[k] = r["w"] / 2
    lab = np.asarray(img)
    if not (lab > 0).any():
        return
    Hs = gaussian_filter(T.H, 8.0 / cell)        # the road follows the land, without its small bumps
    gx, gy = np.meshgrid(T.xs, T.ys)
    c, rr = geo.area_px(gx, gy, half, na)
    ci, ri = np.clip(np.rint(c).astype(int), 0, na - 1), np.clip(np.rint(rr).astype(int), 0, na - 1)
    dist, idx = distance_transform_edt(lab == 0, return_indices=True)
    near_r, near_c = idx[0][ri, ci], idx[1][ri, ci]
    dist = dist[ri, ci] * (2 * half / na)
    hw = halfw[lab[near_r, near_c]]
    # height of the nearest centerline pixel, read from the smoothed terrain at that pixel's center
    cx, cy = -half + (near_c + 0.5) * (2 * half / na), half - (near_r + 0.5) * (2 * half / na)
    pc, pr = geo.point_px(cx, cy, half, n)
    level = geo.bilinear(Hs, pc, pr)
    t = np.clip((dist - hw) / 3.5, 0, 1)
    w = (1 - t * t * (3 - 2 * t)) * (hw > 0) * ~water_pts
    T.H = T.H * (1 - w) + level * w
    print(f"  roads: graded {(w > 0.5).mean():.1%} of the terrain")
