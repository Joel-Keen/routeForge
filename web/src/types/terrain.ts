import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet'

export type Point = {
  lat: number
  lon: number
}

export type Params = {
  width: number
  height: number
  base: number
  verticalExag: number
  gridRes: number
  ridgeHeight: number
  ridgeWidth: number
  marginFrac: number
  embossRoute: boolean
}

export type PreviewModel = {
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

export type WorkerPreviewModel = {
  grid: {
    nx: number
    ny: number
  }
  fittedGeo: {
    latMin: number
    latMax: number
    lonMin: number
    lonMax: number
  }
}

export type TerrainWorkerRequest = {
  kind: 'generate'
  runId: string
  points: Point[]
  params: Params
  preview: WorkerPreviewModel
}

export type TerrainWorkerPreviewRequest = {
  kind: 'preview3d'
  runId: string
  points: Point[]
  params: Params
  preview: WorkerPreviewModel
}

export type TerrainWorkerStlFromCacheRequest = {
  kind: 'stl-from-cache'
  runId: string
  params: Params
  grid: {
    nx: number
    ny: number
  }
  topValues: number[]
}

export type TerrainWorkerCancel = {
  kind: 'cancel'
  runId: string
}

export type TerrainWorkerMessage =
  | TerrainWorkerRequest
  | TerrainWorkerPreviewRequest
  | TerrainWorkerStlFromCacheRequest
  | TerrainWorkerCancel

export type TerrainWorkerProgress = {
  kind: 'progress'
  runId: string
  stage:
    | 'preparing'
    | 'fetch'
    | 'smooth'
    | 'rasterize'
    | 'blend'
    | 'mesh'
    | 'serialize'
  message: string
  progressPct?: number
}

export type TerrainWorkerDone = {
  kind: 'done-stl'
  runId: string
  stlText: string
}

export type TerrainWorkerPreviewDone = {
  kind: 'done-preview3d'
  runId: string
  payload: {
    nx: number
    ny: number
    topValues: number[]
  }
}

export type TerrainWorkerError = {
  kind: 'error'
  runId: string
  error: string
}

export type TerrainWorkerResponse =
  | TerrainWorkerProgress
  | TerrainWorkerDone
  | TerrainWorkerPreviewDone
  | TerrainWorkerError
