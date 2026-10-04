"""Buildings: footprints from OpenStreetMap, with height, roof and color filled in where the map is silent.

Explicit tags always win (height, building:levels, min_height, roof:shape, roof:height, building:color,
roof:color, roof:material). Most buildings have none of them, so the rest is estimated:

* kind from the building tag and the shop / amenity / office tags on it;
* storeys from kind, footprint area and how built-up the surroundings are (a 200 m^2 house in a dense old town is
  taller than the same footprint in a village);
* roof shape from a regional palette (pitched roofs dominate in Europe, flat slabs in South Asia and the Gulf);
* roof color from the Sentinel-2 pixels inside the footprint, trusted more the larger the roof is.
"""
import re

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from .. import geo
from .ground import tone

KIND = {"house": 0, "apartments": 1, "commercial": 2, "industrial": 3, "religious": 4, "civic": 5, "utility": 6,
        "tower": 7, "hut": 8}
TAG_KIND = {
    **{k: "house" for k in ("house", "detached", "semidetached_house", "terrace", "residential", "bungalow", "farm",
                            "dormitory", "villa", "static_caravan", "houseboat")},
    **{k: "apartments" for k in ("apartments", "flats", "hotel")},
    **{k: "commercial" for k in ("commercial", "retail", "office", "supermarket", "mall", "shop", "bank", "restaurant")},
    **{k: "industrial" for k in ("industrial", "warehouse", "factory", "manufacture", "hangar", "storage_tank", "silo",
                                 "depot", "data_center", "boathouse")},
    **{k: "religious" for k in ("church", "cathedral", "chapel", "mosque", "temple", "synagogue", "shrine", "religious",
                                "monastery", "basilica")},
    **{k: "civic" for k in ("school", "university", "college", "hospital", "public", "civic", "government", "train_station",
                            "transportation", "fire_station", "museum", "stadium", "sports_hall", "kindergarten",
                            "townhall", "library", "pavilion", "sports_centre")},
    **{k: "utility" for k in ("garage", "garages", "shed", "carport", "barn", "stable", "cowshed", "greenhouse", "service",
                              "toilets", "outbuilding", "farm_auxiliary", "parking", "transformer_tower", "roof", "bunker")},
    **{k: "hut" for k in ("hut", "cabin", "kiosk", "gatehouse", "allotment_house")},
}
ROOF = {"flat": 0, "gabled": 1, "hipped": 2, "pyramidal": 3, "skillion": 4, "dome": 5, "onion": 5, "half-hipped": 2,
        "gambrel": 1, "mansard": 2, "round": 5, "saltbox": 1, "side_hipped": 2, "cone": 3, "crosspitched": 2}
PALETTES = {   # walls, roofs (sRGB), share of untagged houses with pitched roofs, roof pitch in degrees, gable share
    "europe": (["#efe6d2", "#f3eee4", "#f4efe6", "#e8d9b9", "#e9cfa6", "#f1e3c5", "#e6e1d8", "#f2e2b6", "#e8c9a0", "#f0dcc0",
                "#e6c4b4", "#d6dcc6", "#d9dfe2", "#efe0b0", "#e3d3c3", "#e2cc9e"],
               ["#8a3b28", "#7a3424", "#9a4a30", "#5c3a2e", "#4a4a4c", "#3f3d3c", "#6b2f22", "#884a33"], 0.85, 40, 0.6),
    "south-asia": (["#ede1c4", "#f0d48a", "#bcd8b0", "#a5c4da", "#e6b7b0", "#f0c39b", "#ecebe2", "#cddb9b", "#c9c0dc",
                    "#dea06e", "#8fc3b5", "#e9e2d6", "#d9d4c9", "#f2e6cf"],
                   ["#8f8b84", "#7d7a75", "#9a958c", "#6f6c68", "#8a3c25", "#7a2f1d"], 0.15, 28, 0.3),
    "east-asia": (["#e9e6df", "#d8d6d0", "#c9c6bf", "#efece5", "#bfb9ad", "#d6cfc0", "#e3ddd0"],
                  ["#4f5a63", "#3d4750", "#5a6b72", "#6f7b80", "#8c3a2c", "#3a3a3a"], 0.35, 28, 0.5),
    "arid": (["#e3cfa8", "#dcc29a", "#e8d8b8", "#d2b48c", "#efe3c8", "#c9ad85", "#f2ece0"],
             ["#cdb894", "#bfa883", "#d8c7a5", "#b8a68a"], 0.03, 25, 0.5),
    "americas": (["#f2f0ea", "#e6e2d8", "#d9d4c8", "#c8c2b5", "#b8b0a2", "#e8dcc4", "#a9a59c", "#d6c6b0", "#9fa9b0"],
                 ["#4d4d4f", "#5a5552", "#6b625c", "#3e3f42", "#7a6a5a", "#8a8f94"], 0.75, 30, 0.55),
    "tropical": (["#f2ead8", "#e9d6a6", "#bfe0c6", "#a8d3e0", "#f0c2b0", "#f5e7b8", "#e3e3dc", "#d9cbb0"],
                 ["#8a3b26", "#9b5a3a", "#6c7a82", "#7b8a8f", "#5a5a5a", "#93432c"], 0.6, 27, 0.35),
}
COMMERCIAL_WALLS = ["#d9d6cf", "#c7c4bd", "#e6e3dc", "#b9b6b0", "#cfc9bd", "#a9adb0"]
INDUSTRIAL_WALLS = ["#a9aeb2", "#8d969c", "#c2c1ba", "#7f8a7c", "#9aa4ad", "#b5ad9c"]
MATERIAL = {"roof_tiles": "#9a4a2f", "tile": "#9a4a2f", "tiles": "#9a4a2f", "clay": "#9a4a2f", "slate": "#4b4f55",
            "metal": "#7d858b", "tin": "#7d858b", "steel": "#7d858b", "copper": "#6f9a85", "concrete": "#9a9890",
            "asphalt": "#4a4a4a", "tar_paper": "#4a4a4a", "asphalt_shingle": "#4f4c4a", "thatch": "#a08654",
            "glass": "#8fa8b8", "eternit": "#8a8a85", "wood": "#7a5a3c", "grass": "#5f7a3c", "plants": "#5f7a3c",
            "stone": "#8d877c", "gravel": "#9a958a", "bitumen": "#4a4a4a", "plastic": "#8c8c88"}
NAMED = {"white": "#f2f0ea", "black": "#2b2b2b", "grey": "#9a9a96", "gray": "#9a9a96", "lightgrey": "#c8c8c4",
         "lightgray": "#c8c8c4", "darkgrey": "#5e5e5c", "darkgray": "#5e5e5c", "silver": "#c0c0c0", "red": "#a83a2a",
         "darkred": "#7a2a20", "maroon": "#6b2a22", "brown": "#7a5236", "tan": "#cdb48c", "beige": "#e3d6b8",
         "cream": "#efe6cc", "ivory": "#f3efe0", "yellow": "#e9cf6a", "orange": "#d98a4a", "pink": "#e8b3b3",
         "green": "#6f8f5f", "darkgreen": "#3f5f3f", "lightgreen": "#a9c99a", "blue": "#5f7fa8", "lightblue": "#a9c3d9",
         "darkblue": "#33496b", "teal": "#4f8f8a", "olive": "#7a7a4a", "sand": "#d9c69c", "salmon": "#e39a85",
         "terracotta": "#b5603f", "gold": "#c9a24a", "purple": "#7a5a8a"}


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float64) / 255


def colour(v):
    if not v:
        return None
    v = v.strip().lower().replace(" ", "")
    if re.fullmatch(r"#?[0-9a-f]{6}", v):
        return hex_rgb(v)
    if re.fullmatch(r"#?[0-9a-f]{3}", v):
        v = v.lstrip("#")
        return hex_rgb("".join(c * 2 for c in v))
    return hex_rgb(NAMED[v]) if v in NAMED else None


def _num(v):
    if v is None:
        return None
    m = re.match(r"\s*(\d+(?:[.,]\d+)?)", str(v))
    return float(m.group(1).replace(",", ".")) if m else None


def _hash(i, k=0):
    x = (int(i) * 2654435761 + k * 40503) & 0xFFFFFFFF
    x ^= x >> 15
    x = (x * 2246822519) & 0xFFFFFFFF
    x ^= x >> 13
    return (x & 0xFFFFFF) / 0x1000000


def kind_of(t, area):
    b = t.get("building") or t.get("building:part") or "yes"
    k = TAG_KIND.get(b)
    if k:
        return k
    if t.get("amenity") == "place_of_worship":
        return "religious"
    if t.get("shop") or t.get("office") or t.get("amenity") in ("restaurant", "cafe", "bank", "pharmacy", "fuel"):
        return "commercial"
    if t.get("amenity") in ("school", "hospital", "university", "college", "townhall", "library"):
        return "civic"
    if area < 22:
        return "utility"
    if area > 2500:
        return "commercial"
    return "house"


def solve(cfg, data, F, palette_name):
    half, C = cfg["half"], int(cfg["coverResolution"])
    walls, roofs, pitched_share, pitch, gable = PALETTES.get(palette_name, PALETTES["europe"])
    if cfg["buildings"]["pitched"] != "auto":
        pitched_share = float(cfg["buildings"]["pitched"])
    items = [b for b in F["buildings"] if not b.get("has_parts")] + F["parts"]
    items = [b for b in items if np.abs(b["outer"].mean(0)).max() < half - 3]
    # built-up density around each building: share of land covered by footprints within ~60 m
    img = Image.new("I", (C, C), 0)
    d = ImageDraw.Draw(img)
    for k, b in enumerate(items, start=1):
        c, r = geo.area_px(b["outer"][:, 0], b["outer"][:, 1], half, C)
        d.polygon(list(zip(c.tolist(), r.tolist())), fill=k)
    lab = np.asarray(img)
    density = ndimage.gaussian_filter((lab > 0).astype(np.float64), 30 * C / (2 * half))
    rgb = tone(np.dstack([data["s2"]["red"], data["s2"]["green"], data["s2"]["blue"]]))
    idx = np.arange(1, len(items) + 1)
    med = np.stack([ndimage.median(rgb[..., i], lab, idx) for i in range(3)], -1) if items else np.zeros((0, 3))
    rows = []
    for k, b in enumerate(items):
        t, area = b["tags"], b["area"]
        parent = b.get("parent", {}).get("tags", {}) if b.get("parent") else {}
        kind = kind_of(t if t.get("building") else {**parent, **t}, area)
        cx, cy = b["outer"].mean(0)
        pc, pr = geo.area_px(cx, cy, half, C)
        dens = float(geo.bilinear(density, pc, pr))
        h0 = _hash(b["id"])
        levels = _num(t.get("building:levels")) or (_num(parent.get("building:levels")) if not t.get("height") else None)
        lvl_h = 3.6 if kind in ("commercial", "civic") else 3.0
        if levels is None:
            if kind == "house":
                levels = 1 if area < 45 else 2 if area < 160 else 3
                levels += (h0 < 0.35) * (palette_name == "europe") + (dens > 0.35) + (dens > 0.5)
                if palette_name in ("south-asia", "tropical") and area < 120:
                    levels = 1 + (h0 < 0.4) + (dens > 0.45)
            elif kind == "apartments":
                levels = int(np.clip(4 + area / 450 + dens * 4, 3, 14))
            elif kind == "commercial":
                levels = int(np.clip(2 + dens * 4 + (area > 1500), 1, 8))
            elif kind == "civic":
                levels = 2 + (area > 800) + (dens > 0.4)
            elif kind in ("utility", "hut"):
                levels = 1
            elif kind == "industrial":
                levels = 1
            elif kind == "religious":
                levels = 3
            else:
                levels = 2
        levels = float(np.clip(levels, 1, 160))
        shape = t.get("roof:shape") or (parent.get("roof:shape") if not t.get("building:part") else None)
        roof = ROOF.get(shape) if shape else None
        if roof is None:
            share = pitched_share if kind in ("house", "hut", "utility") else pitched_share * 0.4 if kind in ("civic", "religious", "apartments") else pitched_share * 0.2
            if levels > 6 or area > 1600:
                share = 0.0
            roof = (1 if _hash(b["id"], 3) < gable else 2) if _hash(b["id"], 2) < share else 0
            if kind == "religious" and palette_name in ("south-asia", "arid") and _hash(b["id"], 5) < 0.3:
                roof = 5
        roof_h = _num(t.get("roof:height"))
        if roof_h is None and _num(t.get("roof:levels")):
            roof_h = _num(t["roof:levels"]) * 2.6
        height = _num(t.get("height"))
        tagged = height is not None          # OSM height runs from the ground to the top of the roof
        min_h = _num(t.get("min_height"))
        if min_h is None and _num(t.get("building:min_level")):
            min_h = _num(t["building:min_level"]) * lvl_h
        if height is None:
            wall = levels * lvl_h if kind != "industrial" else 6.5 + 4.5 * h0
            if kind == "utility":
                wall = 2.7 + h0
            if kind == "hut":
                wall = 2.6
            if kind == "religious":
                wall = 9 + 6 * h0
            height = wall + (roof_h or 0) + (min_h or 0)
        min_h = min_h or 0.0
        if min_h >= height - 0.5:
            min_h = 0.0
        # colors: tags, then the satellite for big roofs, then the palette
        wc_ = colour(t.get("building:colour") or t.get("colour") or parent.get("building:colour"))
        if wc_ is None:
            pal = walls if kind in ("house", "apartments", "hut", "religious") else COMMERCIAL_WALLS if kind in ("commercial", "civic", "tower") else INDUSTRIAL_WALLS
            wc_ = hex_rgb(pal[int(_hash(b["id"], 7) * len(pal))]) * (0.92 + 0.12 * _hash(b["id"], 8))
            if kind == "religious" and palette_name == "europe":
                wc_ = hex_rgb("#f1ede4")
        rc = colour(t.get("roof:colour") or parent.get("roof:colour"))
        if rc is None and (t.get("roof:material") or parent.get("roof:material")) in MATERIAL:
            rc = hex_rgb(MATERIAL[t.get("roof:material") or parent.get("roof:material")])
        if rc is None:
            base = hex_rgb(roofs[int(_hash(b["id"], 9) * len(roofs))]) if roof else hex_rgb(["#8d8a84", "#7b7974", "#9c988f", "#6f6d69"][int(_hash(b["id"], 9) * 4)])
            conf = float(np.clip((area - 70) / 700, 0, 0.7))
            sat = med[k] if np.all(np.isfinite(med[k])) else base
            rc = base * (1 - conf) + np.clip(sat * 0.92, 0, 1) * conf
        flags = (1 if b.get("part") else 0) | (2 if tagged else 0)
        rows.append(dict(rings=[b["outer"]] + list(b["holes"]), height=height, min_h=min_h, roof_h=roof_h or 0.0,
                         kind=KIND[kind if not (kind == "commercial" and levels >= 12) else "tower"], roof=roof,
                         levels=int(min(levels, 255)), seed=int(_hash(b["id"], 11) * 255), pitch=int(pitch + (h0 - 0.5) * 10),
                         flags=flags, wall=np.clip(wc_, 0, 1), roofc=np.clip(rc, 0, 1), name=t.get("name"), id=b["id"]))
    print(f"  buildings: {len(rows)} ({len(F['parts'])} parts); "
          f"{sum(1 for r in rows if r['roof']) / max(1, len(rows)):.0%} pitched; tallest {max([r['height'] for r in rows] or [0]):.0f} m")
    return rows, lab, items
