# routeForge
Stl generator for map routes

## Current workflow

Run:

```bash
python gpx_to_stl.py --gpx stcuthbertsway.gpx
```

Examples:

```bash
# Override model dimensions
python gpx_to_stl.py --gpx stcuthbertsway.gpx --width 120 --height 60

# Adjust terrain geometry controls
python gpx_to_stl.py --gpx stcuthbertsway.gpx --vertical-exag 8 --grid-res 250 --margin-frac 0.25
```

Configuration is now in the top settings block of `gpx_to_stl.py`:

- `GPX_FILE`: default GPX file used when `--gpx` is omitted.
- Top-level dimensional and geometry constants are defaults that can be overridden from CLI.

Named flags available:

- `--gpx`
- `--width`
- `--height`
- `--base-thickness`
- `--ridge-height`
- `--ridge-width`
- `--vertical-exag`
- `--grid-res`
- `--margin-frac`

For each GPX input, the script creates a dedicated artifact folder named after the GPX stem:

- `<gpx_stem>/elevation_cache.npy`
- `<gpx_stem>/elevation_cache_meta.json`
- `<gpx_stem>/<gpx_stem>_terrain_v1.stl`, `_v2.stl`, ...

Elevation data is reused from cache and only re-downloaded when any cache key value changes, including:

- GPX file identity (path, size, or mtime)
- `PRINT_WIDTH_MM`
- `PRINT_HEIGHT_MM`
- `MARGIN_FRAC`
- computed grid/bbox parameters

## OpenElevation request cap

The script enforces a fixed OpenElevation budget of:

- 25 HTTP requests maximum
- 400 points per request

If your requested grid would exceed this cap, the script automatically reduces
grid density while preserving the aspect ratio, then continues.

## React web interface (in progress)

A React + TypeScript frontend now exists in `web/` as the starting point for
GitHub Pages hosting.

Current MVP features:

- Upload GPX file in browser
- Adjust generation parameters
- Dynamic 2D route and fitted-bounds preview
- Live effective grid/request estimate with 25 x 400 budget rules
- Browser-side STL generation and download from uploaded GPX route

Run locally:

```bash
cd web
npm install
npm run dev
```

Build for production:

```bash
cd web
npm run build
```

Deploy to GitHub Pages:

```bash
cd web
npm run deploy
```
