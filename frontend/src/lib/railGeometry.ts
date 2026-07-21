'use client'

import { bearing, lerp } from './geo'
import type { LatLng, Train, TrainLive } from './types'

export type RailGeometryAsset = {
  version: number
  encoding: 'google-polyline6'
  segments: Record<string, string>
}

type RailSegment = LatLng[]

let assetPromise: Promise<RailGeometryAsset | null> | null = null
let loadedAsset: RailGeometryAsset | null = null
const decoded = new Map<string, RailSegment>()
const measurements = new WeakMap<RailSegment, { cumulative: number[]; total: number }>()

/** Fetch the immutable-ish public asset once per browser session.
 *  It is deliberately *not* statically imported: at ~6 MB the bundler would
 *  inline it into the client chunk, and parsing that much JS before first
 *  paint is seconds of blocked main thread on a phone. Fetching it keeps the
 *  cost off the critical path (and off the bundle) — callers render straight
 *  chords, or nothing, until it lands. */
export function loadRailGeometry(): Promise<RailGeometryAsset | null> {
  if (loadedAsset) return Promise.resolve(loadedAsset)
  if (!assetPromise) {
    assetPromise = fetch('/data/rail-segments.json', { cache: 'force-cache' })
      .then(async (response) => {
        if (!response.ok) return null
        const value: unknown = await response.json()
        if (!value || typeof value !== 'object') return null
        const asset = value as Partial<RailGeometryAsset>
        if (asset.version !== 1 || asset.encoding !== 'google-polyline6') return null
        if (!asset.segments || typeof asset.segments !== 'object') return null
        return asset as RailGeometryAsset
      })
      .catch(() => null)
      .then((asset) => {
        // Keep successful loads for the session, but allow a transient 404,
        // network failure, or dev-server restart to be retried by the caller.
        if (asset) loadedAsset = asset
        assetPromise = null
        return asset
      })
  }
  return assetPromise
}

/** Decode a Google encoded polyline with six decimal places. */
function decodePolyline(encoded: string): RailSegment {
  const points: RailSegment = []
  let index = 0
  let lat = 0
  let lng = 0

  while (index < encoded.length) {
    const deltas: number[] = []
    for (let coordinate = 0; coordinate < 2; coordinate += 1) {
      let shift = 0
      let value = 0
      let byte = 0
      do {
        if (index >= encoded.length) throw new Error('truncated rail polyline')
        byte = encoded.charCodeAt(index) - 63
        index += 1
        value |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      deltas.push(value & 1 ? ~(value >> 1) : value >> 1)
    }
    lat += deltas[0]
    lng += deltas[1]
    points.push({ lat: lat / 1e6, lng: lng / 1e6 })
  }
  return points
}

function key(fromId: string, toId: string): string {
  return `${fromId}:${toId}`
}

function straightSegment(train: Train, index: number): RailSegment {
  const from = train.stops[index]
  const to = train.stops[index + 1]
  return [
    { lat: from.lat, lng: from.lng },
    { lat: to.lat, lng: to.lng },
  ]
}

/** Return the routed segment, or its guaranteed straight-line fallback. */
export function getRailSegment(
  train: Train,
  index: number,
  asset: RailGeometryAsset | null
): RailSegment {
  const from = train.stops[index]
  const to = train.stops[index + 1]
  if (!asset) return straightSegment(train, index)

  const segmentKey = key(from.stationId, to.stationId)
  let encoded = asset.segments[segmentKey]
  let reverse = false
  // The railway is bidirectional. Older/generated snapshots can contain only
  // the opposite direction for a pair, so reuse that geometry reversed rather
  // than dropping all the way to a straight chord.
  if (!encoded) {
    const reverseKey = key(to.stationId, from.stationId)
    encoded = asset.segments[reverseKey]
    reverse = Boolean(encoded)
  }
  if (!encoded) return straightSegment(train, index)
  const cached = decoded.get(segmentKey)
  if (cached) return cached
  try {
    const points = decodePolyline(encoded)
    if (points.length >= 2) {
      const routed = reverse ? [...points].reverse() : points
      decoded.set(segmentKey, routed)
      return routed
    }
  } catch {
    // A malformed/stale asset must degrade to the same straight fallback.
  }
  return straightSegment(train, index)
}

function distanceMeters(a: LatLng, b: LatLng): number {
  const radius = 6_371_000
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const dLat = lat2 - lat1
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * radius * Math.asin(Math.sqrt(h))
}

function measureSegment(segment: RailSegment): { cumulative: number[]; total: number } {
  const cached = measurements.get(segment)
  if (cached) return cached

  const cumulative = [0]
  for (let index = 1; index < segment.length; index += 1) {
    cumulative.push(cumulative[index - 1] + distanceMeters(segment[index - 1], segment[index]))
  }
  const measured = { cumulative, total: cumulative.at(-1) ?? 0 }
  measurements.set(segment, measured)
  return measured
}

/** Point at fraction `t` along a segment's cumulative distance. */
function locationAlong(
  segment: RailSegment,
  t: number
): { position: LatLng; bearing: number; toIndex: number } {
  if (segment.length < 2) {
    return {
      position: segment[0] ?? { lat: 0, lng: 0 },
      bearing: 0,
      toIndex: 0,
    }
  }
  const { cumulative, total } = measureSegment(segment)
  if (total <= 0) {
    return {
      position: segment[0],
      bearing: bearing(segment[0], segment.at(-1) ?? segment[0]),
      toIndex: 1,
    }
  }

  const target = Math.min(1, Math.max(0, t)) * total
  let low = 1
  let high = cumulative.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (cumulative[middle] < target) low = middle + 1
    else high = middle
  }

  const toIndex = low
  const fromIndex = Math.max(0, toIndex - 1)
  const from = segment[fromIndex]
  const to = segment[toIndex]
  const length = cumulative[toIndex] - cumulative[fromIndex]
  const fraction = length > 0 ? (target - cumulative[fromIndex]) / length : 0
  return {
    position: lerp(from, to, fraction),
    bearing: bearing(from, to),
    toIndex,
  }
}

/** Point at fraction `t` along a segment's cumulative distance. */
function pointAlong(segment: RailSegment, t: number): { position: LatLng; bearing: number } {
  const { position, bearing: heading } = locationAlong(segment, t)
  return { position, bearing: heading }
}

/** Render a live marker on the current routed segment. */
export function liveRailPosition(train: TrainLive, asset: RailGeometryAsset | null): { position: LatLng; bearing: number } {
  return pointAlong(getRailSegment(train, train.fromIndex, asset), train.segmentProgress)
}

/** Advance a server snapshot in real time without waiting for the next poll. */
export function liveSegmentProgressAt(
  train: TrainLive,
  elapsedMs: number
): number {
  const duration = Math.max(1, train.segmentDurationMs)
  const movingElapsed = Math.max(0, elapsedMs - train.segmentStartsInMs)
  return train.segmentProgress + movingElapsed / duration
}

export function liveRailPositionAt(
  train: TrainLive,
  asset: RailGeometryAsset | null,
  elapsedMs: number
): { position: LatLng; bearing: number } {
  const progress = liveSegmentProgressAt(train, elapsedMs)
  return pointAlong(getRailSegment(train, train.fromIndex, asset), progress)
}

function appendUnique(target: LatLng[], points: LatLng[]): void {
  for (const point of points) {
    const previous = target.at(-1)
    if (!previous || previous.lat !== point.lat || previous.lng !== point.lng) {
      target.push(point)
    }
  }
}

/** Split the routed line at the train's current progress point. */
export function splitStitchedRoute(
  train: TrainLive,
  asset: RailGeometryAsset | null,
  segmentProgress = train.segmentProgress
): { traveled: LatLng[]; remaining: LatLng[] } {
  const traveled: LatLng[] = []
  const remaining: LatLng[] = []
  const currentIndex = Math.min(
    Math.max(0, train.fromIndex),
    train.stops.length - 2
  )

  for (let index = 0; index < train.stops.length - 1; index += 1) {
    const segment = getRailSegment(train, index, asset)
    if (index < currentIndex) {
      appendUnique(traveled, segment)
    } else if (index > currentIndex) {
      appendUnique(remaining, segment)
    } else {
      const { position, toIndex } = locationAlong(segment, segmentProgress)
      appendUnique(traveled, [...segment.slice(0, toIndex), position])
      appendUnique(remaining, [position, ...segment.slice(toIndex)])
    }
  }

  return { traveled, remaining }
}
