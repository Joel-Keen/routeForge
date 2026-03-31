import type {
  Params,
  Point,
  TerrainWorkerMessage,
  TerrainWorkerProgress,
  TerrainWorkerResponse,
  WorkerPreviewModel,
} from '../types/terrain'

const BATCH_SIZE = 400
const MAX_REQUESTS = 25
const FETCH_RETRIES = 4
const BACKOFF_BASE_MS = 350
const BACKOFF_MAX_MS = 2500

const cancelledRuns = new Set<string>()
const controllerByRun = new Map<string, AbortController>()

function tri(lines: string[], a: [number, number, number], b: [number, number, number], c: [number, number, number]) {
  lines.push('  facet normal 0 0 0')
  lines.push('    outer loop')
  lines.push(`      vertex ${a[0]} ${a[1]} ${a[2]}`)
  lines.push(`      vertex ${b[0]} ${b[1]} ${b[2]}`)
  lines.push(`      vertex ${c[0]} ${c[1]} ${c[2]}`)
  lines.push('    endloop')
  lines.push('  endfacet')
}

function assertNotCancelled(runId: string) {
  if (cancelledRuns.has(runId)) {
    throw new Error('Cancelled')
  }
}

function postProgress(runId: string, stage: TerrainWorkerProgress['stage'], message: string) {
  const payload: TerrainWorkerResponse = { kind: 'progress', runId, stage, message }
  postMessage(payload)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetriableStatus(status: number) {
  return status === 429 || (status >= 500 && status <= 599)
}

function jitteredBackoffMs(attempt: number) {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt)
  const jitter = Math.floor(Math.random() * 180)
  return exp + jitter
}

function gaussianKernel(radius: number, sigma: number) {
  const kernel = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i += 1) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = value
    sum += value
  }
  for (let i = 0; i < kernel.length; i += 1) {
    kernel[i] /= sum
  }
  return kernel
}

function clampIndex(value: number, max: number) {
  return Math.min(max, Math.max(0, value))
}

function smoothElevation(input: Float32Array, nx: number, ny: number, runId: string) {
  const radius = 3
  const kernel = gaussianKernel(radius, 1.0)
  const temp = new Float32Array(input.length)
  const output = new Float32Array(input.length)

  for (let y = 0; y < ny; y += 1) {
    if (y % 25 === 0) assertNotCancelled(runId)
    for (let x = 0; x < nx; x += 1) {
      let acc = 0
      for (let k = -radius; k <= radius; k += 1) {
        const xx = clampIndex(x + k, nx - 1)
        acc += input[y * nx + xx] * kernel[k + radius]
      }
      temp[y * nx + x] = acc
    }
  }

  for (let y = 0; y < ny; y += 1) {
    if (y % 25 === 0) assertNotCancelled(runId)
    for (let x = 0; x < nx; x += 1) {
      let acc = 0
      for (let k = -radius; k <= radius; k += 1) {
        const yy = clampIndex(y + k, ny - 1)
        acc += temp[yy * nx + x] * kernel[k + radius]
      }
      output[y * nx + x] = acc
    }
  }

  return output
}

function normalizeTerrainMm(elevation: Float32Array, params: Params) {
  let minVal = Number.POSITIVE_INFINITY
  let maxVal = Number.NEGATIVE_INFINITY

  for (let i = 0; i < elevation.length; i += 1) {
    const value = elevation[i]
    if (value < minVal) minVal = value
    if (value > maxVal) maxVal = value
  }

  const shortSide = Math.min(params.width, params.height)
  let terrainRange = shortSide * 0.3 * (params.verticalExag / 10)
  terrainRange = Math.min(terrainRange, shortSide * 0.8)

  const span = Math.max(1e-6, maxVal - minVal)
  const terrainMm = new Float32Array(elevation.length)
  for (let i = 0; i < elevation.length; i += 1) {
    terrainMm[i] = ((elevation[i] - minVal) / span) * terrainRange
  }
  return terrainMm
}

async function fetchElevationGrid(
  runId: string,
  preview: WorkerPreviewModel,
  signal: AbortSignal,
) {
  const { nx, ny } = preview.grid
  const { latMin, latMax, lonMin, lonMax } = preview.fittedGeo

  const totalPoints = nx * ny
  const requestCount = Math.ceil(totalPoints / BATCH_SIZE)
  if (requestCount > MAX_REQUESTS) {
    throw new Error(`Grid exceeds budget (${requestCount} > ${MAX_REQUESTS} requests)`)
  }

  const directEndpoint = 'https://api.open-elevation.com/api/v1/lookup'
  const proxyEndpoint = import.meta.env.VITE_ELEVATION_PROXY_URL?.trim()
  const endpoints = [directEndpoint]
  if (proxyEndpoint) endpoints.push(proxyEndpoint)

  const latSpan = latMax - latMin
  const lonSpan = lonMax - lonMin
  const elevations = new Float32Array(totalPoints)

  for (let start = 0; start < totalPoints; start += BATCH_SIZE) {
    assertNotCancelled(runId)
    const end = Math.min(totalPoints, start + BATCH_SIZE)
    const locations: Array<{ latitude: number; longitude: number }> = []

    for (let idx = start; idx < end; idx += 1) {
      const iy = Math.floor(idx / nx)
      const ix = idx % nx
      const lat = latMax - (iy / Math.max(1, ny - 1)) * latSpan
      const lon = lonMin + (ix / Math.max(1, nx - 1)) * lonSpan
      locations.push({ latitude: lat, longitude: lon })
    }

    let success = false
    let lastError = 'Unknown elevation request error'

    for (const endpoint of endpoints) {
      for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
        assertNotCancelled(runId)

        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locations }),
            signal,
          })

          if (!response.ok) {
            lastError = `HTTP ${response.status}`

            if (!isRetriableStatus(response.status) || attempt === FETCH_RETRIES) {
              break
            }

            postProgress(
              runId,
              'fetch',
              `Retrying elevation batch ${start}-${end - 1} (${attempt + 1}/${FETCH_RETRIES}) after ${response.status}`,
            )
            await sleep(jitteredBackoffMs(attempt))
            continue
          }

          const payload = (await response.json()) as {
            results?: Array<{ elevation: number }>
          }

          if (!payload.results || payload.results.length !== locations.length) {
            lastError = 'Malformed elevation response payload'
            if (attempt === FETCH_RETRIES) {
              break
            }
            await sleep(jitteredBackoffMs(attempt))
            continue
          }

          for (let i = 0; i < payload.results.length; i += 1) {
            elevations[start + i] = payload.results[i].elevation
          }
          success = true
          break
        } catch (err) {
          lastError = err instanceof Error ? err.message : 'Network failure'
          if (attempt === FETCH_RETRIES) {
            break
          }
          await sleep(jitteredBackoffMs(attempt))
        }
      }

      if (success) break
    }

    if (!success) {
      throw new Error(`Elevation batch failed at point ${start}: ${lastError}`)
    }
  }

  return elevations
}

async function generateRouteStl(
  points: Point[],
  params: Params,
  preview: WorkerPreviewModel,
  runId: string,
): Promise<string> {
  const { nx, ny } = preview.grid
  const { latMin, latMax, lonMin, lonMax } = preview.fittedGeo
  const controller = new AbortController()
  controllerByRun.set(runId, controller)

  postProgress(runId, 'preparing', 'Preparing grid and route geometry')

  postProgress(runId, 'fetch', 'Fetching terrain elevation data')
  const elevation = await fetchElevationGrid(runId, preview, controller.signal)
  assertNotCancelled(runId)

  postProgress(runId, 'smooth', 'Smoothing elevation field')
  const smoothed = smoothElevation(elevation, nx, ny, runId)
  assertNotCancelled(runId)

  const terrainMm = normalizeTerrainMm(smoothed, params)

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

  postProgress(runId, 'rasterize', 'Rasterizing route influence mask')

  for (let i = 0; i < gridPts.length - 1; i += 1) {
    if (i % 25 === 0) assertNotCancelled(runId)
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
    const ridge =
      d2 < Number.POSITIVE_INFINITY
        ? params.ridgeHeight * ridgeScale * Math.exp(-d2 / (2 * sigma2))
        : 0
    top[i] = params.base + terrainMm[i] + ridge
  }

  postProgress(runId, 'blend', 'Combining terrain and route ridge')

  const vertexTop = (ix: number, iy: number): [number, number, number] => {
    const x = (ix / Math.max(1, nx - 1)) * params.width
    const y = (iy / Math.max(1, ny - 1)) * params.height
    const z = top[iy * nx + ix]
    return [x, y, z]
  }

  postProgress(runId, 'mesh', 'Building watertight mesh')

  const lines: string[] = ['solid routeforge']

  for (let iy = 0; iy < ny - 1; iy += 1) {
    if (iy % 30 === 0) assertNotCancelled(runId)
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

  postProgress(runId, 'serialize', 'Serializing STL')
  lines.push('endsolid routeforge')
  controllerByRun.delete(runId)
  return lines.join('\n')
}

onmessage = (event: MessageEvent<TerrainWorkerMessage>) => {
  const data = event.data

  if (data.kind === 'cancel') {
    cancelledRuns.add(data.runId)
    const controller = controllerByRun.get(data.runId)
    controller?.abort()
    controllerByRun.delete(data.runId)
    return
  }

  ;(async () => {
    cancelledRuns.delete(data.runId)
    const stlText = await generateRouteStl(
      data.points,
      data.params,
      data.preview,
      data.runId,
    )
    assertNotCancelled(data.runId)
    const payload: TerrainWorkerResponse = { kind: 'done', runId: data.runId, stlText }
    postMessage(payload)
  })().catch((err) => {
    controllerByRun.delete(data.runId)
    const message = err instanceof Error ? err.message : 'Worker generation failed'
    const payload: TerrainWorkerResponse = {
      kind: 'error',
      runId: data.runId,
      error: message,
    }
    postMessage(payload)
  })
}
