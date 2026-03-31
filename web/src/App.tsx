import { useEffect, useMemo, useRef, useState } from 'react'
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
import type {
  Params,
  Point,
  PreviewModel,
  TerrainWorkerMessage,
  TerrainWorkerResponse,
} from './types/terrain'
import { parseGoogleMapsRoute } from './parsers/googleMapsRoute'
import './App.css'

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

function triggerStlDownload(stlText: string, stem: string) {
  const blob = new Blob([stlText], { type: 'model/stl' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${stem}_route.stl`
  a.click()
  URL.revokeObjectURL(url)
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
  const [mapsUrl, setMapsUrl] = useState('')
  const [mapsMessage, setMapsMessage] = useState('')
  const [points, setPoints] = useState<Point[]>([])
  const [error, setError] = useState('')
  const [generationMessage, setGenerationMessage] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)

  const workerRef = useRef<Worker | null>(null)
  const activeRunIdRef = useRef<string>('')
  const activeStemRef = useRef<string>('route')

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
      setMapsMessage('Using GPX upload as route source.')
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

  const handleMapsConvert = () => {
    if (isGenerating) return

    try {
      const parsed = parseGoogleMapsRoute(mapsUrl)
      setPoints(parsed.points)
      setFileName('google-maps-route')
      setError('')
      setMapsMessage(
        parsed.warning
          ? `Parsed ${parsed.points.length} points from link. ${parsed.warning}`
          : `Parsed ${parsed.points.length} points from Google Maps link.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not parse Google Maps link.')
      setMapsMessage('')
    }
  }

  const clearMapsLink = () => {
    setMapsUrl('')
    setMapsMessage('')
  }

  const ensureWorker = () => {
    if (workerRef.current) return workerRef.current

    const worker = new Worker(new URL('./workers/terrainWorker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
      const message = event.data
      if (message.runId !== activeRunIdRef.current) return

      if (message.kind === 'progress') {
        setGenerationMessage(message.message)
        return
      }

      if (message.kind === 'done') {
        setIsGenerating(false)
        setGenerationMessage('STL generated successfully')
        triggerStlDownload(message.stlText, activeStemRef.current)
        return
      }

      if (message.kind === 'error') {
        if (message.error === 'Cancelled') {
          setGenerationMessage('Generation cancelled')
          return
        }
        setError(message.error)
        setGenerationMessage('Generation failed')
      }
      setIsGenerating(false)
    }

    workerRef.current = worker
    return worker
  }

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const downloadStl = () => {
    if (!preview || isGenerating) return

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    activeRunIdRef.current = runId
    activeStemRef.current = fileName.replace(/\.gpx$/i, '') || 'route'
    setError('')
    setIsGenerating(true)
    setGenerationMessage('Starting generation worker')

    const worker = ensureWorker()
    const payload: TerrainWorkerMessage = {
      kind: 'generate',
      runId,
      points,
      params,
      preview: {
        grid: {
          nx: preview.grid.nx,
          ny: preview.grid.ny,
        },
        fittedGeo: preview.fittedGeo,
      },
    }
    worker.postMessage(payload)
  }

  const cancelGeneration = () => {
    if (!isGenerating || !workerRef.current) return
    workerRef.current.postMessage({
      kind: 'cancel',
      runId: activeRunIdRef.current,
    } satisfies TerrainWorkerMessage)
    setIsGenerating(false)
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

          <label className="field">
            <span>Google Maps directions link</span>
            <textarea
              className="maps-link"
              value={mapsUrl}
              onChange={(e) => setMapsUrl(e.target.value)}
              placeholder="Paste full Google Maps route URL"
              rows={3}
            />
          </label>

          <div className="link-actions">
            <button
              className="convert"
              disabled={!mapsUrl.trim() || isGenerating}
              onClick={handleMapsConvert}
            >
              Convert Link to Route
            </button>
            <button className="clear-link" disabled={!mapsUrl.trim() || isGenerating} onClick={clearMapsLink}>
              Clear Link
            </button>
          </div>

          <p className="source-note">
            Link parsing is best-effort in browser. If conversion fails, upload GPX instead.
          </p>

          {mapsMessage && <p className="status">{mapsMessage}</p>}

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

          <button className="download" disabled={!preview || isGenerating} onClick={downloadStl}>
            Download STL
          </button>

          <button className="cancel" disabled={!isGenerating} onClick={cancelGeneration}>
            Cancel Generation
          </button>

          {generationMessage && <p className="status">{generationMessage}</p>}

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
        STL generation now combines OpenElevation terrain with GPX ridge embossing and watertight walls in browser worker.
      </footer>
    </main>
  )
}

export default App
