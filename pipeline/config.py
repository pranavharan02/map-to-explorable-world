"""World configuration: a small JSON file per place, filled out with defaults.

Only `name` and `center` are required. Everything else has a default that suits a village or a town center:

    {
      "name": "Hallstatt",
      "center": {"lat": 47.5622, "lon": 13.6493},
      "half": 1000,
      "far": 8000,
      "tz": 1
    }
"""
import copy
import datetime
import json
import os
import re

DEFAULTS = {
    "subtitle": "",
    "half": 1000,            # core half-size in meters: the walkable square is 2 * half on a side
    "far": 6000,             # context-ring half-size in meters (0 turns the ring off)
    "timeZone": None,        # IANA zone such as "Europe/Vienna": the browser then follows daylight-saving time
    "tz": None,              # fallback hours from UTC when timeZone is unset; None estimates it from the longitude
    "spawn": None,           # {"lat", "lon"} to start at; None picks a street near the center
    "sentinel2": {
        "from": None,        # ISO dates; None means the last three years
        "to": None,
        "months": None,      # e.g. [5, 6, 7, 8, 9] for leaf-on, snow-free scenes
        "maxCloud": 40,      # tile-level cloud cover filter for the catalog search, in percent
        "scenes": 4,         # how many of the clearest scenes go into the median composite
    },
    "terrain": {
        "resolution": 1025,  # heightfield samples per side (power of two plus one)
        "debump": "auto",    # remove building and canopy bumps from surface-model elevation: auto, true or false
        "smooth": 3.0,       # gaussian smoothing of the elevation, in meters
        "gradeRoads": True,  # level the terrain across roads so they sit in the slope
    },
    "buildings": {
        "palette": "auto",   # wall and roof colors: auto, europe, south-asia, east-asia, arid, americas, tropical
        "pitched": "auto",   # share of untagged roofs that are pitched, 0..1, or auto from the palette
    },
    "vegetation": {
        "biome": "auto",     # tropical, subtropical, arid, temperate, boreal, or auto from latitude
        "density": 1.0,      # multiplies tree placement probability
        "maxTrees": 160000,
        "farTrees": True,    # impostor-only trees in the context ring
    },
    "water": {
        "threshold": 0.03,   # water index above which a Sentinel-2 pixel counts as water
    },
    "maskResolution": 2048,  # shore and road distance fields, pixels per side
    "coverResolution": 1024, # land cover, contact shade and satellite color, pixels per side
}

MAX_HALF = 3000.0            # building and tree coordinates are stored as int16 decimetres


def _merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "world"


def load(path):
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    if "name" not in raw or "center" not in raw:
        raise ValueError(f"{path}: a world needs at least `name` and `center`")
    cfg = _merge(DEFAULTS, raw)
    cfg["id"] = raw.get("id") or os.path.splitext(os.path.basename(path))[0]
    c = cfg["center"]
    if isinstance(c, (list, tuple)):
        cfg["center"] = {"lat": float(c[0]), "lon": float(c[1])}
    cfg["half"] = float(cfg["half"])
    if not 200 <= cfg["half"] <= MAX_HALF:
        raise ValueError(f"half must be between 200 and {MAX_HALF:.0f} metres")
    cfg["far"] = float(cfg["far"] or 0)
    if cfg["far"] and cfg["far"] < cfg["half"] * 1.5:
        cfg["far"] = cfg["half"] * 1.5
    if cfg["tz"] is None:
        cfg["tz"] = round(cfg["center"]["lon"] / 15 * 2) / 2
    s2 = cfg["sentinel2"]
    today = datetime.date.today()
    s2["to"] = s2["to"] or today.isoformat()
    s2["from"] = s2["from"] or today.replace(year=today.year - 3).isoformat()
    n = int(cfg["terrain"]["resolution"])
    if n < 257 or n > 2049 or (n - 1) & (n - 2):
        raise ValueError("terrain.resolution must be a power of two plus one between 257 and 2049, for example 1025")
    return cfg


def biome(cfg):
    b = cfg["vegetation"]["biome"]
    if b != "auto":
        return b
    lat = abs(cfg["center"]["lat"])
    if lat < 23.5:
        return "tropical"
    if lat < 34:
        return "subtropical"
    if lat < 56:
        return "temperate"
    return "boreal"


def palette(cfg):
    p = cfg["buildings"]["palette"]
    if p != "auto":
        return p
    lat, lon = cfg["center"]["lat"], cfg["center"]["lon"]
    if 34 <= lat <= 72 and -25 <= lon <= 45:
        return "europe"
    if 5 <= lat <= 37 and 60 <= lon <= 98:
        return "south-asia"
    if 18 <= lat <= 54 and 98 < lon <= 150:
        return "east-asia"
    if 12 <= lat < 40 and -20 <= lon < 60:
        return "arid"
    if abs(lat) < 23.5:
        return "tropical"
    return "americas"
