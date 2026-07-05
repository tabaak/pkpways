// Domain types for the PkpWays UI. This is a UI-only build, so these describe
// the shape of the *mock* data — they intentionally mirror what the real
// PKP PLK API + interpolation layer would eventually provide.

export type LatLng = {
  lat: number
  lng: number
}

export type Station = LatLng & {
  id: string
  /** Display name, e.g. "Warszawa Centralna". */
  name: string
}

export type CarrierId =
  | 'IC'
  | 'EIP'
  | 'POL'
  | 'KM'
  | 'SKM'
  | 'KD'
  | 'KS'

export type Carrier = {
  id: CarrierId
  /** Short badge label, e.g. "IC". */
  code: string
  /** Full carrier name, e.g. "PKP Intercity". */
  name: string
  /** Brand-ish hex color used for the marker + accents. */
  color: string
}

/** A single scheduled stop on a train's route. */
export type RouteStop = {
  stationId: string
  /** Planned arrival "HH:MM" (null for the origin). */
  arrival: string | null
  /** Planned departure "HH:MM" (null for the final stop). */
  departure: string | null
  /** Real-time delay in minutes (0 = on time). */
  delay: number
}

export type Train = {
  id: string
  /** e.g. "IC 3512". */
  number: string
  /** Optional service name, e.g. "Mazowsze". */
  name?: string
  carrierId: CarrierId
  /** Ordered list of stops (>= 2). */
  stops: RouteStop[]
  /**
   * Animation phase 0..1 — where on its route the train currently sits.
   * Used by the mock animation loop to glide markers between stations.
   */
  phase: number
  /** Full route length in "phase units per ms" — controls apparent speed. */
  speed: number
}

/** A live snapshot of a train, computed for a given clock tick. */
export type TrainLive = Train & {
  position: LatLng
  /** Heading in degrees (0 = north, clockwise). */
  bearing: number
  /** Index of the stop the train most recently left. */
  fromIndex: number
  /** Index of the stop the train is heading toward. */
  toIndex: number
  /** Worst delay currently on the route, in minutes. */
  delay: number
}

export type Theme = 'light' | 'dark'
export type Lang = 'pl' | 'en'
