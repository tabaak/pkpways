import 'server-only'

import Redis from 'ioredis'
import { Pool } from 'pg'
import { resolveCarrierId } from '@/lib/carriers'
import { bearing, lerp } from '@/lib/geo'
import type { CarrierId, RouteStop, TrainLive } from '@/lib/types'

// --------------------------------------------------------------------------- //
// Singletons (survive dev hot-reloads via globalThis)
// --------------------------------------------------------------------------- //
type Globals = {
  _pkpPool?: Pool
  _pkpRedis?: Redis
}
const g = globalThis as unknown as Globals

function pool(): Pool {
  if (!g._pkpPool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is not set')
    g._pkpPool = new Pool({ connectionString, max: 4 })
  }
  return g._pkpPool
}

function redis(): Redis {
  if (!g._pkpRedis) {
    const url = process.env.REDIS_URL
    if (!url) throw new Error('REDIS_URL is not set')
    g._pkpRedis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false })
  }
  return g._pkpRedis
}

// Cap on markers returned to the browser. The national fleet is far too many to
// render at once; this keeps Leaflet responsive. Raise/lower via env.
const MAX_TRAINS = Number(process.env.MAX_TRAINS ?? 1500)

// --------------------------------------------------------------------------- //
// Reference-data caches (stations + train identity change slowly)
// --------------------------------------------------------------------------- //
type StationRow = { name: string; lat: number; lng: number }
type IdentityRow = {
  number: string
  name: string | null
  category: string | null
  carrierId: CarrierId
}

type RefCache<T> = { data: T; at: number }
const REF_TTL_MS = 60_000

let stationCache: RefCache<Map<number, StationRow>> | null = null
let identityCache: RefCache<Map<string, IdentityRow>> | null = null

async function getStations(): Promise<Map<number, StationRow>> {
  if (stationCache && Date.now() - stationCache.at < REF_TTL_MS) return stationCache.data
  const { rows } = await pool().query(
    `SELECT pkp_id, name, latitude, longitude
       FROM stations
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
  )
  const map = new Map<number, StationRow>()
  for (const r of rows) {
    map.set(r.pkp_id, { name: r.name, lat: Number(r.latitude), lng: Number(r.longitude) })
  }
  stationCache = { data: map, at: Date.now() }
  return map
}

async function getIdentities(): Promise<Map<string, IdentityRow>> {
  if (identityCache && Date.now() - identityCache.at < REF_TTL_MS) return identityCache.data
  const { rows } = await pool().query(
    `SELECT schedule_id, order_id, number, name, type, carrier_code FROM trains`
  )
  const map = new Map<string, IdentityRow>()
  for (const r of rows) {
    map.set(`${r.schedule_id}:${r.order_id}`, {
      number: r.number ?? '',
      name: r.name,
      category: r.type,
      carrierId: resolveCarrierId(r.carrier_code, r.type),
    })
  }
  identityCache = { data: map, at: Date.now() }
  return map
}

// --------------------------------------------------------------------------- //
// Time helpers — API timestamps are naive Europe/Warsaw wall-clock.
// We compare everything in a single "pseudo-UTC" frame: treat the wall-clock
// digits as if they were UTC, and derive "now" the same way.
// --------------------------------------------------------------------------- //
function parseNaive(ts: string | null | undefined): number | null {
  if (!ts) return null
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?/.exec(ts)
  if (!m) return null
  return Date.parse(`${m[1]}T${m[2]}${m[3] ?? ':00'}Z`)
}

function warsawNowMs(): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date())
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  const hour = get('hour') === '24' ? '00' : get('hour') // Intl edge case at midnight
  return Date.parse(
    `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}Z`
  )
}

/** "HH:MM" from a naive timestamp, preferring the actual over the planned. */
function hhmm(actual: string | null | undefined, planned: string | null | undefined): string | null {
  const ts = actual ?? planned
  return ts ? ts.slice(11, 16) : null
}

// --------------------------------------------------------------------------- //
// Raw /operations shapes (what the worker caches in Redis verbatim)
// --------------------------------------------------------------------------- //
type RawStop = {
  stationId: number
  plannedArrival?: string | null
  plannedDeparture?: string | null
  actualArrival?: string | null
  actualDeparture?: string | null
  arrivalDelayMinutes?: number | null
  departureDelayMinutes?: number | null
}
type RawTrain = {
  scheduleId: number
  orderId: number
  trainStatus?: string
  stations?: RawStop[]
}

/** Effective arrival time (ms), preferring actual, else planned + delay. */
function arriveMs(s: RawStop): number | null {
  if (s.actualArrival) return parseNaive(s.actualArrival)
  const p = parseNaive(s.plannedArrival)
  return p == null ? null : p + (s.arrivalDelayMinutes ?? 0) * 60_000
}
function departMs(s: RawStop): number | null {
  if (s.actualDeparture) return parseNaive(s.actualDeparture)
  const p = parseNaive(s.plannedDeparture)
  return p == null ? null : p + (s.departureDelayMinutes ?? 0) * 60_000
}

/**
 * Turn one raw /operations train into a live snapshot, or null if it isn't
 * currently en route (not yet departed, already arrived, or unmappable).
 */
function toLive(
  raw: RawTrain,
  stations: Map<number, StationRow>,
  identities: Map<string, IdentityRow>,
  now: number
): TrainLive | null {
  const id = `${raw.scheduleId}:${raw.orderId}`
  const rawStops = raw.stations ?? []

  // Keep only stops whose station we can place on the map, but carry the raw
  // timing alongside so interpolation stays aligned with the rendered stops.
  const located: { stop: RouteStop; arr: number | null; dep: number | null }[] = []
  for (const s of rawStops) {
    const st = stations.get(s.stationId)
    if (!st) continue
    const delay = Math.max(s.arrivalDelayMinutes ?? 0, s.departureDelayMinutes ?? 0)
    located.push({
      stop: {
        stationId: String(s.stationId),
        name: st.name,
        lat: st.lat,
        lng: st.lng,
        arrival: hhmm(s.actualArrival, s.plannedArrival),
        departure: hhmm(s.actualDeparture, s.plannedDeparture),
        delay,
      },
      arr: arriveMs(s),
      dep: departMs(s),
    })
  }
  if (located.length < 2) return null

  // Find the segment [i, i+1] containing `now`: leave time of i .. reach time
  // of i+1. Fall back across missing endpoints so a null time doesn't break it.
  for (let i = 0; i < located.length - 1; i++) {
    const leave = located[i].dep ?? located[i].arr
    const reach = located[i + 1].arr ?? located[i + 1].dep
    if (leave == null || reach == null || reach <= leave) continue
    if (now < leave) {
      // Before the very first departure → not moving yet.
      if (i === 0) return null
      continue
    }
    if (now >= reach) continue // already past this segment

    const t = (now - leave) / (reach - leave)
    const from = located[i].stop
    const to = located[i + 1].stop
    const position = lerp(from, to, t)
    const identity = identities.get(id)
    return {
      id,
      number: identity?.number || id,
      name: identity?.name || undefined,
      category: identity?.category || undefined,
      carrierId: identity?.carrierId ?? 'OTHER',
      stops: located.map((l) => l.stop),
      position,
      bearing: bearing(from, to),
      fromIndex: i,
      toIndex: i + 1,
      // "Current" delay = delay at the stop being approached.
      delay: to.delay,
    }
  }
  return null // scheduled but not started, or already arrived
}

// --------------------------------------------------------------------------- //
// Public API — with a short memo so bursts of polls don't recompute
// --------------------------------------------------------------------------- //
let liveCache: RefCache<TrainLive[]> | null = null
const LIVE_TTL_MS = 8_000

export async function getLiveTrains(): Promise<TrainLive[]> {
  if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.data

  const r = redis()
  const indexJson = await r.get('operations:index')
  if (!indexJson) {
    liveCache = { data: [], at: Date.now() }
    return []
  }
  const runKeys: string[] = JSON.parse(indexJson)
  if (runKeys.length === 0) return []

  const [stations, identities] = await Promise.all([getStations(), getIdentities()])

  const now = warsawNowMs()
  const live: TrainLive[] = []
  // MGET in batches to avoid one enormous command / reply.
  const BATCH = 2000
  for (let i = 0; i < runKeys.length; i += BATCH) {
    const slice = runKeys.slice(i, i + BATCH)
    const values = await r.mget(slice.map((k) => `operation:${k}`))
    for (const v of values) {
      if (!v) continue
      let raw: RawTrain
      try {
        raw = JSON.parse(v)
      } catch {
        continue
      }
      const snapshot = toLive(raw, stations, identities, now)
      if (snapshot) live.push(snapshot)
    }
    if (live.length >= MAX_TRAINS) break
  }

  const capped = live.slice(0, MAX_TRAINS)
  liveCache = { data: capped, at: Date.now() }
  return capped
}
