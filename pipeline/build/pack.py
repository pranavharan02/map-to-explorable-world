"""Write the world package: a JSON header, one binary blob of typed arrays, and a handful of WebP images.

Data images are lossless WebP. The browser's image decoder unpacks them off the main thread faster than any JavaScript
decompressor, and lossless WebP predicts smooth fields (heights, distance fields) so well that they shrink to a
fraction of their raw size. 16-bit values are split across two channels (high byte in R, low byte in G); alpha is
never used for data on the CPU side, because canvas readback premultiplies it.
"""
import json
import os

import numpy as np
from PIL import Image


def u16(a, lo, scale):
    return np.clip(np.rint((np.asarray(a, np.float64) - lo) / scale), 0, 65535).astype(np.uint16)


def split16(q, b=None):
    out = np.zeros(q.shape + (3,), np.uint8)
    out[..., 0] = q >> 8
    out[..., 1] = q & 255
    if b is not None:
        out[..., 2] = b
    return out


def to8(a, scale=1.0, offset=0.0):
    return np.clip(np.rint(np.asarray(a, np.float64) * scale + offset), 0, 255).astype(np.uint8)


def save(path, arr, lossless=True, quality=88, mode=None):
    im = Image.fromarray(arr, mode) if mode else Image.fromarray(arr)
    if lossless:
        im.save(path, "WEBP", lossless=True, quality=100, method=5, exact=True)
    else:
        im.save(path, "WEBP", quality=quality, method=6, alpha_quality=100, exact=True)
    return os.path.getsize(path)


class Blob:
    """Little-endian typed arrays packed back to back, each 4-byte aligned, with a section table for world.json."""

    def __init__(self):
        self.buf, self.sections = bytearray(), {}

    def put(self, name, arr, dtype):
        a = np.ascontiguousarray(np.asarray(arr).astype(np.dtype(dtype).newbyteorder("<")))
        while len(self.buf) % 4:
            self.buf += b"\0"
        self.sections[name] = [len(self.buf), int(a.size), np.dtype(dtype).name]
        self.buf += a.tobytes()


def dm(a):
    return np.clip(np.rint(np.asarray(a) * 10), -32767, 32767).astype(np.int16)


def write(out_dir, meta, images, blob):
    os.makedirs(out_dir, exist_ok=True)
    sizes = {}
    for name, (arr, lossless, mode) in images.items():
        sizes[name] = save(os.path.join(out_dir, name), arr, lossless=lossless, mode=mode)
    with open(os.path.join(out_dir, "world.bin"), "wb") as f:
        f.write(blob.buf)
    sizes["world.bin"] = len(blob.buf)
    meta["sections"] = blob.sections
    meta["files"] = {k: v for k, v in sizes.items()}
    with open(os.path.join(out_dir, "world.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)
    total = sum(sizes.values())
    print("  package: " + ", ".join(f"{k} {v // 1024} KB" for k, v in sizes.items()) + f"  = {total / 1e6:.1f} MB")


def update_index(root):
    worlds = []
    for d in sorted(os.listdir(root)):
        p = os.path.join(root, d, "world.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                m = json.load(f)
            worlds.append(dict(id=m["id"], name=m["name"], subtitle=m.get("subtitle", ""),
                               size=round(sum(m.get("files", {}).values()) / 1e6, 1)))
    with open(os.path.join(root, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"worlds": worlds}, f, indent=1, ensure_ascii=False)
