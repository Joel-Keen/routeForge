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

function parseLatLonToken(token: string): Point | null {
  const match = token.match(/(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/)
  if (!match) return null
  const lat = Number(match[1])
  const lon = Number(match[2])
  if (!isValidLatLon(lat, lon)) return null
  return { lat, lon }
}

function isGoogleMapsHost(hostname: string) {
  const host = hostname.toLowerCase()
  return host.includes('google.') || host.endsWith('goo.gl') || host === 'g.co' || host === 'maps.app.goo.gl'
}

function isShortGoogleMapsHost(hostname: string) {
  const host = hostname.toLowerCase()
  return host.endsWith('goo.gl') || host === 'g.co' || host === 'maps.app.goo.gl'
}

async function resolveGoogleMapsUrl(url: URL) {
  if (!isShortGoogleMapsHost(url.hostname)) {
    return { resolved: url, warning: undefined as string | undefined }
  }

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
    })
    const finalUrl = response.url ? new URL(response.url) : url
    if (!isGoogleMapsHost(finalUrl.hostname)) {
      return {
        resolved: url,
        warning: 'Short link resolved outside Google Maps host; parsing original link only.',
      }
    }
    if (finalUrl.toString() === url.toString()) {
      return {
        resolved: finalUrl,
        warning: 'Could not expand short link in browser; parsing original link directly.',
      }
    }
    return { resolved: finalUrl, warning: undefined as string | undefined }
  } catch {
    return {
      resolved: url,
      warning: 'Could not expand short link in browser; parsing original link directly.',
    }
  }
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

  const reverseRegex = /!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/g
  match = reverseRegex.exec(text)
  while (match) {
    const lon = Number(match[1])
    const lat = Number(match[2])
    if (isValidLatLon(lat, lon)) points.push({ lat, lon })
    match = reverseRegex.exec(text)
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

function extractPathCoords(pathname: string) {
  const points: Point[] = []
  const decodedPath = decodeURIComponent(pathname)
  const segments = decodedPath.split('/')
  for (const segment of segments) {
    const coord = parseLatLonToken(segment)
    if (coord) points.push(coord)
  }
  return points
}

function extractQueryCoords(url: URL) {
  const points: Point[] = []
  const keys = ['origin', 'destination', 'waypoints', 'query']

  for (const key of keys) {
    const value = url.searchParams.get(key)
    if (!value) continue

    for (const chunk of value.split('|')) {
      const coord = parseLatLonToken(chunk)
      if (coord) points.push(coord)
    }
  }

  return points
}

export async function parseGoogleMapsRoute(urlText: string): Promise<ParseResult> {
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

  if (!isGoogleMapsHost(url.hostname)) {
    throw new Error('Please provide a Google Maps URL.')
  }

  const { resolved, warning: resolveWarning } = await resolveGoogleMapsUrl(url)
  const decoded = decodeURIComponent(resolved.toString())
  const allCandidates = [
    ...extractQueryCoords(resolved),
    ...extractPathCoords(resolved.pathname),
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

  const warnings: string[] = []
  if (resolveWarning) warnings.push(resolveWarning)
  if (points.length < 5) {
    warnings.push('Only a small number of route points were found in this link; output may be simplified.')
  }

  const warning = warnings.length > 0 ? warnings.join(' ') : undefined

  return { points, warning }
}
