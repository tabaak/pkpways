import { getStation } from './stations'
import type { LatLng, Train, TrainLive } from './types'

/** Linear interpolation between two coordinates. */
function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  }
}

/**
 * Bearing (degrees, 0 = north, clockwise) from point `a` to point `b`.
 * Longitude deltas are scaled by cos(lat) so directions look correct on a
 * Web-Mercator map.
 */
function bearing(a: LatLng, b: LatLng): number {
  const latRad = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  const dx = (b.lng - a.lng) * Math.cos(latRad)
  const dy = b.lat - a.lat
  const deg = Math.atan2(dx, dy) * (180 / Math.PI)
  return (deg + 360) % 360
}

/** The ordered station coordinates that make up a train's route polyline. */
export function routeCoords(train: Train): LatLng[] {
  return train.stops.map((s) => {
    const st = getStation(s.stationId)
    return { lat: st.lat, lng: st.lng }
  })
}

/**
 * Resolve a train + animation phase (0..1 along its whole route) into a live
 * position, heading, and the surrounding stop indices.
 */
export function toLive(train: Train, phase: number): TrainLive {
  const coords = routeCoords(train)
  const segments = coords.length - 1
  const clamped = Math.min(Math.max(phase, 0), 0.999999)
  const scaled = clamped * segments
  const fromIndex = Math.floor(scaled)
  const toIndex = Math.min(fromIndex + 1, coords.length - 1)
  const segT = scaled - fromIndex

  const from = coords[fromIndex]
  const to = coords[toIndex]
  const position = lerp(from, to, segT)
  const heading = bearing(from, to)

  const delay = train.stops.reduce((max, s) => Math.max(max, s.delay), 0)

  return {
    ...train,
    position,
    bearing: heading,
    fromIndex,
    toIndex,
    delay,
  }
}

/** Advance every train's phase by the elapsed time and return live snapshots. */
export function tickTrains(trains: Train[], elapsedMs: number): TrainLive[] {
  return trains.map((t) => {
    // Loop the phase so trains keep gliding for the demo.
    const phase = (t.phase + t.speed * elapsedMs) % 1
    return toLive(t, phase)
  })
}
