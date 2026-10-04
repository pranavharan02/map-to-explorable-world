# How the engine works

This page walks through the techniques that make a real place walkable in a browser, in the order the data flows: from
open datasets to a world package, then from the package to pixels. Most of them were worked out on an earlier project,
Kumbalangi, and the excerpts marked **From Kumbalangi** show where each one started. Those excerpts are short, and
they're the only code from that project in this repository. Everything under `pipeline/` and `web/` is a separate,
general implementation.

## Where it came from

**Kumbalangi**, an island village in the Kochi backwaters, was built in a few long sessions with Claude, with one
constraint: it had to run smoothly on an integrated laptop GPU. It drew its first frame about two seconds after the page opened, from a
2.6 MB package, and generated everything else in code when the page loaded: 3,440 houses from their footprints,
94,000 trees, the water, the sky, the people on the water, and the sound. Its frame time on the integrated GPU went
from 18.1 ms to between 7 and 11 ms in the first version. A setting that drops the render resolution to half only
saved about 30%, which pointed at the real cost: the number of geometry passes, not the number of pixels.

This repository generalizes it. The pipeline works for any place on Earth that the four datasets cover, and
the runtime knows nothing about any one place.

## The budget

Every decision follows from four numbers:

- **16.7 ms per frame** on an integrated laptop GPU at 720p, which is 60 Hz with no headroom to spare.
- **A few megabytes** to download: no textures, no models, no audio files.
- **About two seconds** from opening the page to the first drawn frame.
- **A main thread that never blocks** for more than a frame or two while the world loads.

## From open data to a world package

### Elevation you can stand on

Satellite elevation is often a surface model: roofs and tree crowns sit on the ground as bumps, and a 30 m staircase
shows as facets underfoot. A grey opening (an erosion followed by a dilation, about 36 m
wide) removes positive features narrower than its window while keeping hills, and a light blur smooths the staircase.

Applied everywhere, that opening also shaves the crests of real ridges, as the Hallstatt example showed: up
to 57 m came off forested ridges, because Austria's elevation is already a bare-earth lidar model. So the pipeline
now decides first. It measures how far building footprints stand above the ground around them, and how rough the
elevation is over built-up land. In a surface model, footprints read several meters high, and a city is rough at the
scale of its buildings. In a bare-earth model, both read close to zero. When the elevation is a surface model, the
opening runs only where buildings or tree cover stand, and never on slopes steeper than about 20 degrees. For the
code, see `Terrain.surface_model_score()` and `Terrain.built_roughness()` in `pipeline/build/terrain.py`.

### Water from two satellite indices

OpenStreetMap water fails in both directions: a lake multipolygon can swallow an island, and a river polygon can be
missing. Kumbalangi took its shoreline from Sentinel-2 instead, combining two water indices, and stored the result as
a signed distance in meters, so the shoreline stays smooth at any distance:

**From Kumbalangi** (`data/build_world.py`):

```python
ndwi = (green - nir) / (green + nir + 1e-6)
mndwi = (green - swir) / (green + swir + 1e-6)
water_score = np.maximum(ndwi, mndwi * 0.8)
up = lambda a: np.array(Image.fromarray(a.astype(np.float32)).resize((MN, MN), Image.BICUBIC))
water = up(gaussian_filter(water_score, 0.8)) > 0.02
# land = not water, plus buildings and bunds; clean speckle
land = (~water) | bmask | (np.array(lanes_land) > 127)
land = binary_closing(binary_opening(land, iterations=1), iterations=1)
sd = np.where(land, distance_transform_edt(land), -distance_transform_edt(~land)) * PX   # metres, + on land
```

Kumbalangi's water sits at sea level, so one plane at one height was enough. Most places have lakes in valleys and
rivers that fall, so this repository adds three steps, in `pipeline/build/water.py`:

1. Satellite water must also be flat, because shadowed mountainsides can pass both indices.
1. OpenStreetMap adds what a 10 m pixel can't resolve, such as streams and ditches. Its large polygons count only
   where the satellite doesn't see dense vegetation.
1. Every connected water body gets its own surface level from the elevation of its banks. Lakes are flat, and rivers
   get a level that falls with them. The terrain is carved into a shelving bed below each level, and the banks are
   raised slightly above it, so the shoreline you see is where terrain and water actually meet.

### Satellite color without roofs

From a few hundred meters away, the ground should look like what the satellite saw. But a satellite pixel over a
house is roof, and if the terrain uses that color, every building stands on a smear of itself. Kumbalangi painted the
roofs out with normalized convolution, borrowing color from the ground around each footprint:

**From Kumbalangi** (`data/build_world.py`):

```python
bright = rgb.mean(-1) > np.percentile(rgb.mean(-1), 90)     # unmapped white roofs too
keep = (1 - np.clip(bm_c * 2, 0, 1)) * (1 - gaussian_filter(bright.astype(np.float32), 0.7) * 0.9)
num = np.dstack([gaussian_filter(rgb[..., i] * keep, 3) for i in range(3)]); den = gaussian_filter(keep, 3)[..., None] + 1e-4
fill = num / den
rgb = rgb * keep[..., None] + fill * (1 - keep[..., None])
```

This repository does the same in `pipeline/build/ground.py`, from a per-pixel median of the four clearest scenes
rather than one scene, so clouds and haze in any single scene drop out. It also uses the roof pixels it removes: a
building's roof color comes from the satellite pixels inside its footprint, trusted more the larger the roof is.

### Roads as distance fields

A road drawn as a mesh z-fights with the terrain under it, and a road drawn from a rasterized mask goes soft up close.
This repository stores roads as a second distance field: meters to the nearest road edge, negative on the road. It's
rasterized at twice the output resolution and averaged down, so edges land within about a quarter of a pixel, and the
terrain shader paints asphalt, setts, or gravel with an antialiased edge at any distance. On slopes, the pipeline
also levels the terrain across each road, so the road sits in a cut. For the code, see `pipeline/build/roads.py`.

### A compact package

The package is a JSON header, one binary file of typed arrays, and a handful of WebP images; see
[World package format](WORLD_FORMAT.md). Three choices keep it small:

- **Quantization.** Footprints, trees, and bridges are `int16` decimetres, and attributes are bytes.
- **Lossless WebP for data.** Heights and distance fields are smooth, and lossless WebP predicts smooth fields so well
  that a 1025 × 1025 heightfield of an Alpine valley is about 530 KB. The browser's image decoder unpacks it off the
  main thread, faster than a JavaScript decompressor.
- **Nothing procedural is stored.** Tree shapes, leaf textures, facade detail, ground texture, and clouds are all
  generated in the browser.

## From the package to pixels

### Geometry built in workers

The slowest work at startup is turning footprints into buildings and heightfields into meshes. Kumbalangi moved both
off the main thread into two Web Workers that hand their results back as transferable typed arrays, which move
between threads without a copy:

**From Kumbalangi** (`web/src/build.worker.js`):

```js
self.onmessage = async (e) => {
  const t0 = performance.now();
  const world = await loadWorld(e.data.base, false); const t1 = performance.now();
  const transfer = []; let out;
  if (e.data.job === 'terrain') { out = buildTerrainData(world); for (const b of out.blocks) transfer.push(b.position.buffer, b.normal.buffer, b.index.buffer); }
  else { out = buildHouseData(world); for (const c of out.chunks) for (const k of Object.keys(c)) transfer.push(c[k].buffer); }
  self.postMessage({ out, ms: { load: Math.round(t1 - t0), build: Math.round(performance.now() - t1) } }, transfer);
};
```

The open version, `web/src/build/build.worker.js`, starts both workers before the renderer exists, so their fetches
and builds overlap everything else the main thread does.

### Terrain at the error it can afford

Kumbalangi's island was nearly flat, so it gave flat chunks a coarse grid and bank chunks a fine one. A mountain
valley needs a general rule, so `web/src/build/terrain.build.js` gives every 32-cell chunk the coarsest grid whose
bilinear reconstruction stays within a height tolerance. A valley floor costs two triangles, and a ridge keeps every
sample. Each block of chunks is built at three tolerances (0.25 m, 0.9 m, and 3 m), and the renderer picks one per
block by distance. Skirts, short walls hanging from every chunk edge, hide the cracks where neighbors of different
resolution meet. The mesh carries positions only: normals come from a full-resolution normal map, so a coarse block
still shades with every gully.

### Facades drawn in the fragment shader

Kumbalangi's houses carry almost no geometry for their detail. Each vertex stores surface coordinates in meters
(along the wall, and above the floor) plus a material and a seed, and the fragment shader lays out windows, grilles,
sunshades, tiles, and staining at true scale. This repository keeps the idea with a general vocabulary: storeys and
bays, windows with frames and glazing bars, curtains, doors, shopfronts, shutters on European houses, curtain walls
on towers, corrugated sheds, roof courses, and lit windows at night picked per window from a hash. For the code, see
`web/src/buildings.js`.

### Trees: three levels of detail that never pop

Near trees are full meshes with wind, mid-distance trees are reduced meshes, and far trees are camera-facing
impostors. Where two levels overlap, they fade with complementary screen-door dither: one level discards a pixel
exactly where the other keeps it, so the swap is invisible and needs no transparency sorting:

**From Kumbalangi** (`web/src/vegetation.js`):

```glsl
uniform vec4 uFade;   // fade-in start/end, fade-out start/end (metres)
varying vec3 vInst;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void ditherFade() {
  float d = distance(vInst + vec3(0.0, 5.0, 0.0), cameraPosition), n = ign(gl_FragCoord.xy);   // matches the CPU list split (tree mid-height)
  if (uFade.y > 0.0 && smoothstep(uFade.x, uFade.y, d) <= 1.0 - n) discard;
  if (1.0 - smoothstep(uFade.z, uFade.w, d) <= n) discard;
}
```

The impostors come from an atlas that's rendered once at startup, with each species seen from 8 azimuths at 3
elevations, in albedo and normal. The vertex shader picks the two nearest azimuth frames for the viewing direction
and blends them, and lights the result with the real sun:

**From Kumbalangi** (`web/src/vegetation.js`):

```glsl
vec3 lc = vec3(cy * toCam.x - sy * toCam.z, toCam.y, sy * toCam.x + cy * toCam.z);
float az = atan(lc.x, lc.z); if (az < 0.0) az += 6.2831853;
float af = az / 6.2831853 * AZ; float a0 = floor(af); vMix = af - a0; float a1 = mod(a0 + 1.0, AZ);
float el = asin(clamp(lc.y, -1.0, 1.0)); float e = el < 0.36 ? 0.0 : (el < 0.91 ? 1.0 : 2.0);
```

Palms vary from 7 m to 21 m, but stretching one palm mesh would stretch its fronds too. Kumbalangi put the trunk
stretch in the instance matrix's y scale and undid it above the crown:

**From Kumbalangi** (`web/src/vegetation.js`):

```glsl
float kSt = length(instanceMatrix[1].xyz) / length(instanceMatrix[0].xyz);
if (transformed.y > uCrownY) transformed.y = uCrownY + (transformed.y - uCrownY) / kSt;
```

This repository uses the same trick for palms and pines, in `web/src/trees/vegetation.js`, with six species built in
code: broadleaf, tall broadleaf, conifer, pine, palm, and shrub.

### One list per pass

The main view, the water reflection, and the shadow map each need different trees. Kumbalangi kept four instance lists
per species, refilled on the CPU only after the viewer moved 3 m, and used render layers to choose the pass:

**From Kumbalangi** (`web/src/vegetation.js`):

```js
// Per set, four instanced lists. Layers pick the pass:  0 = main + reflection + shadow cameras,
// 2 = reflection camera only, 3 = shadow camera only.
//   near : full mesh, d < near+band, main pass (+ casts)          mid  : reduced mesh, near < d < far, main only
//   refl : reduced mesh, d < near+band, reflection pass only      shad : reduced mesh, inside the shadow box, casts only
```

Rebuilding this exposed a three.js detail: in r186, the shadow pass filters casters by the layers of the camera you
render with, not the layers of the shadow camera. A list on a shadow-only layer is never drawn into the shadow map.
The open version keeps the shadow-only list on the default layer and draws it with zero instances in every color
pass, by setting its instance count to zero in `onBeforeRender` and restoring it in `onAfterRender`. The shadow pass
doesn't call those hooks, so it draws the full list.

### Reflections only when they show

Water reflects the scene through a second render from a camera mirrored in the water plane. Two things keep that cheap.
The mirrored camera gets an oblique near plane on the water (Lengyel's technique), so nothing below the surface leaks
into the reflection, and the pass draws a lighter scene at a fraction of the resolution. And an occlusion query
around the water's own draw tells the next frame whether any water reached the screen at all:

**From Kumbalangi** (`web/src/water.js`):

```js
// Skip the reflection pass while no water is on screen (deep in the lanes, the water is behind houses and
// trees): an occlusion query wraps the surface's draw in the main pass and is read back a frame later.
const gl = renderer.getContext(), ANY = gl.ANY_SAMPLES_PASSED;
let occQ = null, occActive = false, occPending = false, seen = true;
mesh.onBeforeRender = () => { if (occPending || occActive) return; occQ ??= gl.createQuery(); gl.beginQuery(ANY, occQ); occActive = true; };
mesh.onAfterRender = () => { if (occActive) { gl.endQuery(ANY); occActive = false; occPending = true; } };
```

With water at many levels, the open version mirrors in the plane of the water nearest to you and fades the planar
reflection out on water at other heights and far away. For the code, see `web/src/water.js`.

### Shadows at two scales

A shadow map covers only about 70 to 280 m around you. It follows the camera, centered a little ahead of it, and its
center snaps to whole shadow texels in light space so shadow edges don't crawl as you move. It refreshes every other
frame. For the code, see `updateShadow()` in `web/src/main.js`.

Beyond that box, a valley at dusk would stay sunlit, which matters in the mountains. So `web/src/terrainshadow.js`
ray-marches the heightfield toward the sun once per texel of a top-down visibility texture, over the core and over the
context ring, and every material multiplies its direct sunlight by it. The march runs on the GPU only when the sun
moves, a quarter of the rows per frame, so a still scene pays nothing for it.

### Clouds without per-pixel cost

Kumbalangi raymarched its cumulus into an equirectangular sky texture, a band of rows per frame. A fixed step offset
left stacked horizontal bands in the clouds, and a per-pixel random offset left dots. The fix was temporal
accumulation: each refresh marches at a new offset and blends into the last result with a constant alpha:

**From Kumbalangi** (`web/src/atmosphere.js`):

```js
// temporal accumulation: each refresh of a band marches at a new step offset and blends into the previous result,
// which averages the fixed-step slicing (stacked horizontal bands in the clouds) away over a few refreshes
Object.assign(lutMat, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
  blendSrcAlpha: THREE.ConstantAlphaFactor, blendDstAlpha: THREE.OneMinusConstantAlphaFactor, blendAlpha: 1 });
```

This repository draws a lighter cloud deck straight from a noise texture, and casts its shadows on the ground from
the same projection, so the shadow under a cloud lines up with the cloud overhead. For the code, see
`web/src/atmosphere.js`.

### Occluders first

The largest single gain in this repository came from draw order, not from any shader. three.js sorts opaque objects
by their distance from the camera, but a terrain block and a building chunk are both large, so the sort says little
about which hides which. In a village lane, the terrain and trees behind the houses were being shaded and then
covered. Drawing the buildings first, with `renderOrder = -2`, lets the depth test reject everything behind them
before it's shaded, and the lane's frame time fell from 16.6 ms to 9.4 ms on the integrated GPU. The terrain draws
next and the trees after it. The context ring and the sky draw after all of them, so they're shaded only where
nothing nearer covers them.

### A steady frame rate

Three mechanisms keep the frame inside its budget:

- **Quality presets from the GPU.** The runtime reads the renderer string that WebGL reports and picks `low`, `med`,
  or `high`; `?q=` overrides it.
- **Shaders compiled before the first frame.** `renderer.compileAsync()` compiles every program in parallel where the
  driver supports `KHR_parallel_shader_compile`, including the variants that only the reflection pass uses. The three.js `debug.checkShaderErrors` option serializes every compile, so it stays off unless
  you add `?debug`.
- **A resolution governor.** Vsync caps the frame times that `requestAnimationFrame` reports, so a frame time near
  the refresh interval says nothing about headroom. The governor learns the display's refresh interval, lowers the
  render scale when the median frame misses it, and raises it again only after a long steady stretch.

The governor started in Kumbalangi:

**From Kumbalangi** (`web/src/main.js`):

```js
const sorted = [...perf.samples].sort((a, b) => a - b), p50 = sorted[15];
if (perf.refresh > p50) perf.refresh = Math.max(6.9, p50);    // learn the display's refresh interval
const budget = perf.refresh * 1.18;
let next = dpr;
if (p50 > budget) { next = Math.max(Q.minDpr, dpr * 0.88); perf.hold = 0; }
else if (p50 < perf.refresh * 1.04) { if (++perf.hold > 120) { next = Math.min(Math.min(devicePixelRatio, Q.maxDpr), dpr * 1.07); perf.hold = 0; } }
```

## Measurement

Guesses about GPU cost are usually wrong, so Kumbalangi measured everything. `window.__world.gpuProbe()` in this
repository times frames with `EXT_disjoint_timer_query_webgl2`, once in full and once with each part of the scene
turned off, and returns GPU milliseconds per configuration. Two lessons from Kumbalangi about reading those numbers:

- **Compare A with B, not absolutes.** An integrated GPU shares power and memory with the CPU, so another busy program
  slows it. Alternate the on and off order of each toggle, or warm-up drift biases the results.
- **The browser preview pane can stop animation frames** while a tool drives the page. Advance frames by hand with
  `window.__world.step()` and capture the canvas directly with `window.__world.cap()`, which posts a JPEG to
  `tools/capture_server.py`.

## Smaller lessons

These took the most time to find, and any project like this one can run into them:

- A `//` comment at the end of a one-line GLSL `main()` swallows the closing brace, and the shader fails without an
  error that points at the comment.
- `half` is a reserved word in GLSL ES, so it can't name a function parameter.
- Two chunks of shader code that both declare the same uniform fail to compile. Give shared helpers private uniform
  names, such as `uAtmoNoise`, that alias the same value object.
- three.js `ShaderPass` deep-clones its uniforms, so bind shared uniforms and render-target textures after
  construction.
- Earth Search marks Sentinel-2 items whose reflectance offset it already removed (`earthsearch:boa_offset_applied`),
  but their raster metadata still lists an offset of -0.1. Trust the flag.
- Public Overpass servers share their capacity, and a busy one answers with HTTP 504 for many minutes. Retry each
  mirror with back-off, and cache the result.
