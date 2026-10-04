"""Turn an Overpass `out geom` document into plain feature lists in the local metric frame.

Everything downstream works on these lists: buildings and building parts (with holes), roads, railways, waterways,
water polygons, land-cover areas, single trees and tree rows, and named places.
"""
import re

import numpy as np

from .. import geo

ROAD_WIDTH = {   # meters, for ways without a width or lanes tag
    "motorway": 11, "trunk": 9, "primary": 8, "secondary": 7, "tertiary": 6, "unclassified": 4.8, "residential": 5,
    "living_street": 4, "service": 3.6, "road": 4.5, "motorway_link": 6, "trunk_link": 6, "primary_link": 6,
    "secondary_link": 5.5, "tertiary_link": 5, "pedestrian": 4, "track": 2.8, "busway": 6,
    "footway": 1.8, "path": 1.5, "cycleway": 2, "bridleway": 2, "steps": 2, "corridor": 2,
}
# road surface class written to the mask (0..1): asphalt for vehicle roads, lighter for minor streets, gravel for
# tracks and paths; explicit surface tags win
ROAD_SURF = {"motorway": 1.0, "trunk": 1.0, "primary": 1.0, "secondary": 1.0, "tertiary": 0.95, "unclassified": 0.85,
             "residential": 0.85, "living_street": 0.75, "service": 0.8, "road": 0.85, "pedestrian": 0.55, "busway": 1.0,
             "track": 0.2, "footway": 0.5, "path": 0.2, "cycleway": 0.6, "bridleway": 0.15, "steps": 0.5, "corridor": 0.5}
for k in [k for k in ROAD_WIDTH if k.endswith("_link")]:
    ROAD_SURF[k] = 1.0
PAVED = {"asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "chipseal", "metal", "wood"}
SETTS = {"sett", "cobblestone", "unhewn_cobblestone", "paving_stones", "bricks", "stone"}
UNPAVED = {"unpaved", "gravel", "fine_gravel", "compacted", "dirt", "earth", "ground", "grass", "mud", "sand", "pebblestone",
           "rock", "woodchips", "grass_paver"}
RAIL = {"rail": 3.0, "narrow_gauge": 2.4, "light_rail": 2.8, "funicular": 2.4, "preserved": 2.6, "monorail": 1.5}
WATERWAY = {"river": 16, "canal": 9, "stream": 2.6, "tidal_channel": 6, "ditch": 1.3, "drain": 1.3, "canal_lock": 8}

COVER = [   # (tag, values, cover class)
    ("landuse", {"forest"}, "forest"), ("natural", {"wood"}, "forest"),
    ("natural", {"scrub", "heath"}, "scrub"), ("landuse", {"meadow", "grass", "village_green", "recreation_ground",
     "greenfield", "cemetery", "flowerbed"}, "grass"),
    ("leisure", {"park", "garden"}, "park"), ("leisure", {"golf_course", "common", "dog_park"}, "grass"),
    ("natural", {"grassland", "fell"}, "grass"), ("amenity", {"grave_yard"}, "grass"),
    ("landuse", {"farmland", "orchard", "vineyard", "allotments", "plant_nursery", "greenhouse_horticulture"}, "farm"),
    ("natural", {"sand", "beach", "bare_rock", "scree", "shingle", "rock", "glacier", "dune"}, "bare"),
    ("landuse", {"quarry", "landfill", "brownfield", "construction", "railway"}, "bare"),
    ("amenity", {"parking", "marketplace"}, "paved"), ("place", {"square"}, "paved"), ("railway", {"platform"}, "paved"),
    ("man_made", {"pier", "breakwater", "groyne"}, "pier"), ("leisure", {"pitch", "playground", "track", "sports_centre"}, "pitch"),
    ("natural", {"wetland"}, "wetland"), ("landuse", {"residential", "commercial", "retail", "industrial", "farmyard"}, "urban"),
]
WATER_POLY = [("natural", {"water"}), ("waterway", {"riverbank", "dock", "boatyard"}), ("landuse", {"reservoir", "basin"}),
              ("leisure", {"swimming_pool"})]


def _f(v, default=None):
    """First number in an OSM value: '12 m' -> 12.0, '3;4' -> 3.0. Feet are converted."""
    if v is None:
        return default
    m = re.match(r"\s*(-?\d+(?:[.,]\d+)?)\s*(ft|')?", str(v))
    if not m:
        return default
    x = float(m.group(1).replace(",", "."))
    return x * 0.3048 if m.group(2) else x


def _ring(fr, geom):
    lon = np.array([p["lon"] for p in geom]); lat = np.array([p["lat"] for p in geom])
    x, y = fr.to_xy(lon, lat)
    return np.c_[x, y]


def _close(r):
    return r[:-1] if len(r) > 3 and np.allclose(r[0], r[-1]) else r


def assemble(segments):
    """Join open way segments (arrays of points) into closed rings by matching end points."""
    segs = [s for s in segments if len(s) >= 2]
    rings = []
    key = lambda p: (round(p[0], 2), round(p[1], 2))
    while segs:
        cur = segs.pop(0)
        guard = 0
        while key(cur[0]) != key(cur[-1]) and segs and guard < 10000:
            guard += 1
            for k, s in enumerate(segs):
                if key(s[0]) == key(cur[-1]):
                    cur = np.vstack([cur, s[1:]]); segs.pop(k); break
                if key(s[-1]) == key(cur[-1]):
                    cur = np.vstack([cur, s[::-1][1:]]); segs.pop(k); break
            else:
                break
        if len(cur) >= 4 and key(cur[0]) == key(cur[-1]):
            rings.append(_close(cur))
    return rings


def _polygons(fr, e):
    """[(outer, [holes])] for a closed way or a multipolygon relation."""
    if e["type"] == "way":
        if "geometry" not in e or len(e["geometry"]) < 4:
            return []
        r = _ring(fr, e["geometry"])
        if not np.allclose(r[0], r[-1]):
            return []
        return [(_close(r), [])]
    outers = assemble([_ring(fr, m["geometry"]) for m in e.get("members", []) if m.get("role") == "outer" and m.get("geometry")])
    inners = assemble([_ring(fr, m["geometry"]) for m in e.get("members", []) if m.get("role") == "inner" and m.get("geometry")])
    out = [(o, []) for o in outers]
    for h in inners:   # each hole goes to the outer ring that contains its first point
        for o, hs in out:
            if geo.point_in_ring(h[0][0], h[0][1], o):
                hs.append(h); break
    return out


def _match(tags, rules):
    for k, vals, *rest in rules:
        if tags.get(k) in vals:
            return rest[0] if rest else True
    return None


def parse(doc, fr, half):
    els = doc.get("elements", [])
    lim = half + 30
    # bounding-box overlap with the core: a forest polygon can cover the whole world without a vertex inside it
    inside = lambda r: r[:, 0].min() < lim and r[:, 0].max() > -lim and r[:, 1].min() < lim and r[:, 1].max() > -lim
    F = dict(buildings=[], parts=[], roads=[], rails=[], waterways=[], water=[], islands=[], areas=[], trees=[],
             tree_rows=[], pois=[], bridges=[])
    seen_parts = set()
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "node":
            x, y = fr.to_xy(e["lon"], e["lat"])
            x, y = float(x), float(y)
            if abs(x) > half or abs(y) > half:
                if t.get("natural") == "peak" and t.get("name"):   # named peaks just outside still make good labels
                    F["pois"].append(dict(kind="peak", name=t["name"], x=x, y=y, ele=_f(t.get("ele"))))
                continue
            if t.get("natural") == "tree":
                F["trees"].append(dict(x=x, y=y, leaf=t.get("leaf_type"), h=_f(t.get("height"))))
            elif t.get("name"):
                kind = (t.get("place") or ("peak" if t.get("natural") in ("peak", "volcano") else None) or
                        ("worship" if t.get("amenity") == "place_of_worship" else None) or t.get("tourism") or
                        ("historic" if t.get("historic") else None) or t.get("man_made") or t.get("natural"))
                F["pois"].append(dict(kind=kind, name=t["name"], x=x, y=y, ele=_f(t.get("ele"))))
            continue

        if e["type"] == "way" and "geometry" in e:
            line = _ring(fr, e["geometry"])
            if len(line) < 2 or not inside(line):
                continue
            closed = len(line) >= 4 and np.allclose(line[0], line[-1])
            hw = t.get("highway")
            if hw in ROAD_WIDTH and t.get("area") != "yes":
                if t.get("tunnel") in ("yes", "building_passage", "culvert") or t.get("covered") == "yes" or t.get("indoor") == "yes":
                    continue
                w = _f(t.get("width"))
                if w is None and _f(t.get("lanes")):
                    w = min(_f(t["lanes"]) * 3.1 + 0.6, 24)
                w = float(np.clip(w or ROAD_WIDTH[hw], 1.0, 30))
                surf = ROAD_SURF[hw]
                s = t.get("surface")
                if s in PAVED: surf = max(surf, 0.85)
                elif s in SETTS: surf = 0.65
                elif s in UNPAVED: surf = 0.2
                rec = dict(kind=hw, w=w, pts=line, surf=surf, name=t.get("name"), layer=_f(t.get("layer"), 0) or 0)
                if t.get("bridge") not in (None, "no"):
                    F["bridges"].append(rec)
                else:
                    F["roads"].append(rec)
                continue
            rw = t.get("railway")
            if rw in RAIL and t.get("tunnel") not in ("yes",) and t.get("service") not in ("yard",):
                rec = dict(kind=rw, w=RAIL[rw], pts=line, surf=0.0, name=None, layer=_f(t.get("layer"), 0) or 0)
                (F["bridges"] if t.get("bridge") not in (None, "no") else F["rails"]).append(rec)
                continue
            ww = t.get("waterway")
            if ww in WATERWAY and not closed and t.get("tunnel") is None:
                F["waterways"].append(dict(kind=ww, w=float(np.clip(_f(t.get("width"), WATERWAY[ww]), 0.8, 300)), pts=line))
                continue
            if t.get("natural") == "tree_row":
                F["tree_rows"].append(dict(pts=line, leaf=t.get("leaf_type")))
                continue

        # ---- polygons (closed ways and multipolygon relations)
        if e["type"] == "relation" and t.get("type") not in ("multipolygon", None):
            continue
        b = t.get("building")
        part = t.get("building:part")
        if (b and b not in ("no", "roof", "entrance")) or (part and part != "no"):
            if part and e.get("id") in seen_parts:
                continue
            for outer, holes in _polygons(fr, e):
                if len(outer) < 3 or not inside(outer) or geo.polygon_area(outer) < 4:
                    continue
                rec = dict(id=e["id"], outer=outer, holes=holes, tags=t, area=geo.polygon_area(outer))
                if part and part != "no" and not b:
                    seen_parts.add(e["id"]); rec["part"] = True; F["parts"].append(rec)
                else:
                    F["buildings"].append(rec)
            continue
        if _match(t, WATER_POLY):
            for outer, holes in _polygons(fr, e):
                F["water"].append(dict(outer=outer, holes=holes, area=geo.polygon_area(outer), kind=t.get("water") or t.get("natural") or "water",
                                       pool=t.get("leisure") == "swimming_pool"))
            continue
        if t.get("place") in ("island", "islet"):
            F["islands"] += [o for o, _ in _polygons(fr, e)]
        cover = _match(t, COVER)
        if t.get("area:highway") or (t.get("highway") in ("pedestrian", "footway", "service", "track") and t.get("area") == "yes"):
            cover = "paved"
        if cover:
            if cover == "paved" and t.get("parking") in ("underground", "multi-storey", "rooftop"):
                continue
            if cover == "pitch" and t.get("surface") in ("grass", "artificial_turf"):
                cover = "grass"
            for outer, holes in _polygons(fr, e):
                if inside(outer):
                    F["areas"].append(dict(cover=cover, outer=outer, holes=holes, leaf=t.get("leaf_type"), name=t.get("name")))
    # building parts: an outline that has parts inside it is drawn by its parts (OSM simple 3D buildings)
    if F["parts"]:
        cents = np.array([p["outer"].mean(0) for p in F["parts"]])
        keep = []
        for bld in F["buildings"]:
            o = bld["outer"]
            mn, mx = o.min(0), o.max(0)
            cand = np.where((cents[:, 0] > mn[0]) & (cents[:, 0] < mx[0]) & (cents[:, 1] > mn[1]) & (cents[:, 1] < mx[1]))[0]
            if any(geo.point_in_ring(cents[i][0], cents[i][1], o) for i in cand):
                bld["has_parts"] = True
                for i in cand:
                    F["parts"][i].setdefault("parent", bld)
            keep.append(bld)
        F["buildings"] = keep
    c = {k: len(v) for k, v in F.items()}
    print("  features: " + ", ".join(f"{k} {v}" for k, v in c.items() if v))
    return F
