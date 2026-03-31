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

export type TerrainWorkerCancel = {
  kind: 'cancel'
  runId: string
}

export type TerrainWorkerMessage = TerrainWorkerRequest | TerrainWorkerCancel

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
}

export type TerrainWorkerDone = {
  kind: 'done'
  runId: string
  stlText: string
}

export type TerrainWorkerError = {
  kind: 'error'
  runId: string
  error: string
}

export type TerrainWorkerResponse =
  | TerrainWorkerProgress
  | TerrainWorkerDone
  | TerrainWorkerError
