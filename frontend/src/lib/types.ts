// Domain types for the PkpWays UI. These are produced server-side by the read
// layer (src/lib/server/datastore.ts), which joins the live /operations payload
// in Redis with station coordinates + train identity in Postgres, then computes
// each train's current position. The client consumes the finished TrainLive[].

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
  /** Any carrier we don't brand explicitly (rendered neutral grey). */
  | 'OTHER'

export type Carrier = {
  id: CarrierId
  /** Short badge label, e.g. "IC". */
  code: string
  /** Full carrier name, e.g. "PKP Intercity". */
  name: string
  /** Brand-ish hex color used for the marker + accents. */
  color: string
}

/** A single scheduled stop on a train's route, with its station resolved.
 *  Coordinates are embedded so the client never needs a station lookup table. */
export type RouteStop = {
  stationId: string
  /** Station display name, e.g. "Warszawa Centralna". */
  name: string
  lat: number
  lng: number
  /** Arrival "HH:MM" (null for the origin). */
  arrival: string | null
  /** Departure "HH:MM" (null for the final stop). */
  departure: string | null
  /** Real-time delay in minutes at this stop (0 = on time). */
  delay: number
}

export type Train = {
  /** Stable run id, "scheduleId:orderId:operatingDate". */
  id: string
  /** e.g. "IC 3512". */
  number: string
  /** Optional service name, e.g. "Mazowsze". */
  name?: string
  /** Commercial service/category symbol, e.g. "S2", "R7", or "IC". */
  category?: string
  carrierId: CarrierId
  /** Ordered list of located stops (>= 2). */
  stops: RouteStop[]
}

/** A live snapshot of a train, computed for a given clock tick. */
export type TrainLive = Train & {
  position: LatLng
  /** Heading in degrees (0 = north, clockwise). */
  bearing: number
  /** Time progress through the current station-to-station segment (0..1). */
  segmentProgress: number
  /** Effective travel time for the current segment, used for client animation. */
  segmentDurationMs: number
  /** Index of the stop the train most recently left. */
  fromIndex: number
  /** Index of the stop the train is heading toward. */
  toIndex: number
  /** Worst delay currently on the route, in minutes. */
  delay: number
}

export type Theme = 'light' | 'dark'
export type Lang = 'pl' | 'en'
