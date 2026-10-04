"""Where to stand: the spawn point, numbered viewpoints, a drone tour and map labels, all chosen from the data."""
import math

import numpy as np

from .. import geo

WALKABLE = ("pedestrian", "living_street", "residential", "footway", "unclassified", "tertiary", "service", "path",
            "secondary", "primary")


def _on_road(F, x0, y0, ok, kinds=WALKABLE, max_d=1e9):
    """Nearest point on a road of the given kinds to (x0, y0) that passes ok(x, y). Returns (x, y, heading)."""
    best = None
    for r in F["roads"]:
        if r["kind"] not in kinds:
            continue
        p = r["pts"]
        for i in range(len(p) - 1):
            a, b = p[i], p[i + 1]
            e = b - a
            L2 = float(e @ e) or 1e-9
            t = float(np.clip(((x0 - a[0]) * e[0] + (y0 - a[1]) * e[1]) / L2, 0, 1))
            q = a + e * t
            d = math.hypot(q[0] - x0, q[1] - y0)
            if d < max_d and (best is None or d < best[0]) and ok(q[0], q[1]):
                best = (d, float(q[0]), float(q[1]), math.atan2(e[1], e[0]))
    return best[1:] if best else None


def activity_centre(F, half, name=None):
    """Where the buildings are densest (a 60 m blur of footprint centroids), or the main place node near it."""
    pts = np.array([b["outer"].mean(0) for b in F["buildings"]]) if F["buildings"] else np.zeros((0, 2))
    if len(pts) < 5:
        return 0.0, 0.0
    from scipy.ndimage import gaussian_filter
    n = 128
    grid, _, _ = np.histogram2d(pts[:, 1], pts[:, 0], bins=n, range=[[-half, half], [-half, half]])
    g = gaussian_filter(grid, 60 / (2 * half / n))
    j, i = np.unravel_index(np.argmax(g), g.shape)
    x, y = -half + (i + 0.5) * 2 * half / n, -half + (j + 0.5) * 2 * half / n
    rank = {"city": 0, "town": 1, "village": 2, "suburb": 3, "quarter": 4, "hamlet": 5, "square": 6}
    places = [p for p in F["pois"] if p["kind"] in rank and abs(p["x"]) < half * 0.85 and abs(p["y"]) < half * 0.85]
    if places:   # the world's namesake first, then the most important place, then the one nearest the buildings
        named = [p for p in places if name and p["name"].lower() == name.lower()]
        p = named[0] if named else min(places, key=lambda p: (rank[p["kind"]], math.hypot(p["x"] - x, p["y"] - y)))
        return p["x"], p["y"]
    return x, y


def solve(cfg, F, T, shore_sd_at, building_at, bodies, open_at=None):
    half = cfg["half"]
    fr = geo.Frame(cfg["center"]["lat"], cfg["center"]["lon"])
    ok = lambda x, y: abs(x) < half - 60 and abs(y) < half - 60 and shore_sd_at(x, y) > 1.0 and not building_at(x, y)
    if cfg.get("spawn"):
        sx, sy = (float(v) for v in fr.to_xy(cfg["spawn"]["lon"], cfg["spawn"]["lat"]))
        s = _on_road(F, sx, sy, ok, max_d=40) or (sx, sy, 0.0)
    else:
        cx, cy = activity_centre(F, half, cfg["name"])
        s = _on_road(F, cx, cy, ok) or (cx, cy, 0.0)
    spawn = dict(x=round(s[0], 2), y=round(s[1], 2), heading=round(s[2], 3), mode="walk")
    views = [dict(name="Start", **spawn)]
    # named places inside the core, most important first
    rank = {"town": 0, "village": 0, "city": 0, "suburb": 1, "hamlet": 1, "worship": 2, "attraction": 2, "viewpoint": 2,
            "museum": 3, "historic": 3, "square": 3, "quarter": 3, "neighbourhood": 4, "locality": 5}
    pois = sorted((p for p in F["pois"] if p["kind"] in rank and abs(p["x"]) < half - 80 and abs(p["y"]) < half - 80),
                  key=lambda p: (rank[p["kind"]], math.hypot(p["x"], p["y"])))
    used = [(spawn["x"], spawn["y"])]
    for p in pois:
        if len(views) >= 6:
            break
        if any(math.hypot(p["x"] - u[0], p["y"] - u[1]) < 160 for u in used):
            continue
        q = _on_road(F, p["x"], p["y"], ok, max_d=120)
        if not q:
            continue
        d = math.hypot(p["x"] - q[0], p["y"] - q[1])
        # a viewpoint looks at the town; otherwise face the place when it is a short walk away, or look along the street
        if p["kind"] == "viewpoint":
            h = math.atan2(spawn["y"] - q[1], spawn["x"] - q[0])
        else:
            h = math.atan2(p["y"] - q[1], p["x"] - q[0]) if d > 15 else q[2]
        views.append(dict(name=p["name"], x=round(q[0], 2), y=round(q[1], 2), heading=round(h, 3), mode="walk"))
        used.append((q[0], q[1]))
    if bodies:   # the waterfront nearest the center, looking out over the largest body of water
        b = bodies[0]
        q = _on_road(F, b["x"] * 0.3, b["y"] * 0.3, lambda x, y: ok(x, y) and shore_sd_at(x, y) < 25, max_d=600)
        if q:
            views.append(dict(name="Waterfront", x=round(q[0], 2), y=round(q[1], 2),
                              heading=round(math.atan2(b["y"] - q[1], b["x"] - q[0]), 3), mode="walk"))
    # high ground with a view: the highest open (not wooded) point, looking back at the town
    gx, gy = np.meshgrid(T.xs, T.ys)
    inner = (np.abs(gx) < half * 0.8) & (np.abs(gy) < half * 0.8)
    if open_at is not None:
        sub = (slice(None, None, 8), slice(None, None, 8))
        cand = np.argsort(np.where(inner[sub], T.H[sub], -1e9).ravel())[::-1][:400]
        for k in cand:
            j, i = np.unravel_index(k, T.H[sub].shape)
            hx, hy = float(T.xs[::8][i]), float(T.ys[::8][j])
            if open_at(hx, hy) and ok(hx, hy):
                if T.sample(hx, hy) - np.percentile(T.H, 10) > 60:
                    views.append(dict(name="High ground", x=round(hx, 2), y=round(hy, 2),
                                      heading=round(math.atan2(spawn["y"] - hy, spawn["x"] - hx), 3), mode="walk"))
                break
    views.append(dict(name="Overview", x=round(-half * 0.55, 1), y=round(-half * 0.55, 1), heading=round(math.atan2(1, 1), 3),
                      mode="fly", agl=round(half * 0.32 + 60)))
    # drone tour: a loop at 0.45-0.6 x half around the center, dipping towards points of interest
    tour = []
    N = 10
    for k in range(N):
        a = math.pi * 2 * k / N - math.pi * 0.75
        r = half * (0.48 + 0.12 * math.sin(k * 1.7))
        x, y = r * math.cos(a), r * math.sin(a)
        cap = ""
        if pois:
            p = min(pois, key=lambda p: math.hypot(p["x"] - x, p["y"] - y))
            if math.hypot(p["x"] - x, p["y"] - y) < half * 0.35:
                x, y, cap = x * 0.6 + p["x"] * 0.4, y * 0.6 + p["y"] * 0.4, p["name"]
        tour.append(dict(x=round(x, 1), y=round(y, 1), agl=round(45 + 40 * (k % 3) + half * 0.04), caption=cap))
    seen = set()
    for t in tour:   # one caption per name
        if t["caption"] in seen:
            t["caption"] = ""
        seen.add(t["caption"])
    labels = [dict(name=p["name"], kind=p["kind"], x=round(p["x"], 1), y=round(p["y"], 1)) for p in F["pois"]
              if p["kind"] in rank or p["kind"] == "peak"][:60]
    print(f"  places: spawn at ({spawn['x']:.0f}, {spawn['y']:.0f}), {len(views)} viewpoints, {len(labels)} labels")
    return dict(spawn=spawn, views=views[:9], tour=tour, labels=labels)
