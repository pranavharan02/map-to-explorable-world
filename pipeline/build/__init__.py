"""Build stage: fetched datasets -> world package.

Order matters. Water carves the terrain, roads grade it, and the banks are then re-checked so a graded road can never
let a lake spill. Everything downstream (buildings, trees, the far ring, viewpoints) reads the final terrain.
"""
import datetime
import os
import zlib

import numpy as np

from .. import __version__, config, geo
from ..fetch.sentinel2 import scene_dates
from . import buildings as B, far as FAR, ground, osm, pack, places, roads, terrain, trees, water


def build_world(cfg, data, out_root):
    rng = np.random.default_rng(zlib.crc32(cfg["id"].encode()))   # stable per world, so rebuilds match
    fr = data["frame"]
    half = cfg["half"]
    biome, pal = config.biome(cfg), config.palette(cfg)
    print(f"Build ({biome} vegetation, {pal} buildings)")
    F = osm.parse(data["osm"], fr, half)
    T = terrain.Terrain(cfg, data, F)
    water_area, shore_sd = water.solve_mask(cfg, data, F, T)
    level, water_pts, bodies = water.solve_levels(water_area, T)
    road_sd, road_surf = roads.solve(cfg, F, T)
    roads.grade(cfg, F, T, water_pts)
    water.bank_guard(T, level, water_pts)
    cover, extra, colour, bmask = ground.solve(cfg, data, F, water_area)
    rows, _, _ = B.solve(cfg, data, F, pal)
    M = int(cfg["maskResolution"])
    sd_at = lambda x, y: float(geo.bilinear(shore_sd, *geo.area_px(x, y, half, M)))
    C = int(cfg["coverResolution"])
    b_at = lambda x, y: bool(geo.nearest(bmask, *geo.area_px(x, y, half, C)))
    tr = trees.solve(cfg, data, F, T, shore_sd, road_sd, extra, bmask, biome, rng)
    ring = FAR.solve(cfg, data, T, biome, rng, level, water_pts) if cfg["far"] else None
    open_at = lambda x, y: float(geo.bilinear(cover[..., 1], *geo.area_px(x, y, half, C))) < 0.3   # little forest floor here
    P = places.solve(cfg, F, T, sd_at, b_at, bodies, open_at)

    # ---------------------------------------------------------------- pack
    lo, hi = float(T.H.min()) - 1.0, float(T.H.max()) + 1.0
    if water_pts.any():
        lo = min(lo, float(level.min()) - 1.0)
        hi = max(hi, float(level.max()) + 1.0)
    scale = max(0.005, (hi - lo) / 65000)
    images = {
        "height.webp": (pack.split16(pack.u16(T.H, lo, scale)), True, None),
        "water.webp": (pack.split16(pack.u16(level, lo, scale), water_pts.astype(np.uint8) * 255), True, None),
        "mask.webp": (np.dstack([pack.to8(shore_sd, 4, 128), pack.to8(road_sd, 8, 128), pack.to8(road_surf, 255)]), True, None),
        "cover.webp": (pack.to8(cover, 255), True, None),
        "ground.webp": (pack.to8(extra, 255), True, None),
        "color.webp": (pack.to8(colour, 255), False, None),
    }
    blob = pack.Blob()
    # buildings: rings (outer first, then holes) as int16 decimetres
    r_off, b_ring, pts = [0], [0], []
    for r in rows:
        for ring_ in r["rings"]:
            pts.append(pack.dm(ring_))
            r_off.append(r_off[-1] + len(ring_))
        b_ring.append(len(r_off) - 1)
    blob.put("rOff", r_off, np.uint32)
    blob.put("bRing", b_ring, np.uint32)
    blob.put("bPts", np.concatenate(pts).ravel() if pts else np.zeros(0), np.int16)
    blob.put("bH", np.array([[r["height"] * 10, r["min_h"] * 10, r["roof_h"] * 10] for r in rows]).reshape(-1).clip(0, 65535) if rows else [], np.uint16)
    blob.put("bA", np.array([[r["kind"], r["roof"], r["levels"], r["seed"], r["pitch"], r["flags"], 0, 0] for r in rows]).reshape(-1) if rows else [], np.uint8)
    blob.put("bC", np.array([np.r_[r["wall"], r["roofc"]] * 255 for r in rows]).round().reshape(-1) if rows else [], np.uint8)
    # bridges: polylines with width, surface and kind (0 road, 1 railway)
    br_off, br_pts, br_a = [0], [], []
    for b in F["bridges"]:
        p = b["pts"]
        if np.abs(p).max() > half + 200:
            p = p[(np.abs(p[:, 0]) < half + 200) & (np.abs(p[:, 1]) < half + 200)]
        if len(p) < 2:
            continue
        br_pts.append(pack.dm(p))
        br_off.append(br_off[-1] + len(p))
        br_a += [b["w"], b["surf"], 1.0 if b["kind"] in FAR_RAIL else 0.0, b["layer"]]
    blob.put("brOff", br_off, np.uint32)
    blob.put("brPts", np.concatenate(br_pts).ravel() if br_pts else np.zeros(0), np.int16)
    blob.put("brA", br_a, np.float32)
    # trees: x, y (dm) and species, seed, size
    blob.put("tXY", pack.dm(tr[:, :2]).ravel(), np.int16)
    blob.put("tA", np.c_[tr[:, 2], tr[:, 3], tr[:, 4] * 255].round().clip(0, 255).ravel(), np.uint8)
    meta_far = None
    if ring is not None:
        flo, fhi = float(ring["H"].min()) - 1, float(ring["H"].max()) + 1
        fscale = max(0.01, (fhi - flo) / 65000)
        images["farh.webp"] = (pack.split16(pack.u16(ring["H"], flo, fscale)), True, None)
        images["far.webp"] = (np.dstack([pack.to8(ring["col"], 255), pack.to8(ring["sd"], 0.5, 128)]), False, "RGBA")
        ft = ring["trees"]
        blob.put("fXY", pack.dm(ft[:, :2]).ravel(), np.int16)
        blob.put("fA", np.c_[ft[:, 2], ft[:, 3], ft[:, 4] * 255].round().clip(0, 255).ravel(), np.uint8)
        meta_far = dict(half=cfg["far"], n=FAR.FAR_N, lo=round(flo, 3), scale=fscale, colorN=FAR.FAR_C, sdScale=2.0,
                        trees=int(len(ft)))
    dates = scene_dates(data["s2_scenes"])
    meta = dict(
        format=1, generator=f"map-to-explorable-world {__version__}", built=datetime.date.today().isoformat(),
        id=cfg["id"], name=cfg["name"], subtitle=cfg.get("subtitle", ""), center=cfg["center"],
        timeZone=cfg.get("timeZone"), tz=cfg["tz"], half=half, biome=biome, palette=pal,
        height=dict(n=T.n, lo=round(lo, 3), scale=scale), mask=dict(n=M, shoreScale=0.25, roadScale=0.125),
        cover=dict(n=C), far=meta_far, water=dict(bodies=bodies[:24]),
        counts=dict(buildings=len(rows), bridges=len(br_off) - 1, trees=int(len(tr)), species=np.bincount(tr[:, 2].astype(int), minlength=6).tolist()),
        **P,
        credits=dict(
            osm="© OpenStreetMap contributors (ODbL)",
            sentinel2=f"Contains modified Copernicus Sentinel-2 data ({', '.join(dates)})",
            elevation=f"Terrain Tiles (Mapzen / Tilezen) on AWS, zoom {data['dem_zoom']}: SRTM, 3DEP, EU-DEM and national models",
            worldcover="ESA WorldCover 10 m 2021 v200 (CC BY 4.0)",
        ),
    )
    out = os.path.join(out_root, cfg["id"])
    pack.write(out, meta, images, blob)
    pack.update_index(out_root)


FAR_RAIL = {"rail", "narrow_gauge", "light_rail", "funicular", "preserved", "monorail"}
