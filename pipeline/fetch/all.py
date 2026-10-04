"""Fetch every dataset a world needs into its cache folder."""
import json
import os

from . import dem, ensure_dir, osm, sentinel2, worldcover
from .. import geo


def fetch_all(cfg, cache_root, refresh=False):
    cache = ensure_dir(os.path.join(cache_root, cfg["id"]))
    tiles = ensure_dir(os.path.join(cache_root, "_terrain_tiles"))
    fr = geo.Frame(cfg["center"]["lat"], cfg["center"]["lon"])
    half, far = cfg["half"], cfg["far"]
    nC, nH = int(cfg["coverResolution"]), int(cfg["terrain"]["resolution"])
    # the cache belongs to one area and one set of grids: any change to them invalidates it
    key = json.dumps({k: cfg[k] for k in ("center", "half", "far", "coverResolution", "sentinel2")} | {"terrain": cfg["terrain"]["resolution"]}, sort_keys=True)
    kp = os.path.join(cache, "key.json")
    old = open(kp, encoding="utf-8").read() if os.path.exists(kp) else None
    if refresh or (old is not None and old != key):
        if os.listdir(cache):
            print("  cache: the area or grids changed, fetching again" if not refresh else "  cache: refreshing")
        for f in os.listdir(cache):
            os.remove(os.path.join(cache, f))
    with open(kp, "w", encoding="utf-8") as f:
        f.write(key)
    print("OpenStreetMap")
    doc = osm.fetch(fr.bbox(half, 40), os.path.join(cache, "osm.json"), refresh)
    print("Elevation")
    dem_core, z_core = dem.grid(fr, half, nH, tiles)
    dem_far = z_far = None
    if far:
        dem_far, z_far = dem.grid(fr, far, 513, tiles, bbox_pad=400, zmax=13)
    print("Sentinel-2")
    s2_core, ids_core = sentinel2.composite(fr, half, nC, cfg, cache, "s2_core")
    s2_far, ids_far = (sentinel2.composite(fr, far, 1024, cfg, cache, "s2_far") if far else (None, []))
    print("ESA WorldCover")
    wc_core = worldcover.grid(fr, half, nC, cache, "wc_core")
    wc_far = worldcover.grid(fr, far, 1024, cache, "wc_far") if far else None
    return dict(frame=fr, osm=doc, dem=dem_core, dem_zoom=z_core, dem_far=dem_far, dem_far_zoom=z_far,
                s2=s2_core, s2_far=s2_far, s2_scenes=sorted(set(ids_core) | set(ids_far)), wc=wc_core, wc_far=wc_far)
