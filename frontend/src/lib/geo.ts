import type { LatLng, Train } from './types'

/** Linear interpolation between two coordinates. */
export function lerp(a: LatLng, b: LatLng, t: number): LatLng {
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
export function bearing(a: LatLng, b: LatLng): number {
  const latRad = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  const dx = (b.lng - a.lng) * Math.cos(latRad)
  const dy = b.lat - a.lat
  const deg = Math.atan2(dx, dy) * (180 / Math.PI)
  return (deg + 360) % 360
}

/** The ordered station coordinates that make up a train's route polyline.
 *  Coordinates are embedded in each stop, so no station lookup is needed. */
export function routeCoords(train: Train): LatLng[] {
  return train.stops.map((s) => ({ lat: s.lat, lng: s.lng }))
}
