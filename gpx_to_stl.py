"""
gpx_to_stl.py
-------------
Generates a 3D-printable STL terrain model from a GPX route file.
Uses free SRTM 90m elevation data. No account required.

Dependencies:
    pip install gpxpy numpy scipy numpy-stl requests

Usage:
    python gpx_to_stl.py --gpx stcuthbertsway.gpx [--width 120 --height 60]

Output:
    <gpx_stem>/<gpx_stem>_terrain_vN.stl

Cache:
    <gpx_stem>/elevation_cache.npy
    <gpx_stem>/elevation_cache_meta.json

Settings (edit below):
    GPX_FILE            : Default GPX file path (used when --gpx is omitted)
    PRINT_WIDTH_MM      : X dimension of print bed footprint
    PRINT_HEIGHT_MM     : Y dimension of print bed footprint
    BASE_THICKNESS_MM   : Solid base below lowest terrain point
    VERTICAL_EXAG       : Vertical exaggeration factor
    GRID_RESOLUTION     : Number of grid cells along the longer axis
    ROUTE_RIDGE_HEIGHT  : Height of embossed route ridge above terrain (mm)
    ROUTE_RIDGE_WIDTH_MM: Width of embossed route ridge (mm)
    MARGIN_FRAC         : Fractional margin around route bounding box
"""

import sys
import os
import math
import json
import argparse
import numpy as np
from scipy.ndimage import gaussian_filter
from stl import mesh as stl_mesh
import gpxpy
import gpxpy.gpx

# ── User settings ──────────────────────────────────────────────────────────────
PRINT_WIDTH_MM       = 100.0   # mm, X axis
PRINT_HEIGHT_MM      = 100.0    # mm, Y axis
BASE_THICKNESS_MM    = 3.0     # mm, solid base
VERTICAL_EXAG        = 6.0    # vertical exaggeration
GRID_RESOLUTION      = 200     # cells along longer axis
ROUTE_RIDGE_HEIGHT   = 6.0     # mm above terrain surface
ROUTE_RIDGE_WIDTH_MM = 3.0     # mm, full width of ridge
MARGIN_FRAC          = 0.2     # margin around route bbox
GPX_FILE             = "stcuthbertsway.gpx"  # default GPX input
# ──────────────────────────────────────────────────────────────────────────────


def sanitise_name(name):
    clean = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in name)
    clean = clean.strip("_")
    return clean or "route"


def positive_float(value):
    num = float(value)
    if num <= 0:
        raise argparse.ArgumentTypeError("value must be > 0")
    return num


def non_negative_float(value):
    num = float(value)
    if num < 0:
        raise argparse.ArgumentTypeError("value must be >= 0")
    return num


def min_int(min_value):
    def _validator(value):
        num = int(value)
        if num < min_value:
            raise argparse.ArgumentTypeError(f"value must be >= {min_value}")
        return num
    return _validator


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Generate a 3D-printable STL terrain model from GPX route data."
    )
    parser.add_argument("--gpx", default=GPX_FILE, help="Path to GPX input file")

    parser.add_argument("--width", type=positive_float, default=PRINT_WIDTH_MM,
                        help=f"Print width in mm (default: {PRINT_WIDTH_MM})")
    parser.add_argument("--height", type=positive_float, default=PRINT_HEIGHT_MM,
                        help=f"Print height in mm (default: {PRINT_HEIGHT_MM})")
    parser.add_argument("--base-thickness", type=positive_float, default=BASE_THICKNESS_MM,
                        help=f"Base thickness in mm (default: {BASE_THICKNESS_MM})")
    parser.add_argument("--ridge-height", type=non_negative_float, default=ROUTE_RIDGE_HEIGHT,
                        help=f"Embossed route ridge height in mm (default: {ROUTE_RIDGE_HEIGHT})")
    parser.add_argument("--ridge-width", type=positive_float, default=ROUTE_RIDGE_WIDTH_MM,
                        help=f"Embossed route ridge width in mm (default: {ROUTE_RIDGE_WIDTH_MM})")

    parser.add_argument("--vertical-exag", type=positive_float, default=VERTICAL_EXAG,
                        help=f"Vertical exaggeration factor (default: {VERTICAL_EXAG})")
    parser.add_argument("--grid-res", type=min_int(4), default=GRID_RESOLUTION,
                        help=f"Grid cells on longer axis (default: {GRID_RESOLUTION})")
    parser.add_argument("--margin-frac", type=non_negative_float, default=MARGIN_FRAC,
                        help=f"Fractional route margin around bbox (default: {MARGIN_FRAC})")

    return parser.parse_args(argv[1:])


def get_artifact_paths(gpx_path):
    abs_gpx = os.path.abspath(gpx_path)
    stem = os.path.splitext(os.path.basename(abs_gpx))[0]
    artifact_dir = os.path.join(os.path.dirname(abs_gpx), sanitise_name(stem))
    os.makedirs(artifact_dir, exist_ok=True)
    return {
        "gpx_abs": abs_gpx,
        "stem": stem,
        "artifact_dir": artifact_dir,
        "cache_npy": os.path.join(artifact_dir, "elevation_cache.npy"),
        "cache_meta": os.path.join(artifact_dir, "elevation_cache_meta.json"),
    }


def next_versioned_stl_path(artifact_dir, stem):
    prefix = f"{stem}_terrain_v"
    max_version = 0
    for file_name in os.listdir(artifact_dir):
        if not (file_name.startswith(prefix) and file_name.endswith(".stl")):
            continue
        number = file_name[len(prefix):-4]
        if number.isdigit():
            max_version = max(max_version, int(number))
    next_version = max_version + 1
    out_name = f"{stem}_terrain_v{next_version}.stl"
    return os.path.join(artifact_dir, out_name), next_version


def build_cache_metadata(gpx_abs, lat_min, lat_max, lon_min, lon_max, nx, ny,
                         print_width_mm, print_height_mm, margin_frac):
    gpx_stat = os.stat(gpx_abs)
    return {
        "gpx_path": gpx_abs,
        "gpx_size": int(gpx_stat.st_size),
        "gpx_mtime_ns": int(gpx_stat.st_mtime_ns),
        "print_width_mm": float(print_width_mm),
        "print_height_mm": float(print_height_mm),
        "margin_frac": float(margin_frac),
        "nx": int(nx),
        "ny": int(ny),
        "lat_min": round(float(lat_min), 8),
        "lat_max": round(float(lat_max), 8),
        "lon_min": round(float(lon_min), 8),
        "lon_max": round(float(lon_max), 8),
    }


def explain_cache_miss(cached_meta, expected_meta):
    changed = [key for key, value in expected_meta.items() if cached_meta.get(key) != value]
    if not changed:
        return "cache metadata mismatch"
    return "settings changed: " + ", ".join(changed)


def load_or_fetch_elevation(cache_npy, cache_meta, expected_meta):
    if os.path.exists(cache_npy) and os.path.exists(cache_meta):
        try:
            with open(cache_meta, "r", encoding="utf-8") as fh:
                cached_meta = json.load(fh)
            if cached_meta == expected_meta:
                elev = np.load(cache_npy)
                if elev.shape == (expected_meta["ny"], expected_meta["nx"]):
                    print(f"  Cache hit: {cache_npy}")
                    return elev
                print("  Cache miss: cached elevation shape does not match expected grid")
            else:
                print(f"  Cache miss: {explain_cache_miss(cached_meta, expected_meta)}")
        except Exception as exc:
            print(f"  Cache miss: failed to read cache ({exc})")
    else:
        print("  Cache miss: no cache files found")

    elev = fetch_srtm_elevation(
        expected_meta["lat_min"],
        expected_meta["lat_max"],
        expected_meta["lon_min"],
        expected_meta["lon_max"],
        expected_meta["nx"],
        expected_meta["ny"],
    )
    np.save(cache_npy, elev)
    with open(cache_meta, "w", encoding="utf-8") as fh:
        json.dump(expected_meta, fh, indent=2, sort_keys=True)
    print(f"  Cached elevation grid: {cache_npy}")
    return elev


def parse_gpx(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        gpx = gpxpy.parse(f)
    points = []
    for track in gpx.tracks:
        for segment in track.segments:
            for pt in segment.points:
                points.append((pt.latitude, pt.longitude))
    if not points:
        for route in gpx.routes:
            for pt in route.points:
                points.append((pt.latitude, pt.longitude))
    return points


def compute_bbox(points, margin_frac):
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    lat_span = max(lats) - min(lats)
    lon_span = max(lons) - min(lons)
    margin_lat = lat_span * margin_frac
    margin_lon = lon_span * margin_frac
    return (
        min(lats) - margin_lat,
        max(lats) + margin_lat,
        min(lons) - margin_lon,
        max(lons) + margin_lon,
    )


def fit_bbox_to_print_aspect(lat_min, lat_max, lon_min, lon_max, print_w_mm, print_h_mm):
    """
    Expand only the non-limiting geographic axis so the bbox aspect matches
    print aspect (width/height) without distorting route/elevation scale.
    """
    lat_span = lat_max - lat_min
    lon_span = lon_max - lon_min
    if lat_span <= 0 or lon_span <= 0:
        raise ValueError("Invalid bbox spans; GPX route must cover non-zero area")

    mid_lat = (lat_min + lat_max) / 2.0
    cos_lat = max(0.01, abs(math.cos(math.radians(mid_lat))))
    current_aspect = (lon_span * cos_lat) / lat_span
    target_aspect = print_w_mm / print_h_mm

    if current_aspect > target_aspect:
        # Too wide for print aspect: keep longitude scale, add latitude padding.
        new_lat_span = (lon_span * cos_lat) / target_aspect
        d_lat = (new_lat_span - lat_span) / 2.0
        lat_min -= d_lat
        lat_max += d_lat
        fit_mode = "expanded latitude"
    elif current_aspect < target_aspect:
        # Too tall/narrow for print aspect: keep latitude scale, add longitude padding.
        new_lon_span = (lat_span * target_aspect) / cos_lat
        d_lon = (new_lon_span - lon_span) / 2.0
        lon_min -= d_lon
        lon_max += d_lon
        fit_mode = "expanded longitude"
    else:
        fit_mode = "aspect already matched"

    return lat_min, lat_max, lon_min, lon_max, fit_mode


def fetch_srtm_elevation(lat_min, lat_max, lon_min, lon_max, nx, ny):
    """
    Fetch SRTM 90m elevation data via the Open Elevation API (free, no key).
    Falls back to local 'elevation' library if available.
    Returns a 2D numpy array (ny rows, nx cols), lat descending.
    """
    # Try Open Elevation API in batches
    import requests

    lats = np.linspace(lat_max, lat_min, ny)   # descending so row 0 = north
    lons = np.linspace(lon_min, lon_max, nx)
    grid_lons, grid_lats = np.meshgrid(lons, lats)

    flat_lats = grid_lats.ravel()
    flat_lons = grid_lons.ravel()
    elevations = np.zeros(len(flat_lats), dtype=float)

    batch = 400   # Open Elevation accepts up to 512 per POST
    url = "https://api.open-elevation.com/api/v1/lookup"
    print(f"Fetching {len(flat_lats)} elevation points in batches of {batch}...")

    for i in range(0, len(flat_lats), batch):
        bl = flat_lats[i:i+batch]
        blo = flat_lons[i:i+batch]
        locations = [{"latitude": float(la), "longitude": float(lo)}
                     for la, lo in zip(bl, blo)]
        resp = requests.post(url, json={"locations": locations}, timeout=60)
        resp.raise_for_status()
        results = resp.json()["results"]
        for j, r in enumerate(results):
            elevations[i + j] = r["elevation"] if r["elevation"] is not None else 0.0
        print(f"  {min(i+batch, len(flat_lats))}/{len(flat_lats)} done")

    return elevations.reshape(ny, nx)


def route_to_grid_coords(route_pts, lat_min, lat_max, lon_min, lon_max, nx, ny):
    """Convert route lat/lon to fractional grid indices (row, col)."""
    coords = []
    for lat, lon in route_pts:
        col = (lon - lon_min) / (lon_max - lon_min) * (nx - 1)
        row = (lat_max - lat) / (lat_max - lat_min) * (ny - 1)  # row 0 = north
        coords.append((row, col))
    return coords


def rasterise_route(route_grid_coords, ny, nx, ridge_width_px):
    """
    Rasterise the route onto a float mask. Values are 1.0 on the route,
    tapering to 0 at ridge_width_px/2. Uses anti-aliased line drawing.
    """
    mask = np.zeros((ny, nx), dtype=float)
    half = ridge_width_px / 2.0

    for i in range(len(route_grid_coords) - 1):
        r0, c0 = route_grid_coords[i]
        r1, c1 = route_grid_coords[i + 1]
        length = math.hypot(r1 - r0, c1 - c0)
        steps = max(int(length * 4), 1)
        for s in range(steps + 1):
            t = s / steps
            r = r0 + t * (r1 - r0)
            c = c0 + t * (c1 - c0)
            ri, ci = int(round(r)), int(round(c))
            # paint a small square of influence
            rr = int(math.ceil(half))
            for dr in range(-rr, rr + 1):
                for dc in range(-rr, rr + 1):
                    nr_, nc_ = ri + dr, ci + dc
                    if 0 <= nr_ < ny and 0 <= nc_ < nx:
                        dist = math.hypot(dr, dc)
                        val = max(0.0, 1.0 - dist / half)
                        if val > mask[nr_, nc_]:
                            mask[nr_, nc_] = val
    return mask


def build_height_grid(elev, route_mask, vertical_exag,
                      print_w, print_h, base_mm, ridge_h_mm):
    """
    Combine terrain elevation and route mask into final Z height array (mm).
    Returns z_mm array shape (ny, nx).
    """
    ny, nx = elev.shape

    # Normalise elevation to mm
    e_min = elev.min()
    e_max = elev.max()
    e_range = e_max - e_min if e_max > e_min else 1.0

    # Available Z for terrain after base
    # Scale so vertical exaggeration is relative to the shorter print dimension
    shorter_dim = min(print_w, print_h)
    terrain_z_range = shorter_dim * 0.3 * vertical_exag / 10.0
    # Clamp to something sensible
    terrain_z_range = min(terrain_z_range, shorter_dim * 0.8)

    terrain_mm = (elev - e_min) / e_range * terrain_z_range

    # Add route ridge on top
    z_mm = base_mm + terrain_mm + route_mask * ridge_h_mm

    return z_mm


def build_stl_from_heightmap(z_mm, print_w_mm, print_h_mm):
    """
    Build a watertight STL mesh from a 2D heightmap.
    Includes top surface, four walls, and flat base.
    Returns numpy-stl mesh object.
    """
    ny, nx = z_mm.shape
    dx = print_w_mm / (nx - 1)
    dy = print_h_mm / (ny - 1)

    # Build vertex grid
    x = np.linspace(0, print_w_mm, nx)
    y = np.linspace(0, print_h_mm, ny)   # y=0 corresponds to row ny-1 (south)
    xx, yy = np.meshgrid(x, y)
    # Row 0 in z_mm is north (lat_max); we want y=print_h at north
    # Flip rows so y increases northward
    zz = z_mm[::-1, :]

    triangles = []

    # ── Top surface ────────────────────────────────────────────────────────────
    for row in range(ny - 1):
        for col in range(nx - 1):
            # Two triangles per quad
            v00 = np.array([xx[row,   col],   yy[row,   col],   zz[row,   col]])
            v10 = np.array([xx[row+1, col],   yy[row+1, col],   zz[row+1, col]])
            v01 = np.array([xx[row,   col+1], yy[row,   col+1], zz[row,   col+1]])
            v11 = np.array([xx[row+1, col+1], yy[row+1, col+1], zz[row+1, col+1]])
            triangles.append([v00, v01, v10])
            triangles.append([v01, v11, v10])

    # ── Base (z=0) ─────────────────────────────────────────────────────────────
    for row in range(ny - 1):
        for col in range(nx - 1):
            b00 = np.array([xx[row,   col],   yy[row,   col],   0.0])
            b10 = np.array([xx[row+1, col],   yy[row+1, col],   0.0])
            b01 = np.array([xx[row,   col+1], yy[row,   col+1], 0.0])
            b11 = np.array([xx[row+1, col+1], yy[row+1, col+1], 0.0])
            triangles.append([b00, b10, b01])
            triangles.append([b01, b10, b11])

    # ── Walls ──────────────────────────────────────────────────────────────────
    def wall_strip(edge_row, edge_col_range, axis):
        """Generic wall builder along an edge."""
        pass

    # South wall (y=0, row=0 after flip)
    for col in range(nx - 1):
        x0, x1 = xx[0, col], xx[0, col+1]
        z0, z1 = zz[0, col], zz[0, col+1]
        y0 = yy[0, col]
        triangles.append([
            [x0, y0, 0], [x1, y0, 0], [x0, y0, z0]
        ])
        triangles.append([
            [x1, y0, 0], [x1, y0, z1], [x0, y0, z0]
        ])

    # North wall (y=print_h, row=ny-1 after flip)
    for col in range(nx - 1):
        x0, x1 = xx[ny-1, col], xx[ny-1, col+1]
        z0, z1 = zz[ny-1, col], zz[ny-1, col+1]
        yn = yy[ny-1, col]
        triangles.append([
            [x0, yn, z0], [x1, yn, 0], [x0, yn, 0]
        ])
        triangles.append([
            [x0, yn, z0], [x1, yn, z1], [x1, yn, 0]
        ])

    # West wall (x=0, col=0)
    for row in range(ny - 1):
        y0, y1 = yy[row, 0], yy[row+1, 0]
        z0, z1 = zz[row, 0], zz[row+1, 0]
        xw = xx[row, 0]
        triangles.append([
            [xw, y0, z0], [xw, y0, 0], [xw, y1, 0]
        ])
        triangles.append([
            [xw, y0, z0], [xw, y1, 0], [xw, y1, z1]
        ])

    # East wall (x=print_w, col=nx-1)
    for row in range(ny - 1):
        y0, y1 = yy[row, nx-1], yy[row+1, nx-1]
        z0, z1 = zz[row, nx-1], zz[row+1, nx-1]
        xe = xx[row, nx-1]
        triangles.append([
            [xe, y0, 0], [xe, y0, z0], [xe, y1, 0]
        ])
        triangles.append([
            [xe, y1, 0], [xe, y0, z0], [xe, y1, z1]
        ])

    triangles = np.array(triangles, dtype=np.float32)
    n_tris = len(triangles)
    print(f"Building STL with {n_tris:,} triangles...")

    solid = stl_mesh.Mesh(np.zeros(n_tris, dtype=stl_mesh.Mesh.dtype))
    for i, tri in enumerate(triangles):
        solid.vectors[i] = tri
    solid.update_normals()
    return solid


def main():
    args = parse_args(sys.argv)

    gpx_path = args.gpx
    print_width_mm = args.width
    print_height_mm = args.height
    base_thickness_mm = args.base_thickness
    vertical_exag = args.vertical_exag
    grid_resolution = args.grid_res
    route_ridge_height = args.ridge_height
    route_ridge_width_mm = args.ridge_width
    margin_frac = args.margin_frac

    artifacts = get_artifact_paths(gpx_path)
    out_path, version = next_versioned_stl_path(artifacts["artifact_dir"], artifacts["stem"])

    if not os.path.exists(artifacts["gpx_abs"]):
        raise FileNotFoundError(f"GPX file not found: {artifacts['gpx_abs']}")

    print(f"Using GPX: {artifacts['gpx_abs']}")
    print(f"Artifact directory: {artifacts['artifact_dir']}")

    print("Parsing GPX...")
    route_pts = parse_gpx(artifacts["gpx_abs"])
    if not route_pts:
        raise ValueError("No track or route points found in GPX file")
    print(f"  {len(route_pts)} track points")

    lat_min, lat_max, lon_min, lon_max = compute_bbox(route_pts, margin_frac)
    print(f"  Route+margin bbox: lat {lat_min:.4f}–{lat_max:.4f}, "
          f"lon {lon_min:.4f}–{lon_max:.4f}")

    lat_min, lat_max, lon_min, lon_max, fit_mode = fit_bbox_to_print_aspect(
        lat_min, lat_max, lon_min, lon_max, print_width_mm, print_height_mm
    )
    print(f"  Aspect-fitted bbox ({fit_mode}): lat {lat_min:.4f}–{lat_max:.4f}, "
          f"lon {lon_min:.4f}–{lon_max:.4f}")

    # Compute grid dimensions from fitted bbox.
    # 1 deg lat ≈ 111 km; 1 deg lon ≈ 111 km * cos(lat)
    mid_lat = (lat_min + lat_max) / 2.0
    lat_km = (lat_max - lat_min) * 111.0
    lon_km = (lon_max - lon_min) * 111.0 * max(0.01, abs(math.cos(math.radians(mid_lat))))
    aspect = lon_km / lat_km

    if aspect >= 1:
        nx = grid_resolution
        ny = max(4, int(round(grid_resolution / aspect)))
    else:
        ny = grid_resolution
        nx = max(4, int(round(grid_resolution * aspect)))

    print(f"  Grid: {nx} × {ny} (cols × rows)")

    print("Loading cached elevation data or fetching from Open Elevation API...")
    expected_meta = build_cache_metadata(
        artifacts["gpx_abs"], lat_min, lat_max, lon_min, lon_max, nx, ny,
        print_width_mm, print_height_mm, margin_frac
    )
    elev = load_or_fetch_elevation(
        artifacts["cache_npy"], artifacts["cache_meta"], expected_meta
    )
    print(f"  Elevation range: {elev.min():.0f}–{elev.max():.0f} m")

    # Smooth slightly to reduce SRTM artefacts
    elev = gaussian_filter(elev, sigma=1.0)

    print("Rasterising route...")
    route_grid = route_to_grid_coords(
        route_pts, lat_min, lat_max, lon_min, lon_max, nx, ny
    )
    # Convert ridge width from mm to pixels
    px_per_mm_x = (nx - 1) / print_width_mm
    ridge_px = route_ridge_width_mm * px_per_mm_x
    route_mask = rasterise_route(route_grid, ny, nx, ridge_px)

    print("Building height grid...")
    z_mm = build_height_grid(
        elev, route_mask, vertical_exag,
        print_width_mm, print_height_mm,
        base_thickness_mm, route_ridge_height
    )
    print(f"  Z range: {z_mm.min():.2f}–{z_mm.max():.2f} mm")

    print("Building STL mesh...")
    solid = build_stl_from_heightmap(z_mm, print_width_mm, print_height_mm)

    print(f"Saving {out_path}...")
    solid.save(out_path)
    print("Done.")
    print(f"  Output version: v{version}")
    print(f"\nPrint dimensions: {print_width_mm} × {print_height_mm} × "
          f"{z_mm.max():.1f} mm (W × H × Z)")


if __name__ == "__main__":
    main()