"""Command line.

    python -m pipeline worlds/hallstatt.json            fetch (cached) and build one world
    python -m pipeline worlds/*.json                    several worlds
    python -m pipeline new "Hallstatt, Austria"         write worlds/hallstatt.json from a place name
    python -m pipeline worlds/x.json --fetch-only       download only
    python -m pipeline worlds/x.json --refresh          download again, ignoring the cache
"""
import argparse
import glob
import json
import os
import sys
import time

from . import config

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cmd_new(args):
    from .fetch import request
    r = request("GET", "https://nominatim.openstreetmap.org/search", params={"q": args.place, "format": "json", "limit": 1},
                timeout=30).json()
    if not r:
        sys.exit(f"no match for {args.place!r}")
    hit = r[0]
    name = args.name or hit["display_name"].split(",")[0].strip()
    cfg = {"name": name, "subtitle": ", ".join(p.strip() for p in hit["display_name"].split(",")[1:3]),
           "center": {"lat": round(float(hit["lat"]), 5), "lon": round(float(hit["lon"]), 5)},
           "half": args.half, "far": args.far}
    path = os.path.join(ROOT, "worlds", f"{config.slug(name)}.json")
    if os.path.exists(path) and not args.force:
        sys.exit(f"{path} exists; pass --force to overwrite")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print(f"wrote {os.path.relpath(path, ROOT)}: {name} at {cfg['center']['lat']}, {cfg['center']['lon']}")
    print(f"next: python -m pipeline {os.path.relpath(path, ROOT)}")


def cmd_build(args):
    from .fetch.all import fetch_all
    paths = [p for pat in args.configs for p in (glob.glob(pat) or [pat])]
    for path in paths:
        cfg = config.load(path)
        t0 = time.time()
        print(f"== {cfg['name']} ({cfg['id']}): {2 * cfg['half'] / 1000:.1f} km core, "
              f"{2 * cfg['far'] / 1000:.0f} km context")
        data = fetch_all(cfg, args.cache, args.refresh)
        print(f"   fetched in {time.time() - t0:.0f} s")
        if args.fetch_only:
            continue
        from .build import build_world
        build_world(cfg, data, args.out)
        print(f"   done in {time.time() - t0:.0f} s")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "new":
        p = argparse.ArgumentParser(prog="python -m pipeline new")
        p.add_argument("place", help="a place name for the OpenStreetMap geocoder (Nominatim)")
        p.add_argument("--name")
        p.add_argument("--half", type=float, default=1000)
        p.add_argument("--far", type=float, default=6000)
        p.add_argument("--force", action="store_true")
        return cmd_new(p.parse_args(argv[1:]))
    p = argparse.ArgumentParser(prog="python -m pipeline")
    p.add_argument("configs", nargs="+", help="world config files (JSON)")
    p.add_argument("--out", default=os.path.join(ROOT, "web", "public", "worlds"))
    p.add_argument("--cache", default=os.path.join(ROOT, "cache"))
    p.add_argument("--fetch-only", action="store_true")
    p.add_argument("--refresh", action="store_true")
    cmd_build(p.parse_args(argv))


if __name__ == "__main__":
    main()
