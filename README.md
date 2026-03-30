# routeForge
Stl generator for map routes

## Current workflow

Run:

```bash
python gpx_to_stl.py [optional_path_to_file.gpx]
```

Configuration is now in the top settings block of `gpx_to_stl.py`:

- `GPX_FILE`: default GPX file used when no CLI argument is passed.
- `ALLOW_CLI_GPX_OVERRIDE`: if `True`, `argv[1]` overrides `GPX_FILE`.

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
