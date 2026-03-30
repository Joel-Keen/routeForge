import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { gpx as toGeoJsonGpx } from '@tmcw/togeojson'
import {
  MapContainer,
  Polyline,
  Rectangle,
  TileLayer,
  useMap,
} from 'react-leaflet'
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet'
import './App.css'

type Point = {
  lat: number
  lon: number
}

type Params = {
  width: number
  height: number
  base: number
  verticalExag: number
  gridRes: number
  ridgeHeight: number
  ridgeWidth: number
  marginFrac: number
}

const DEFAULT_PARAMS: Params = {
  width: 100,
  height: 100,
  base: 3,
  verticalExag: 6,
  gridRes: 200,
  ridgeHeight: 6,
  ridgeWidth: 3,
  marginFrac: 0.2,
}

const BATCH_SIZE = 400
const MAX_REQUESTS = 25

type PreviewModel = {
  routeBounds: LatLngBoundsExpression
  fittedBounds: LatLngBoundsExpression
  polyline: LatLngExpression[]
  grid: {
    nx: number
    ny: number
    requestedCalls: number
    effectiveCalls: number
    adjusted: boolean
  }
  fittedGeo: {
    latMin: number
    latMax: number
    lonMin: number
    lonMax: number
  }
}

function fitBoundsToAspect(
  latMin: number,
  latMax: number,
  lonMin: number,
  lonMax: number,
  width: number,
  height: number,
): { latMin: number; latMax: number; lonMin: number; lonMax: number } {
  const latSpan = latMax - latMin
  const lonSpan = lonMax - lonMin
  const midLat = (latMin + latMax) / 2
  const cosLat = Math.max(0.01, Math.abs(Math.cos((midLat * Math.PI) / 180)))
  const currentAspect = (lonSpan * cosLat) / latSpan
  const targetAspect = width / height

  if (currentAspect > targetAspect) {
    const newLatSpan = (lonSpan * cosLat) / targetAspect
    const dLat = (newLatSpan - latSpan) / 2
    return { latMin: latMin - dLat, latMax: latMax + dLat, lonMin, lonMax }
  }

  if (currentAspect < targetAspect) {
    const newLonSpan = (latSpan * targetAspect) / cosLat
    const dLon = (newLonSpan - lonSpan) / 2
    return { latMin, latMax, lonMin: lonMin - dLon, lonMax: lonMax + dLon }
  }

  return { latMin, latMax, lonMin, lonMax }
}

function estimateEffectiveGrid(gridRes: number, aspect: number) {
  let nx = aspect >= 1 ? gridRes : Math.max(4, Math.round(gridRes * aspect))
  let ny = aspect >= 1 ? Math.max(4, Math.round(gridRes / aspect)) : gridRes

  const requestedCalls = Math.ceil((nx * ny) / BATCH_SIZE)
  if (requestedCalls <= MAX_REQUESTS) {
    return { nx, ny, requestedCalls, effectiveCalls: requestedCalls, adjusted: false }
  }

  const maxPoints = BATCH_SIZE * MAX_REQUESTS
  const scale = Math.sqrt(maxPoints / (nx * ny))
  nx = Math.max(4, Math.floor(nx * scale))
  ny = Math.max(4, Math.floor(ny * scale))

  const axisAspect = nx / ny
  while (Math.ceil((nx * ny) / BATCH_SIZE) > MAX_REQUESTS) {
    if (nx >= ny && nx > 4) {
      nx -= 1
      ny = Math.max(4, Math.round(nx / axisAspect))
    } else if (ny > 4) {
      ny -= 1
      nx = Math.max(4, Math.round(ny * axisAspect))
    } else {
      break
    }
  }

  return {
    nx,
    ny,
    requestedCalls,
    effectiveCalls: Math.ceil((nx * ny) / BATCH_SIZE),
    adjusted: true,
  }
}

function parseGpxPoints(xmlText: string): Point[] {
  const parser = new DOMParser()
  const xml = parser.parseFromString(xmlText, 'application/xml')
  const geoJson = toGeoJsonGpx(xml) as any
  const points: Point[] = []

  for (const feature of geoJson.features ?? []) {
    const geometry = feature.geometry
    if (!geometry) continue

    if (geometry.type === 'LineString') {
      for (const coord of geometry.coordinates) {
        points.push({ lat: coord[1], lon: coord[0] })
      }
    }

    if (geometry.type === 'MultiLineString') {
      for (const line of geometry.coordinates) {
        for (const coord of line) {
          points.push({ lat: coord[1], lon: coord[0] })
        }
      }
    }
  }

  return points
}

function tri(lines: string[], a: [number, number, number], b: [number, number, number], c: [number, number, number]) {
  lines.push('  facet normal 0 0 0')
  lines.push('    outer loop')
  lines.push(`      vertex ${a[0]} ${a[1]} ${a[2]}`)
  lines.push(`      vertex ${b[0]} ${b[1]} ${b[2]}`)
  lines.push(`      vertex ${c[0]} ${c[1]} ${c[2]}`)
  lines.push('    endloop')
  lines.push('  endfacet')
}

function generateRouteStl(points: Point[], params: Params, preview: PreviewModel): string {
  const { nx, ny } = preview.grid
  const { latMin, latMax, lonMin, lonMax } = preview.fittedGeo

  const top = new Float32Array(nx * ny)
  const minDist2 = new Float32Array(nx * ny)
  minDist2.fill(Number.POSITIVE_INFINITY)

  const lonSpan = Math.max(1e-9, lonMax - lonMin)
  const latSpan = Math.max(1e-9, latMax - latMin)

  const toGrid = (p: Point): [number, number] => {
    const gx = ((p.lon - lonMin) / lonSpan) * (nx - 1)
    const gy = ((latMax - p.lat) / latSpan) * (ny - 1)
    return [gx, gy]
  }

  const gridPts = points.map(toGrid)
  const cellX = params.width / Math.max(1, nx - 1)
  const cellY = params.height / Math.max(1, ny - 1)
  const meanCell = (cellX + cellY) * 0.5
  const ridgeRadius = Math.max(1, (params.ridgeWidth * 0.5) / Math.max(1e-6, meanCell))
  const kernelRadius = Math.max(2, Math.ceil(ridgeRadius * 2.2))
  const sigma = Math.max(0.8, ridgeRadius * 0.6)
  const sigma2 = sigma * sigma

  for (let i = 0; i < gridPts.length - 1; i += 1) {
    const [x0, y0] = gridPts[i]
    const [x1, y1] = gridPts[i + 1]
    const dx = x1 - x0
    const dy = y1 - y0
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2))

    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps
      const x = x0 + dx * t
      const y = y0 + dy * t
      const ix0 = Math.max(0, Math.floor(x - kernelRadius))
      const ix1 = Math.min(nx - 1, Math.ceil(x + kernelRadius))
      const iy0 = Math.max(0, Math.floor(y - kernelRadius))
      const iy1 = Math.min(ny - 1, Math.ceil(y + kernelRadius))

      for (let iy = iy0; iy <= iy1; iy += 1) {
        for (let ix = ix0; ix <= ix1; ix += 1) {
          const ddx = ix - x
          const ddy = iy - y
          const d2 = ddx * ddx + ddy * ddy
          const idx = iy * nx + ix
          if (d2 < minDist2[idx]) minDist2[idx] = d2
        }
      }
    }
  }

  const ridgeScale = Math.max(0.1, params.verticalExag / 6)
  for (let i = 0; i < top.length; i += 1) {
    const d2 = minDist2[i]
    const ridge = d2 < Number.POSITIVE_INFINITY ? params.ridgeHeight * ridgeScale * Math.exp(-d2 / (2 * sigma2)) : 0
    top[i] = params.base + ridge
  }

  const vertexTop = (ix: number, iy: number): [number, number, number] => {
    const x = (ix / Math.max(1, nx - 1)) * params.width
    const y = (iy / Math.max(1, ny - 1)) * params.height
    const z = top[iy * nx + ix]
    return [x, y, z]
  }

  const lines: string[] = ['solid routeforge']

  for (let iy = 0; iy < ny - 1; iy += 1) {
    for (let ix = 0; ix < nx - 1; ix += 1) {
      const v00 = vertexTop(ix, iy)
      const v10 = vertexTop(ix + 1, iy)
      const v11 = vertexTop(ix + 1, iy + 1)
      const v01 = vertexTop(ix, iy + 1)
      tri(lines, v00, v10, v11)
      tri(lines, v00, v11, v01)
    }
  }

  tri(lines, [0, 0, 0], [params.width, params.height, 0], [params.width, 0, 0])
  tri(lines, [0, 0, 0], [0, params.height, 0], [params.width, params.height, 0])

  for (let ix = 0; ix < nx - 1; ix += 1) {
    const t0 = vertexTop(ix, 0)
    const t1 = vertexTop(ix + 1, 0)
    tri(lines, [t0[0], t0[1], 0], [t1[0], t1[1], 0], t1)
    tri(lines, [t0[0], t0[1], 0], t1, t0)
  }
  for (let ix = 0; ix < nx - 1; ix += 1) {
    const t0 = vertexTop(ix, ny - 1)
    const t1 = vertexTop(ix + 1, ny - 1)
    tri(lines, [t0[0], t0[1], 0], t1, [t1[0], t1[1], 0])
    tri(lines, [t0[0], t0[1], 0], t0, t1)
  }
  for (let iy = 0; iy < ny - 1; iy += 1) {
    const t0 = vertexTop(0, iy)
    const t1 = vertexTop(0, iy + 1)
    tri(lines, [t0[0], t0[1], 0], t0, t1)
    tri(lines, [t0[0], t0[1], 0], t1, [t1[0], t1[1], 0])
  }
  for (let iy = 0; iy < ny - 1; iy += 1) {
    const t0 = vertexTop(nx - 1, iy)
    const t1 = vertexTop(nx - 1, iy + 1)
    tri(lines, [t0[0], t0[1], 0], t1, t0)
    tri(lines, [t0[0], t0[1], 0], [t1[0], t1[1], 0], t1)
  }

  lines.push('endsolid routeforge')
  return lines.join('\n')
}

function FitToBounds({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap()
  if (bounds) {
    map.fitBounds(bounds, { padding: [24, 24] })
  }
  return null
}

function App() {
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS)
  const [fileName, setFileName] = useState('')
  const [points, setPoints] = useState<Point[]>([])
  const [error, setError] = useState('')

  const preview = useMemo<PreviewModel | null>(() => {
    if (points.length === 0) return null

    const lats = points.map((p) => p.lat)
    const lons = points.map((p) => p.lon)
    const routeLatMin = Math.min(...lats)
    const routeLatMax = Math.max(...lats)
    const routeLonMin = Math.min(...lons)
    const routeLonMax = Math.max(...lons)

    const marginLat = (routeLatMax - routeLatMin) * params.marginFrac
    const marginLon = (routeLonMax - routeLonMin) * params.marginFrac

    const padded = {
      latMin: routeLatMin - marginLat,
      latMax: routeLatMax + marginLat,
      lonMin: routeLonMin - marginLon,
      lonMax: routeLonMax + marginLon,
    }

    const fitted = fitBoundsToAspect(
      padded.latMin,
      padded.latMax,
      padded.lonMin,
      padded.lonMax,
      params.width,
      params.height,
    )

    const midLat = (fitted.latMin + fitted.latMax) / 2
    const latKm = (fitted.latMax - fitted.latMin) * 111
    const lonKm =
      (fitted.lonMax - fitted.lonMin) *
      111 *
      Math.max(0.01, Math.abs(Math.cos((midLat * Math.PI) / 180)))
    const aspect = lonKm / latKm
    const grid = estimateEffectiveGrid(params.gridRes, aspect)

    return {
      routeBounds: [
        [routeLatMin, routeLonMin],
        [routeLatMax, routeLonMax],
      ] as LatLngBoundsExpression,
      fittedBounds: [
        [fitted.latMin, fitted.lonMin],
        [fitted.latMax, fitted.lonMax],
      ] as LatLngBoundsExpression,
      polyline: points.map((p) => [p.lat, p.lon]) as LatLngExpression[],
      grid,
      fittedGeo: {
        latMin: fitted.latMin,
        latMax: fitted.latMax,
        lonMin: fitted.lonMin,
        lonMax: fitted.lonMax,
      },
    }
  }, [points, params])

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const parsed = parseGpxPoints(text)
      if (parsed.length === 0) {
        throw new Error('No track points found in GPX file.')
      }
      setPoints(parsed)
      setFileName(file.name)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse GPX file.')
      setPoints([])
      setFileName('')
    }
  }

  const updateParam = (key: keyof Params, value: number) => {
    setParams((old) => ({ ...old, [key]: value }))
  }

  const downloadStl = () => {
    if (!preview) return
    const stl = generateRouteStl(points, params, preview)
    const blob = new Blob([stl], { type: 'model/stl' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stem = fileName.replace(/\.gpx$/i, '') || 'route'
    a.href = url
    a.download = `${stem}_route.stl`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="kicker">RouteForge Web MVP</p>
        <h1>GPX to STL Studio</h1>
        <p className="subtitle">
          Upload a GPX route, tune print settings, and preview effective terrain bounds.
        </p>
      </header>

      <section className="layout">
        <aside className="panel controls">
          <h2>Input</h2>
          <label className="field">
            <span>GPX file</span>
            <input type="file" accept=".gpx" onChange={handleUpload} />
          </label>

          <h2>Parameters</h2>
          <div className="grid-fields">
            <label className="field">
              <span>Width (mm)</span>
              <input
                type="number"
                value={params.width}
                min={1}
                onChange={(e) => updateParam('width', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Height (mm)</span>
              <input
                type="number"
                value={params.height}
                min={1}
                onChange={(e) => updateParam('height', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Base (mm)</span>
              <input
                type="number"
                value={params.base}
                min={0.1}
                step={0.1}
                onChange={(e) => updateParam('base', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Vertical exag</span>
              <input
                type="number"
                value={params.verticalExag}
                min={0.1}
                step={0.1}
                onChange={(e) => updateParam('verticalExag', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Grid res</span>
              <input
                type="number"
                value={params.gridRes}
                min={4}
                onChange={(e) => updateParam('gridRes', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Margin frac</span>
              <input
                type="number"
                value={params.marginFrac}
                min={0}
                step={0.01}
                onChange={(e) => updateParam('marginFrac', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Ridge height (mm)</span>
              <input
                type="number"
                value={params.ridgeHeight}
                min={0}
                step={0.1}
                onChange={(e) => updateParam('ridgeHeight', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Ridge width (mm)</span>
              <input
                type="number"
                value={params.ridgeWidth}
                min={0.1}
                step={0.1}
                onChange={(e) => updateParam('ridgeWidth', Number(e.target.value))}
              />
            </label>
          </div>

          <button className="download" disabled={!preview} onClick={downloadStl}>
            Download STL
          </button>

          {error && <p className="error">{error}</p>}
        </aside>

        <section className="panel preview">
          <div className="preview-head">
            <h2>Dynamic 2D Preview</h2>
            <p>{fileName || 'No GPX selected'}</p>
          </div>

          {preview ? (
            <>
              <MapContainer
                className="map"
                bounds={preview.fittedBounds}
                scrollWheelZoom
              >
                <TileLayer
                  attribution="&copy; OpenStreetMap contributors"
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <Polyline positions={preview.polyline} pathOptions={{ color: '#ff5e2e', weight: 4 }} />
                <Rectangle bounds={preview.fittedBounds} pathOptions={{ color: '#0a7f5a', weight: 2 }} />
                <FitToBounds bounds={preview.fittedBounds} />
              </MapContainer>

              <div className="stats">
                <p>
                  Requested API calls: <strong>{preview.grid.requestedCalls}</strong>
                </p>
                <p>
                  Effective grid: <strong>{preview.grid.nx} x {preview.grid.ny}</strong>
                </p>
                <p>
                  Effective API calls: <strong>{preview.grid.effectiveCalls}</strong> / 25
                </p>
                <p>
                  Auto-adjusted: <strong>{preview.grid.adjusted ? 'Yes' : 'No'}</strong>
                </p>
              </div>
            </>
          ) : (
            <div className="empty">Upload a GPX file to start previewing route coverage.</div>
          )}
        </section>
      </section>

      <footer className="footnote">
        STL now uses uploaded GPX geometry with route ridge embossing and watertight side walls in browser.
      </footer>
    </main>
  )
}

export default App
