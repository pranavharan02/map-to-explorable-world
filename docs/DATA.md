# Data sources and how each layer is made

Every world is built from four open datasets. None of them needs an account or an API key, and the pipeline caches
each download in `cache/`, so a rebuild never fetches the same data twice.

| Dataset | Used for | Resolution | License |
|---|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/), through the Overpass API | Buildings, building parts, roads, railways, bridges, waterways, water areas, land use, single trees, and place names | Vector | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) |
| [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS (Mapzen and Tilezen) | Elevation for the core and the context ring | About 3 m to 30 m, depending on the source model for that region | Mixed; see [Tilezen attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) |
| [Sentinel-2 L2A](https://registry.opendata.aws/sentinel-2-l2a-cogs/), through the Element 84 Earth Search catalog | Ground color, water detection, and vegetation density | 10 m (20 m for SWIR and the scene classification) | [Copernicus Sentinel data terms](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice) |
| [ESA WorldCover 2021 v200](https://esa-worldcover.org/) | Land-cover classes | 10 m | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

## OpenStreetMap

One Overpass query with `out geom` returns every feature the build needs. Ways carry their own coordinates, and
relations carry their members' geometry, which is how multipolygons such as lakes with islands or buildings with
courtyards are assembled. The query is in `pipeline/fetch/osm.py`.

Public Overpass servers share their capacity between everyone, and a busy server answers with HTTP 429 or 504. The
fetcher retries each of three mirrors with back-off before it gives up, so a busy afternoon can stretch the first
fetch of a world to several minutes. After that, the cached `osm.json` is used.

What becomes of each kind of feature:

- **Buildings** keep their outline and courtyards. Tags fill in height, storeys, roof shape, and colors where
  they exist; see [Buildings](#buildings).
- **Building parts** (`building:part`, from OpenStreetMap's Simple 3D Buildings scheme) replace the outline they sit
  in, so a church tower or a stepped tower block gets its real massing.
- **Roads and railways** become a distance field; see [Roads](#roads). Tunnels and covered ways are skipped.
  Bridges become meshes with piers.
- **Waterways** that are narrower than a satellite pixel, such as streams and ditches, are added to the water mask
  at their tagged or typical width.
- **Land use**, such as forest, parks, farmland, paving, sand, and rock, refines the land-cover weights and the tree
  density.
- **Single trees** (`natural=tree`) and **tree rows** (`natural=tree_row`) are planted where they're mapped.
- **Places, viewpoints, peaks, and landmarks** become map labels, viewpoints, and drone-tour captions.

## Elevation

The pipeline mosaics Terrain Tiles in the terrarium PNG encoding, where each pixel stores
`height = R * 256 + G + B / 256 - 32768` meters. It picks the coarsest zoom whose pixels are no larger than the
heightfield cell, up to zoom 15 for the core and zoom 13 for the context ring.

The tiles merge many source models. Where a national lidar model exists (for example, Austria's DGM or the USGS 3D
Elevation Program), the elevation is a bare-earth model with meter-scale detail. Elsewhere it's usually SRTM, a
30 m surface model in which buildings and tree crowns sit on the ground as bumps.

The build tells the two apart by measuring how far building footprints stand above the ground around them. In a
surface model they read several meters high; in a bare-earth model they read close to zero. When the elevation is a
surface model, a gray opening (an erosion followed by a dilation, 36 m wide) removes the bumps, but only where
buildings or tree cover stand and never on steep ground, where an opening would shave real ridges. A gaussian blur
of 3 m then smooths the 30 m staircase. The code is in `pipeline/build/terrain.py`.

## Water

Sentinel-2 sees open water directly through two indices:

- NDWI compares green with near infrared.
- MNDWI compares green with short-wave infrared, which separates water from wet soil and shadow better.

A pixel is water when the larger index passes a threshold, and either most of its clear observations classify it as
water in the scene-classification band, or the index is high, or WorldCover marks permanent water. Shadowed
mountainsides can pass both indices, so satellite water must also be flat: slopes steeper than 12 degrees are
excluded.

OpenStreetMap adds what a 10 m pixel can't resolve: streams, ditches, and small ponds. Its large water polygons count
only where the satellite doesn't see dense vegetation, because a lake multipolygon can cover an island that the
islands' own polygons don't cut out.

Each connected water body then gets a surface level from the elevation of its own banks. A body whose banks span
less than 3 m, or that covers more than 15% of the core, is flat: a lake or the sea. Any other body is a river, and
its level varies smoothly along it. The terrain is carved below each level into a shelving bed, and the banks are
raised slightly above it, so the renderer's shoreline is where the terrain and the water surface actually meet. Water
bodies that continue into the context ring keep the core's level there, so lakes have no step at the core's edge.
The code is in `pipeline/build/water.py`.

## Roads

Roads and railways are rasterized at twice the mask resolution, turned into a signed distance field (meters to the
nearest road edge, negative on the road), and averaged down. Bilinear filtering of a distance field keeps the edge
sharp at any viewing distance, which a rasterized mask can't do. The surface class (asphalt, setts, or gravel, from
the `highway` and `surface` tags) is spread from each road to the pixels nearest to it.

On a slope, the build levels the terrain across each vehicle road towards a smoothed centerline height, so the road
sits in a cut instead of tilting sideways. The code is in `pipeline/build/roads.py`.

## Ground color and land cover

The satellite color comes from a median of the clearest Sentinel-2 scenes:

1. The fetcher ranks catalog scenes by their cloud fraction inside the world's box, read from each scene's
   scene-classification band. The catalog's own cloud figure covers a whole 110 km tile, which says little about
   one town.
1. For every pixel, the composite takes the median of the clear observations among the four clearest scenes. Any
   pixel that no scene sees without cloud takes the median of all four.
1. Reflectance is mapped to display color with a fixed exposure and a gentle shoulder, so worlds match each other.
1. Roofs are painted out of the color by normalized convolution from the surrounding ground. Otherwise every building
   would stand on a smear of its own roof color.

Land cover is a set of weights for the terrain shader: grass, forest floor, bare ground or rock, farmland, and
paving. WorldCover classes set the starting weights, the vegetation index (NDVI) moves dry pixels from grass towards
bare ground, and OpenStreetMap areas override both where they exist. The code is in `pipeline/build/ground.py`.

## Buildings

Explicit tags always win. Where tags are missing, the build estimates:

- **Kind**, from the `building` value and any `shop`, `amenity`, or `office` tags.
- **Storeys**, from the kind, the footprint area, and how built-up the surroundings are. A 200 m² house in a dense
  old town is taller than the same footprint in a village.
- **Roof shape**, from a regional palette: pitched roofs dominate in Europe, and flat slabs in South Asia and the
  Gulf. Large or tall buildings get flat roofs.
- **Roof color**, from the Sentinel-2 pixels inside the footprint, trusted more the larger the roof.
- **Wall color**, from the regional palette.

The code is in `pipeline/build/buildings.py`.

## Trees

Canopy probability comes from WorldCover, graded by NDVI, and raised by OpenStreetMap forests, parks, and orchards.
The build plants on a jittered 3 m grid, so a fully wooded hectare gets about 270 trees. Species follow the biome and
the elevation (conifers take over higher up in temperate and boreal regions), and an OpenStreetMap forest's
`leaf_type` wins inside it. Nothing grows on roads, paving, water, buildings, slopes steeper than 48 degrees, or above
the tree line. The context ring gets impostor-only trees out to about 1.9 km beyond the core. The code is in
`pipeline/build/trees.py`.

## Attribution

A world you build carries the obligations of its sources. The runtime shows the credits from `world.json` on the
intro sheet. When you publish a world or a screenshot of one, include at least:

- © OpenStreetMap contributors, available under the Open Database License.
- Contains modified Copernicus Sentinel-2 data, with the year of the scenes.
- ESA WorldCover 2021 (CC BY 4.0).
- The elevation sources for your region, from the Tilezen attribution list.

A world package is a derived database of OpenStreetMap data. If you distribute the package itself, distribute it
under the ODbL. Screenshots and videos are produced works, which need the attribution only.
