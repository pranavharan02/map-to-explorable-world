"""OpenStreetMap through the Overpass API.

One query with `out geom` returns every feature the build needs, and every way carries its own coordinates, so no
separate node lookup is needed. Relations come back with their member geometries, which is how multipolygons such as
lakes with islands or courtyard buildings get assembled.
"""
import json
import os

from . import request

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

QUERY = """[out:json][timeout:240][maxsize:1073741824];
(
  way["building"]({b});
  relation["building"]["type"="multipolygon"]({b});
  way["building:part"]({b});
  relation["building:part"]["type"="multipolygon"]({b});
  way["highway"]({b});
  way["railway"]({b});
  way["waterway"]({b});
  way["natural"]({b});
  relation["natural"]["type"="multipolygon"]({b});
  way["landuse"]({b});
  relation["landuse"]["type"="multipolygon"]({b});
  way["leisure"]({b});
  relation["leisure"]["type"="multipolygon"]({b});
  way["amenity"~"^(parking|marketplace|school|university|college|hospital|grave_yard)$"]({b});
  way["man_made"~"^(pier|bridge|breakwater|groyne)$"]({b});
  way["place"~"^(square|island|islet)$"]({b});
  relation["water"]({b});
  node["natural"~"^(tree|peak|volcano|saddle)$"]({b});
  node["place"~"^(city|town|village|hamlet|suburb|quarter|neighbourhood|locality|island)$"]({b});
  node["tourism"~"^(attraction|viewpoint|museum)$"]({b});
  node["historic"]["name"]({b});
  node["amenity"="place_of_worship"]({b});
  node["man_made"~"^(lighthouse|tower)$"]({b});
);
out geom;"""


def fetch(bbox, path, refresh=False):
    """Download OSM for (west, south, east, north) into `path` (JSON). Returns the parsed document."""
    if os.path.exists(path) and not refresh:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    w, s, e, n = bbox
    q = QUERY.format(b=f"{s:.6f},{w:.6f},{n:.6f},{e:.6f}")
    last = None
    # public Overpass servers hand out query slots per client; after a big query the next one can bounce with 429/504
    # for a minute, so each mirror gets a few patient tries before the next one is asked
    for url in ENDPOINTS * 2:
        try:
            r = request("POST", url, data={"data": q}, timeout=300, retries=3, backoff=15)
            doc = json.loads(r.content.decode("utf-8"))      # Overpass sends UTF-8 without declaring it
            if doc.get("remark") and "error" in doc["remark"].lower():
                raise RuntimeError(doc["remark"])
            with open(path, "w", encoding="utf-8") as f:
                json.dump(doc, f)
            print(f"  osm: {len(doc.get('elements', []))} elements from {url.split('/')[2]} ({len(r.content) // 1024} KB)")
            return doc
        except Exception as ex:  # try the next mirror
            last = ex
            print(f"  osm: {url.split('/')[2]} failed ({ex}); trying the next mirror")
    raise RuntimeError(f"every Overpass endpoint failed: {last}")
