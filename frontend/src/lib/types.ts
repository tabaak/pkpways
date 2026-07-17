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
  | 'IC' // PKP Intercity
  | 'EIP' // PKP Intercity Premium (Pendolino) — a service category, not a carrier
  | 'POL' // Polregio (API code "PR")
  | 'KM' // Koleje Mazowieckie
  | 'SKM' // Szybka Kolej Miejska (Warszawa)
  | 'SKMT' // PKP SKM w Trójmieście (API codes "SKMT" / "SKM_3M")
  | 'KD' // Koleje Dolnośląskie
  | 'KS' // Koleje Śląskie
  | 'KML' // Koleje Małopolskie (API codes "KMŁ" / "20")
  | 'KW' // Koleje Wielkopolskie
  | 'LKA' // Łódzka Kolej Aglomeracyjna (API code "ŁKA")
  | 'WKD' // Warszawska Kolej Dojazdowa
  | 'ARRIVA' // Arriva RP (API code "AR")
  | 'LEO' // Leo Express
  | 'RJ' // RegioJet
  | 'RP' // Railpolonia
  | 'ODEG' // Ostdeutsche Eisenbahn
  | 'CARGO' // PKP Cargo (freight)
  | 'SKPL' // SKPL Cargo
  | 'PARWOL' // Parowozownia Wolsztyn (heritage steam)
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
  /** Time to hold at the current station before advancing along the segment. */
  segmentStartsInMs: number
  /** Index of the stop the train most recently left. */
  fromIndex: number
  /** Index of the stop the train is heading toward. */
  toIndex: number
  /** Worst delay currently on the route, in minutes. */
  delay: number
}

export type Theme = 'light' | 'dark'
export type Lang = 'pl' | 'en'
