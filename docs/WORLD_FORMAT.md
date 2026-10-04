# World package format

A world package is the contract between the Python pipeline and the browser runtime. It's a folder of ten files,
usually 3 to 6 MB in total, that the runtime fetches in parallel. You can write your own pipeline that emits this
format, or your own renderer that reads it.

This page describes format version 1, which `world.json` declares as `"format": 1`.

## Coordinate frames

The package uses a local tangent frame in meters, centered on the world's `center`:

- In the package, `x` points east and `y` points north.
- In the runtime, three.js uses `x` east, `y` up, and `z` south, so a package point `(x, y)` is at `(x, -y)` on the
  ground plane.
- Over a few kilometres the frame is equirectangular. The pipeline converts degrees to meters with the WGS84 series
  for meters per degree at the center latitude, which keeps errors well under a meter.

The walkable core is the square `[-half, half]` on both axes. The context ring, when present, is the larger square
`[-far.half, far.half]`.

Two grid conventions appear in the images:

Point grid
: `n` samples per side with the first and last samples exactly on the edges, so sample `i` sits at
  `-half + i * 2 * half / (n - 1)`. The heightfield and the water levels use point grids, because the terrain mesh
  needs vertices on the world boundary.

Area grid
: `n` pixels per side covering the square, with pixel centers at `-half + (i + 0.5) * 2 * half / n`. Every other
  image is an area grid.

In both, row 0 is the north edge. With texture `flipY` off, texture coordinate `v = (z + half) / (2 * half)`.

## Files

| File | Grid | Encoding | Contents |
|---|---|---|---|
| `world.json` | | JSON | Header: extents, quantization, counts, viewpoints, tour, labels, credits, and the section table for `world.bin` |
| `world.bin` | | Little-endian typed arrays | Buildings, bridges, and trees |
| `height.webp` | Point, `height.n` | Lossless RGB | Terrain height: `(R * 256 + G) * height.scale + height.lo` meters above sea level |
| `water.webp` | Point, `height.n` | Lossless RGB | Water-surface level in R and G (same quantization as the terrain); B is 255 where water is |
| `mask.webp` | Area, `mask.n` | Lossless RGB | R: signed distance to the shoreline, `(R - 128) * 0.25` m, positive on land. G: signed distance to the nearest road edge, `(G - 128) * 0.125` m, negative on the road. B: surface of the nearest road, 0 (gravel) to 255 (asphalt) |
| `cover.webp` | Area, `cover.n` | Lossless RGB | Land-cover weights, 0 to 255: R grass, G forest floor, B bare ground or rock |
| `ground.webp` | Area, `cover.n` | Lossless RGB | R: paving weight. G: contact shade around buildings. B: farmland weight |
| `color.webp` | Area, `cover.n` | Lossy RGB, sRGB | Sentinel-2 color of the ground, with roofs painted out |
| `farh.webp` | Point, `far.n` | Lossless RGB | Context-ring height, `(R * 256 + G) * far.scale + far.lo` meters |
| `far.webp` | Area, `far.colorN` | Lossy RGB plus lossless alpha | RGB: Sentinel-2 color (sRGB). A: signed distance to the shoreline, `(A - 128) * 2` m |

The context-ring files exist only when `world.json` has a `far` object.

Data images never use alpha on the CPU side, because canvas readback premultiplies color by alpha and loses data
under transparent pixels. `far.webp` is the exception, and only the GPU reads its alpha.

## world.json

```json
{
  "format": 1,
  "id": "hallstatt",
  "name": "Hallstatt",
  "subtitle": "A lake village under the Dachstein, Upper Austria",
  "center": {"lat": 47.5605, "lon": 13.6445},
  "timeZone": "Europe/Vienna",
  "tz": 1,
  "half": 1000,
  "biome": "temperate",
  "palette": "europe",
  "height": {"n": 1025, "lo": 490.6, "scale": 0.0163},
  "mask": {"n": 2048, "shoreScale": 0.25, "roadScale": 0.125},
  "cover": {"n": 1024},
  "far": {"half": 9000, "n": 513, "lo": 493.0, "scale": 0.035, "colorN": 1024, "sdScale": 2.0, "trees": 140000},
  "water": {"bodies": [{"level": 508.35, "area": 1227341, "flat": true, "x": 683.6, "y": -13.7}]},
  "counts": {"buildings": 760, "bridges": 23, "trees": 51749, "species": [23559, 6414, 17567, 2650, 0, 1559]},
  "spawn": {"x": 313.8, "y": 185.7, "heading": 2.6, "mode": "walk"},
  "views": [{"name": "Start", "x": 313.8, "y": 185.7, "heading": 2.6, "mode": "walk"}],
  "tour": [{"x": -350.0, "y": -350.0, "agl": 85, "caption": "Hallstatt"}],
  "labels": [{"name": "Hallstatt", "kind": "village", "x": 313.8, "y": 185.7}],
  "credits": {"osm": "© OpenStreetMap contributors (ODbL)"},
  "sections": {"tXY": [0, 103498, "int16"]},
  "files": {"height.webp": 543744}
}
```

Notes on the fields:

- `timeZone` is an IANA zone. When it's present, the runtime shows local time with daylight-saving changes. `tz` is
  a fixed offset in hours, used when `timeZone` is absent.
- `heading` is in radians, measured counter-clockwise from east in the package frame.
- `water.bodies` lists the largest water bodies, largest first. `flat` is `false` for sloping water such as a river.
- `counts.species` counts trees per species code, in the order listed in [Trees](#trees).
- `sections` maps a section name to `[byte offset, element count, dtype]` in `world.bin`.
- `files` maps each file to its size in bytes.

## world.bin

Each section is a little-endian typed array that starts on a 4-byte boundary. Coordinates are `int16` decimetres in
the package frame, which limits the core to plus or minus 3,276 m.

### Buildings

| Section | Type | Per | Contents |
|---|---|---|---|
| `rOff` | `uint32` | ring + 1 | Offset of each ring's first point in `bPts` |
| `bRing` | `uint32` | building + 1 | Index of each building's first ring in `rOff`. The first ring is the outline; the rest are courtyards |
| `bPts` | `int16` | point × 2 | `x, y` in decimetres |
| `bH` | `uint16` | building × 3 | Height, minimum height, and roof height, all in decimetres. Roof height 0 means the runtime derives it from the pitch |
| `bA` | `uint8` | building × 8 | Kind, roof shape, storeys, seed, roof pitch in degrees, flags, and two reserved bytes |
| `bC` | `uint8` | building × 6 | Wall color, then roof color, as sRGB bytes |

Kinds: 0 house, 1 apartments, 2 commercial, 3 industrial, 4 religious, 5 civic, 6 utility, 7 tower, 8 hut.

Roof shapes: 0 flat, 1 gabled, 2 hipped, 3 pyramidal, 4 skillion, 5 dome.

Flags: bit 0 marks a building part (OpenStreetMap Simple 3D Buildings). Bit 1 means the height came from a `height`
tag, which runs from the ground to the top of the roof.

### Bridges

| Section | Type | Per | Contents |
|---|---|---|---|
| `brOff` | `uint32` | bridge + 1 | Offset of each bridge's first point in `brPts` |
| `brPts` | `int16` | point × 2 | Centerline points in decimetres |
| `brA` | `float32` | bridge × 4 | Width in meters, surface (0 to 1), kind (0 road, 1 railway), and OSM layer |

### Trees

| Section | Type | Per | Contents |
|---|---|---|---|
| `tXY` | `int16` | tree × 2 | Core trees, `x, y` in decimetres |
| `tA` | `uint8` | tree × 3 | Species, seed, and size (0 to 255) |
| `fXY` | `int16` | tree × 2 | Context-ring trees, drawn as impostors |
| `fA` | `uint8` | tree × 3 | Species, seed, and size |

Species codes: 0 broadleaf, 1 tall broadleaf, 2 conifer, 3 pine, 4 palm, 5 shrub.

## Compatibility

A reader should check `format` and refuse versions it doesn't know. New optional fields can appear within a version.
A change that breaks existing readers increments `format`.
