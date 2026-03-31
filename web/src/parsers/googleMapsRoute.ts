import type { Point } from '../types/terrain'

type ParseResult = {
  points: Point[]
  warning?: string
}

function isValidLatLon(lat: number, lon: number) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}

function dedupeSequential(points: Point[]) {
  const out: Point[] = []
  for (const p of points) {
    const prev = out[out.length - 1]
    if (!prev || Math.abs(prev.lat - p.lat) > 1e-8 || Math.abs(prev.lon - p.lon) > 1e-8) {
      out.push(p)
    }
  }
  return out
}

function extractBangCoords(text: string) {
  const points: Point[] = []
  const regex = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g
  let match = regex.exec(text)
  while (match) {
    const lat = Number(match[1])
    const lon = Number(match[2])
    if (isValidLatLon(lat, lon)) points.push({ lat, lon })
    match = regex.exec(text)
  }
  return points
}

function extractAtCoords(text: string) {
  const points: Point[] = []
  const regex = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g
  let match = regex.exec(text)
  while (match) {
    const lat = Number(match[1])
    const lon = Number(match[2])
    if (isValidLatLon(lat, lon)) points.push({ lat, lon })
    match = regex.exec(text)
  }
  return points
}

function extractLatLonPairs(text: string) {
  const points: Point[] = []
  const regex = /(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/g
  let match = regex.exec(text)
  while (match) {
    const lat = Number(match[1])
    const lon = Number(match[2])
    if (isValidLatLon(lat, lon)) points.push({ lat, lon })
    match = regex.exec(text)
  }
  return points
}

export function parseGoogleMapsRoute(urlText: string): ParseResult {
  const trimmed = urlText.trim()
  if (!trimmed) {
    throw new Error('Paste a Google Maps route link first.')
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('That does not look like a valid URL.')
  }

  const host = url.hostname.toLowerCase()
  if (!host.includes('google.') && !host.includes('goo.gl')) {
    throw new Error('Please provide a Google Maps URL.')
  }

  const decoded = decodeURIComponent(url.toString())
  const allCandidates = [
    ...extractBangCoords(decoded),
    ...extractAtCoords(decoded),
    ...extractLatLonPairs(decoded),
  ]

  const points = dedupeSequential(allCandidates)

  if (points.length < 2) {
    throw new Error(
      'Could not extract enough route coordinates from this link. Try opening full directions in browser and copy that URL, or upload GPX.',
    )
  }

  const warning =
    points.length < 5
      ? 'Only a small number of route points were found in this link; output may be simplified.'
      : undefined

  return { points, warning }
}
