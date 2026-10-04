"""Render a built world package as one contact sheet, to check every layer before opening it in the browser.

    python tools/inspect_world.py web/public/worlds/hallstatt [out.jpg]

Panels: hillshaded terrain with water, satellite color, shore distance, road distance, land cover, ground extras
(paving, contact shade, farmland), the context ring's relief and color, and buildings and trees as dots.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw


def load16(path, lo, scale):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
    return (a[..., 0] * 256 + a[..., 1]) * scale + lo, a[..., 2]


def hillshade(h, cell, az=315, alt=40):
    gy, gx = np.gradient(h, cell)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    a, z = np.radians(az), np.radians(90 - alt)
    s = np.cos(z) * np.cos(slope) + np.sin(z) * np.sin(slope) * np.cos(a - aspect)
    return np.clip(s, 0, 1)


def panel(arr, size=512):
    if arr.dtype != np.uint8:
        arr = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
    im = Image.fromarray(arr)
    return im.convert("RGB").resize((size, size), Image.BILINEAR)


def main(world, out=None):
    with open(os.path.join(world, "world.json"), encoding="utf-8") as f:
        m = json.load(f)
    hm = m["height"]
    H, _ = load16(os.path.join(world, "height.webp"), hm["lo"], hm["scale"])
    L, wmask = load16(os.path.join(world, "water.webp"), hm["lo"], hm["scale"])
    cell = 2 * m["half"] / (hm["n"] - 1)
    hs = hillshade(H, cell)
    elev = (H - H.min()) / max(1e-6, np.ptp(H))
    terr = np.dstack([hs * (0.55 + 0.45 * elev), hs * (0.6 + 0.3 * elev), hs * 0.55])
    terr[wmask > 127] = (0.15, 0.3, 0.55)
    mask = np.asarray(Image.open(os.path.join(world, "mask.webp")).convert("RGB"))
    shore = (mask[..., 0].astype(float) - 128) * 0.25
    road = (mask[..., 1].astype(float) - 128) * 0.125
    shore_v = np.dstack([np.clip(0.5 + shore / 64, 0, 1)] * 3)
    shore_v[np.abs(shore) < 0.6] = (1, 0.2, 0.2)
    road_v = np.dstack([np.clip(road / 16 + 0.5, 0, 1), np.clip(road / 16 + 0.5, 0, 1), np.where(road < 0, mask[..., 2] / 255, 0.3)])
    panels = [("terrain + water", panel(terr)), ("satellite colour", panel(np.asarray(Image.open(os.path.join(world, "color.webp")).convert("RGB")))),
              ("shore distance", panel(shore_v)), ("road distance (blue: surface)", panel(road_v)),
              ("cover: grass / forest / bare", panel(np.asarray(Image.open(os.path.join(world, "cover.webp")).convert("RGB")))),
              ("ground: paved / shade / farm", panel(np.asarray(Image.open(os.path.join(world, "ground.webp")).convert("RGB"))))]
    if m.get("far"):
        fm = m["far"]
        FH, _ = load16(os.path.join(world, "farh.webp"), fm["lo"], fm["scale"])
        fhs = hillshade(FH, 2 * fm["half"] / (fm["n"] - 1))
        panels.append(("context ring relief", panel(np.dstack([fhs] * 3))))
        panels.append(("context ring colour", panel(np.asarray(Image.open(os.path.join(world, "far.webp")).convert("RGB")))))
    # buildings and trees as dots
    sec = m["sections"]
    blob = open(os.path.join(world, "world.bin"), "rb").read()
    get = lambda k: np.frombuffer(blob, dtype=np.dtype(sec[k][2]).newbyteorder("<"), count=sec[k][1], offset=sec[k][0])
    dots = Image.new("RGB", (1024, 1024), (24, 26, 30))
    d = ImageDraw.Draw(dots)
    half = m["half"]
    px = lambda x, y: ((x / 10 + half) / (2 * half) * 1024, (half - y / 10) / (2 * half) * 1024)
    t = get("tXY").reshape(-1, 2)
    ta = get("tA").reshape(-1, 3)
    cols = [(90, 160, 70), (140, 190, 90), (40, 110, 60), (70, 130, 80), (190, 200, 80), (130, 150, 60)]
    for (x, y), a in zip(t[::2], ta[::2]):
        q = px(x, y)
        d.point(q, fill=cols[min(a[0], 5)])
    pts = get("bPts").reshape(-1, 2)
    roff, bring = get("rOff"), get("bRing")
    bc = get("bC").reshape(-1, 6)
    for b in range(len(bring) - 1):
        r0 = roff[bring[b]]
        r1 = roff[bring[b] + 1]
        poly = [px(*p) for p in pts[r0:r1]]
        if len(poly) >= 3:
            d.polygon(poly, fill=tuple(int(v) for v in bc[b, 3:6]))
    panels.append(("buildings (roof colour) + trees", dots.resize((512, 512))))
    cols_n = 3
    rows = (len(panels) + cols_n - 1) // cols_n
    sheet = Image.new("RGB", (cols_n * 512, rows * 532), (255, 255, 255))
    dr = ImageDraw.Draw(sheet)
    for k, (name, im) in enumerate(panels):
        x, y = (k % cols_n) * 512, (k // cols_n) * 532
        sheet.paste(im, (x, y + 20))
        dr.text((x + 6, y + 4), name, fill=(0, 0, 0))
    out = out or os.path.join(world, "..", f"{m['id']}_inspect.jpg")
    sheet.save(out, quality=88)
    print(f"{m['name']}: {m['counts']}  ->  {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
