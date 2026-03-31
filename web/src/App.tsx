import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { gpx as toGeoJsonGpx } from '@tmcw/togeojson'
import {
  MapContainer,
  useMapEvents,
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

const TerrainPreview3D = lazy(() =>
  import('./components/TerrainPreview3D').then((module) => ({
    default: module.TerrainPreview3D,
  })),
)

const DEFAULT_PARAMS: Params = {
  width: 100,
  height: 100,
  base: 3,
  verticalExag: 6,
  gridRes: 200,
  ridgeHeight: 6,
  ridgeWidth: 3,
  marginFrac: 0.2,
  embossRoute: true,
}

const BATCH_SIZE = 400
const MAX_REQUESTS = 25
type NumericParamKey = Exclude<keyof Params, 'embossRoute'>
type InputMode = 'gpx' | 'maps' | 'rectangle'
type ViewMode = '2d' | '3d'
type WorkerTask = 'stl' | 'preview3d' | 'stl-from-cache'

type GeoBounds = {
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
}

type CachedTerrainPreview = {
  nx: number
  ny: number
  topValues: number[]
  aspect: number
}

const DEFAULT_MAP_BOUNDS: LatLngBoundsExpression = [
  [49.8, -7.8],
  [58.9, 2.2],
]

function toLatLngBounds(bounds: GeoBounds): LatLngBoundsExpression {
  return [
    [bounds.latMin, bounds.lonMin],
    [bounds.latMax, bounds.lonMax],
  ]
}

function normalizeGeoBounds(aLat: number, aLon: number, bLat: number, bLon: number): GeoBounds {
  return {
    latMin: Math.min(aLat, bLat),
    latMax: Math.max(aLat, bLat),
    lonMin: Math.min(aLon, bLon),
    lonMax: Math.max(aLon, bLon),
  }
}

function geoAspect(bounds: GeoBounds) {
  const latSpan = Math.max(1e-9, bounds.latMax - bounds.latMin)
  const lonSpan = Math.max(1e-9, bounds.lonMax - bounds.lonMin)
  const midLat = (bounds.latMin + bounds.latMax) / 2
  const latKm = latSpan * 111
  const lonKm = lonSpan * 111 * Math.max(0.01, Math.abs(Math.cos((midLat * Math.PI) / 180)))
  return lonKm / latKm
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

function RectangleDrawLayer({
  enabled,
  armed,
  onDraft,
  onComplete,
  onBegin,
}: {
  enabled: boolean
  armed: boolean
  onDraft: (bounds: GeoBounds) => void
  onComplete: (bounds: GeoBounds) => void
  onBegin: () => void
}) {
  const dragStartRef = useRef<{ lat: number; lon: number } | null>(null)

  const map = useMapEvents({
    mousedown(event) {
      if (!enabled || !armed) return
      dragStartRef.current = { lat: event.latlng.lat, lon: event.latlng.lng }
      onBegin()
      map.dragging.disable()
      map.doubleClickZoom.disable()
    },
    mousemove(event) {
      const start = dragStartRef.current
      if (!enabled || !armed || !start) return
      onDraft(normalizeGeoBounds(start.lat, start.lon, event.latlng.lat, event.latlng.lng))
    },
    mouseup(event) {
      const start = dragStartRef.current
      if (!enabled || !armed || !start) return
      const bounds = normalizeGeoBounds(start.lat, start.lon, event.latlng.lat, event.latlng.lng)
      dragStartRef.current = null
      map.dragging.enable()
      map.doubleClickZoom.enable()
      onComplete(bounds)
    },
  })

  useEffect(() => {
    return () => {
      map.dragging.enable()
      map.doubleClickZoom.enable()
    }
  }, [map])

  return null
}

function App() {
  const [inputMode, setInputMode] = useState<InputMode>('gpx')
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS)
  const [gpxFileName, setGpxFileName] = useState('')
  const [gpxPoints, setGpxPoints] = useState<Point[]>([])

  const [mapsUrl, setMapsUrl] = useState('')
  const [mapsMessage, setMapsMessage] = useState('')
  const [mapsPoints, setMapsPoints] = useState<Point[]>([])

  const [rectangleBounds, setRectangleBounds] = useState<GeoBounds | null>(null)
  const [rectangleDraftBounds, setRectangleDraftBounds] = useState<GeoBounds | null>(null)
  const [isRectangleDrawArmed, setIsRectangleDrawArmed] = useState(false)
  const [embossPreferenceBeforeRectangle, setEmbossPreferenceBeforeRectangle] = useState(true)

  const [error, setError] = useState('')
  const [generationMessage, setGenerationMessage] = useState('')
  const [fetchProgressPct, setFetchProgressPct] = useState<number | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [activeTask, setActiveTask] = useState<WorkerTask | null>(null)
  const [cachedTerrainPreview, setCachedTerrainPreview] = useState<CachedTerrainPreview | null>(null)

  const workerRef = useRef<Worker | null>(null)
  const activeRunIdRef = useRef<string>('')
  const activeStemRef = useRef<string>('route')

  const isPreviewLocked = cachedTerrainPreview !== null

  const activePoints = useMemo(() => {
    if (inputMode === 'gpx') return gpxPoints
    if (inputMode === 'maps') return mapsPoints
    return []
  }, [inputMode, gpxPoints, mapsPoints])

  const activeFileName = useMemo(() => {
    if (inputMode === 'gpx') return gpxFileName
    if (inputMode === 'maps') return 'google-maps-route'
    return rectangleBounds ? 'drawn-rectangle-area' : ''
  }, [inputMode, gpxFileName, rectangleBounds])

  const preview = useMemo<PreviewModel | null>(() => {
    if (inputMode === 'rectangle') {
      if (!rectangleBounds) return null

      const aspect = geoAspect(rectangleBounds)
      const grid = estimateEffectiveGrid(params.gridRes, aspect)

      return {
        routeBounds: toLatLngBounds(rectangleBounds),
        fittedBounds: toLatLngBounds(rectangleBounds),
        polyline: [] as LatLngExpression[],
        grid,
        fittedGeo: {
          latMin: rectangleBounds.latMin,
          latMax: rectangleBounds.latMax,
          lonMin: rectangleBounds.lonMin,
          lonMax: rectangleBounds.lonMax,
        },
      }
    }

    if (activePoints.length === 0) return null

    const lats = activePoints.map((p) => p.lat)
    const lons = activePoints.map((p) => p.lon)
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
      polyline: activePoints.map((p) => [p.lat, p.lon]) as LatLngExpression[],
      grid,
      fittedGeo: {
        latMin: fitted.latMin,
        latMax: fitted.latMax,
        lonMin: fitted.lonMin,
        lonMax: fitted.lonMax,
      },
    }
  }, [activePoints, inputMode, params, rectangleBounds])

  useEffect(() => {
    const lockedAspect = cachedTerrainPreview?.aspect
    const rectangleAspect = inputMode === 'rectangle' && rectangleBounds
      ? geoAspect(rectangleBounds)
      : null
    const aspect = Math.max(1e-6, lockedAspect ?? rectangleAspect ?? 0)
    if (aspect <= 0) return

    const targetHeight = Number((params.width / aspect).toFixed(2))

    setParams((old) => {
      if (Math.abs(old.height - targetHeight) < 1e-6) return old
      return { ...old, height: targetHeight }
    })
  }, [cachedTerrainPreview, inputMode, rectangleBounds, params.width])

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const parsed = parseGpxPoints(text)
      if (parsed.length === 0) {
        throw new Error('No track points found in GPX file.')
      }
      setGpxPoints(parsed)
      setGpxFileName(file.name)
      setMapsMessage('Using GPX upload as route source.')
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse GPX file.')
      setGpxPoints([])
      setGpxFileName('')
    }
  }

  const updateParam = (key: NumericParamKey, value: number) => {
    setParams((old) => ({ ...old, [key]: value }))
  }

  const handleMapsConvert = async () => {
    if (isGenerating) return

    try {
      const parsed = await parseGoogleMapsRoute(mapsUrl)
      setMapsPoints(parsed.points)
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
    setMapsPoints([])
  }

  const backTo2d = () => {
    if (isGenerating || viewMode === '2d') return
    setViewMode('2d')
    setCachedTerrainPreview(null)
    setFetchProgressPct(null)
    setGenerationMessage('Returned to 2D preview. Generate 3D preview to download fresh elevation data.')
  }

  const handleModeSwitch = (mode: InputMode) => {
    if (mode === inputMode) return

    if (isPreviewLocked) {
      setViewMode('2d')
      setCachedTerrainPreview(null)
    }

    if (mode === 'rectangle' && inputMode !== 'rectangle') {
      setEmbossPreferenceBeforeRectangle(params.embossRoute)
      setParams((old) => ({ ...old, embossRoute: false }))
      setMapsMessage('')
    }

    if (inputMode === 'rectangle' && mode !== 'rectangle') {
      setParams((old) => ({ ...old, embossRoute: embossPreferenceBeforeRectangle }))
      setRectangleDraftBounds(null)
      setIsRectangleDrawArmed(false)
    }

    setError('')
    setInputMode(mode)
  }

  const beginRectangleDraw = () => {
    if (inputMode !== 'rectangle' || isGenerating) return
    setError('')
    setGenerationMessage('Drag on the map to draw a rectangle.')
    setRectangleDraftBounds(null)
    setIsRectangleDrawArmed(true)
  }

  const clearRectangle = () => {
    if (isGenerating) return
    setRectangleBounds(null)
    setRectangleDraftBounds(null)
    setIsRectangleDrawArmed(false)
    setGenerationMessage('')
  }

  const handleRectangleComplete = (bounds: GeoBounds) => {
    const latSpan = bounds.latMax - bounds.latMin
    const lonSpan = bounds.lonMax - bounds.lonMin
    if (latSpan <= 1e-9 || lonSpan <= 1e-9) {
      setError('Rectangle is too small. Please draw a larger area.')
      setIsRectangleDrawArmed(false)
      return
    }

    setRectangleBounds(bounds)
    setRectangleDraftBounds(null)
    setIsRectangleDrawArmed(false)
    setError('')
    setGenerationMessage('Rectangle captured.')
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
        if (message.stage === 'fetch' && typeof message.progressPct === 'number') {
          setFetchProgressPct(message.progressPct)
        }
        return
      }

      if (message.kind === 'done-stl') {
        setIsGenerating(false)
        setActiveTask(null)
        setFetchProgressPct(100)
        setGenerationMessage('STL generated successfully')
        triggerStlDownload(message.stlText, activeStemRef.current)
        return
      }

      if (message.kind === 'done-preview3d') {
        const fitted = preview?.fittedGeo
        const previewAspect = fitted
          ? geoAspect({
              latMin: fitted.latMin,
              latMax: fitted.latMax,
              lonMin: fitted.lonMin,
              lonMax: fitted.lonMax,
            })
          : Math.max(1e-6, params.width / Math.max(1e-6, params.height))

        setCachedTerrainPreview({
          nx: message.payload.nx,
          ny: message.payload.ny,
          topValues: message.payload.topValues,
          aspect: Math.max(1e-6, previewAspect),
        })
        setIsGenerating(false)
        setActiveTask(null)
        setFetchProgressPct(100)
        setViewMode('3d')
        setGenerationMessage('3D preview generated successfully')
        return
      }

      if (message.kind === 'error') {
        if (message.error === 'Cancelled') {
          setActiveTask(null)
          setFetchProgressPct(null)
          setGenerationMessage('Generation cancelled')
          return
        }
        setError(message.error)
        setActiveTask(null)
        setFetchProgressPct(null)
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

    if (inputMode === 'rectangle' && !rectangleBounds) {
      setError('Draw a rectangle on the map before generating STL.')
      return
    }

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    activeRunIdRef.current = runId
    activeStemRef.current =
      inputMode === 'rectangle'
        ? 'drawn-rectangle-area'
        : activeFileName.replace(/\.gpx$/i, '') || 'route'
    setError('')
    setIsGenerating(true)
    setActiveTask(cachedTerrainPreview ? 'stl-from-cache' : 'stl')
    setFetchProgressPct(cachedTerrainPreview ? null : 0)
    setGenerationMessage(
      cachedTerrainPreview
        ? 'Building STL from cached preview data'
        : 'Starting generation worker',
    )

    const worker = ensureWorker()
    const effectiveParams =
      inputMode === 'rectangle' ? { ...params, embossRoute: false } : params

    if (cachedTerrainPreview) {
      worker.postMessage({
        kind: 'stl-from-cache',
        runId,
        params: effectiveParams,
        grid: {
          nx: cachedTerrainPreview.nx,
          ny: cachedTerrainPreview.ny,
        },
        topValues: cachedTerrainPreview.topValues,
      } satisfies TerrainWorkerMessage)
      return
    }

    const payload: TerrainWorkerMessage = {
      kind: 'generate',
      runId,
      points: activePoints,
      params: effectiveParams,
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

  const generate3dPreview = () => {
    if (!preview || isGenerating) return

    if (inputMode === 'rectangle' && !rectangleBounds) {
      setError('Draw a rectangle on the map before generating 3D preview.')
      return
    }

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    activeRunIdRef.current = runId
    setError('')
    setIsGenerating(true)
    setActiveTask('preview3d')
    setFetchProgressPct(0)
    setGenerationMessage('Downloading OpenElevation data for 3D preview')

    const worker = ensureWorker()
    const effectiveParams =
      inputMode === 'rectangle' ? { ...params, embossRoute: false } : params

    worker.postMessage({
      kind: 'preview3d',
      runId,
      points: activePoints,
      params: effectiveParams,
      preview: {
        grid: {
          nx: preview.grid.nx,
          ny: preview.grid.ny,
        },
        fittedGeo: preview.fittedGeo,
      },
    } satisfies TerrainWorkerMessage)
  }

  const cancelGeneration = () => {
    if (!isGenerating || !workerRef.current) return
    workerRef.current.postMessage({
      kind: 'cancel',
      runId: activeRunIdRef.current,
    } satisfies TerrainWorkerMessage)
    setIsGenerating(false)
    setActiveTask(null)
    setFetchProgressPct(null)
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <h1>routeForge</h1>
      </header>

      <section className="layout">
        <aside className="panel controls">
          <h2>Input</h2>

          <div className="mode-toggle" role="tablist" aria-label="Route input mode">
            <button
              role="tab"
              aria-selected={inputMode === 'gpx'}
              className={inputMode === 'gpx' ? 'mode-tab active' : 'mode-tab'}
              disabled={isGenerating}
              onClick={() => handleModeSwitch('gpx')}
            >
              GPX
            </button>
            <button
              role="tab"
              aria-selected={inputMode === 'maps'}
              className={inputMode === 'maps' ? 'mode-tab active' : 'mode-tab'}
              disabled={isGenerating}
              onClick={() => handleModeSwitch('maps')}
            >
              Google Maps
            </button>
            <button
              role="tab"
              aria-selected={inputMode === 'rectangle'}
              className={inputMode === 'rectangle' ? 'mode-tab active' : 'mode-tab'}
              disabled={isGenerating}
              onClick={() => handleModeSwitch('rectangle')}
            >
              Draw Rectangle
            </button>
          </div>

          {inputMode === 'gpx' && (
            <label className="field">
              <span>GPX file</span>
              <input type="file" accept=".gpx" onChange={handleUpload} />
            </label>
          )}

          {inputMode === 'maps' && (
            <>
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
            </>
          )}

          {inputMode === 'rectangle' && (
            <div className="rectangle-tools">
              <button className="convert" disabled={isGenerating || isRectangleDrawArmed} onClick={beginRectangleDraw}>
                {isRectangleDrawArmed ? 'Draw mode active' : 'Draw Rectangle'}
              </button>
              <button
                className="clear-link"
                disabled={isGenerating || (!rectangleBounds && !rectangleDraftBounds)}
                onClick={clearRectangle}
              >
                Clear Rectangle
              </button>
              <p className="source-note">
                Click Draw Rectangle, then drag on the map preview. Height auto-scales from rectangle aspect.
              </p>
            </div>
          )}

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
                disabled={inputMode === 'rectangle' || isPreviewLocked}
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
                disabled={isPreviewLocked}
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
                disabled={isPreviewLocked}
                onChange={(e) => updateParam('verticalExag', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Grid Resolution</span>
              <input
                type="number"
                value={params.gridRes}
                min={4}
                disabled={isPreviewLocked}
                onChange={(e) => updateParam('gridRes', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Margin Factor</span>
              <input
                type="number"
                value={params.marginFrac}
                min={0}
                step={0.01}
                disabled={isPreviewLocked}
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
                disabled={!params.embossRoute || inputMode === 'rectangle' || isPreviewLocked}
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
                disabled={!params.embossRoute || inputMode === 'rectangle' || isPreviewLocked}
                onChange={(e) => updateParam('ridgeWidth', Number(e.target.value))}
              />
            </label>
          </div>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={params.embossRoute}
              disabled={inputMode === 'rectangle' || isPreviewLocked}
              onChange={(e) => setParams((old) => ({ ...old, embossRoute: e.target.checked }))}
            />
            <span>
              {inputMode === 'rectangle'
                ? 'Emboss unavailable in rectangle mode'
                : 'Emboss route onto terrain'}
            </span>
          </label>

          {isPreviewLocked && (
            <p className="status">3D preview data locked. Width can be changed; use Back to 2D to unlock all parameters.</p>
          )}

          <button className="generate-preview" disabled={!preview || isGenerating} onClick={generate3dPreview}>
            Generate 3D Preview
          </button>

          <button className="download" disabled={!preview || isGenerating} onClick={downloadStl}>
            Download STL
          </button>

          <button className="cancel" disabled={!isGenerating} onClick={cancelGeneration}>
            Cancel Generation
          </button>

          <button className="back-2d" disabled={isGenerating || viewMode !== '3d'} onClick={backTo2d}>
            Back to 2D
          </button>

          {isGenerating && fetchProgressPct !== null && (
            <div className="fetch-progress" aria-live="polite">
              <div className="fetch-progress-head">
                <span>{activeTask === 'preview3d' ? 'OpenElevation Data (3D Preview)' : 'OpenElevation Data'}</span>
                <span>{fetchProgressPct}%</span>
              </div>
              <progress max={100} value={fetchProgressPct} />
            </div>
          )}

          {generationMessage && <p className="status">{generationMessage}</p>}
          {error && <p className="error">{error}</p>}
        </aside>

        <section className="panel preview">
          <div className="preview-head">
            <h2>{viewMode === '3d' ? 'Dynamic 3D Preview' : 'Dynamic 2D Preview'}</h2>
            <p>{activeFileName || 'No route selected'}</p>
          </div>

          <p className="source-chip">
            Source: {inputMode === 'gpx' ? 'GPX upload' : inputMode === 'maps' ? 'Google Maps link' : 'Drawn rectangle'}
          </p>

          {viewMode === '3d' && cachedTerrainPreview ? (
            <div className="map preview-3d">
              <Suspense fallback={<div className="preview-3d-loading">Loading 3D preview...</div>}>
                <TerrainPreview3D
                  topValues={cachedTerrainPreview.topValues}
                  nx={cachedTerrainPreview.nx}
                  ny={cachedTerrainPreview.ny}
                  width={params.width}
                  height={params.height}
                />
              </Suspense>
            </div>
          ) : (preview || inputMode === 'rectangle') ? (
            <>
              <MapContainer
                className="map"
                bounds={preview ? preview.fittedBounds : DEFAULT_MAP_BOUNDS}
                scrollWheelZoom
              >
                <TileLayer
                  attribution="&copy; OpenStreetMap contributors"
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {preview && preview.polyline.length > 0 && (
                  <Polyline positions={preview.polyline} pathOptions={{ color: '#ff5e2e', weight: 4 }} />
                )}
                {(preview || rectangleDraftBounds || rectangleBounds) && (
                  <Rectangle
                    bounds={
                      rectangleDraftBounds
                        ? toLatLngBounds(rectangleDraftBounds)
                        : rectangleBounds
                          ? toLatLngBounds(rectangleBounds)
                          : preview!.fittedBounds
                    }
                    pathOptions={{ color: '#0a7f5a', weight: 2 }}
                  />
                )}
                <FitToBounds bounds={preview ? preview.fittedBounds : null} />
                <RectangleDrawLayer
                  enabled={inputMode === 'rectangle'}
                  armed={isRectangleDrawArmed}
                  onBegin={() => setError('')}
                  onDraft={(bounds) => setRectangleDraftBounds(bounds)}
                  onComplete={handleRectangleComplete}
                />
              </MapContainer>

              {preview ? (
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
              ) : (
                <div className="stats">
                  <p>Draw a rectangle on the map to enable terrain generation.</p>
                </div>
              )}
            </>
          ) : (
            <div className="empty">Upload GPX or convert a Google Maps link to start previewing route coverage.</div>
          )}
        </section>
      </section>

      <footer className="footnote">
        MIT License Copyright (c) 2026 Joel Keen. STL generation combines OpenElevation (GPLv2) terrain with optional route embossing and watertight walls in browser.
      </footer>
    </main>
  )
}

export default App
