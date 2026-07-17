# 🚂 PkpWays — Live Polish Railway Map

> A real-time interactive map showing trains moving across the Polish railway network.
> Built with **Next.js 16**, **Leaflet**, and the **PKP PLK Open Data API**.

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![Leaflet](https://img.shields.io/badge/Leaflet-Interactive_Map-199900?logo=leaflet)](https://leafletjs.com)
[![PKP PLK API](https://img.shields.io/badge/PKP_PLK-Open_Data_API-003366)](https://pdp-api.plk-sa.pl)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org)

---

## 📖 Overview

PkpWays is a portfolio project that visualizes live train positions on an interactive map of Poland. Since the PKP PLK API provides station-by-station arrival/departure data (not raw GPS coordinates), trains are shown as **interpolated moving markers** between stations — the same technique used by [Portal Pasażera](https://portalpasazera.pl/).

### Key Features

- **🗺️ Interactive Map** — Full-screen Leaflet map with OpenStreetMap tiles, centered on Poland
- **🚄 Live Train Markers** — Train icons moving along generated railway geometry based on real-time schedule + delay data
- **🛤️ Railway-accurate routes** — Selected routes follow OSM railway tracks, with straight-line fallback where routing is unavailable
- **🔍 Train Search** — Search by train number to find and track any specific train
- **📋 Train Details Panel** — Click any train to see route, stops, delays, and carrier info
- **🎛️ Carrier Filters** — Filter by carrier (PKP Intercity, Polregio, Koleje Mazowieckie, SKM, etc.)
- **🌐 Bilingual** — Full PL/EN language toggle
- **🌙 Dark Mode** — Dark map theme option

### Current Status

| Component | State |
|-----------|-------|
| `data-sync` worker | ✅ Live — polling the real PKP API into Postgres + Redis |
| Postgres 18 + Redis | ✅ Live — running via Docker Compose on the VPS |
| Database schema | ✅ Applied (`stations`, `trains`, `train_runs`) |
| Station geocoding (lat/lng) | ✅ Done — **2,953 / 2,964** stations have coordinates (see [Station Coordinates](#-station-coordinates--geocoding)) |
| Static railway geometry | ✅ Generated — **7,985** directed pairs, **120** straight-line fallbacks (see [Railway geometry](#-railway-geometry)) |
| `frontend/` map UI | ✅ Wired — reads live data via `GET /api/trains` (see [Frontend](#-frontend-nextjs)) |

---

## 📁 Repository Structure

Two independent, separately-deployable parts that only ever talk to each other through Postgres/Redis (never directly), plus a root-level Docker Compose stack that runs the datastores and the worker.

```
pkpways/
├── docker-compose.yml   # Postgres 18 + Redis + data-sync worker (the deploy unit)
├── schema.sql           # PostgreSQL schema, auto-applied on first DB init
├── .env.example         # Template for the single root .env (passwords + API key)
├── frontend/            # Next.js 16 app (the map UI) — reads Redis/Postgres, never the PKP API
├── data-sync/           # Python worker: the ONLY thing that calls the PKP PLK API
    ├── main.py               # Poll loop + Postgres/Redis writers
    ├── geocode_stations.py   # One-off: backfills stations.latitude/longitude
    ├── Dockerfile            # Built as the compose `data-sync` service
    └── requirements.txt
└── tools/rail-routing/    # Offline OSRM profile + static geometry generator
```

- **`data-sync/`** owns the `PKP_API_KEY` and is the sole caller of the PKP PLK API. It writes fresh data on a polling loop.
- **`frontend/`** reads from Redis/Postgres to render the map. It never calls the PKP PLK API directly.
- **Root `.env`** is the single source of secrets. Docker Compose injects them into all three services (see [Configuration](#-configuration)).

> Note: local API-probe scripts (`operations.py`, `schedules.py`, `schedules.json`) are **gitignored** dev helpers for inspecting raw API responses and are not part of the deployable app.

---

## 🏗️ Architecture

### Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Framework** | Next.js 16 (App Router) | SSR, API routes, React 19 |
| **Map** | Leaflet + react-leaflet | Free, lightweight, OSM tiles |
| **Styling** | Tailwind CSS v4 | Utility-first, dark mode |
| **Language** | TypeScript 5 | Type safety for API responses |
| **Database** | PostgreSQL 18 | Warm storage: station coords, train identity, live runs |
| **Cache** | Redis 8 | Hot cache of live operations for the frontend |
| **Worker** | Python 3.12 (`requests`, `psycopg2`, `redis`) | Polls the PKP API on a loop |
| **Runtime** | Docker Compose on a VPS | Datastores + worker in one stack |
| **API Source** | PKP PLK Open Data API | Official railway data source |

### Data Flow

The datastores decouple user traffic from the PKP PLK API: the worker hits the API once per cycle, and any number of users read from Redis/Postgres.

```
Users ──► Next.js App ──► Redis (hot cache) ──► PostgreSQL (warm storage)
                                                        ▲
                                     data-sync worker   │  (polls, then upserts)
                                                        │
                                              PKP PLK Open Data API
```

**How the worker runs (`data-sync/main.py`):**

- **Live loop (every `POLL_INTERVAL_SECONDS`, default 30s):** `GET /operations?fullRoutes=true&withPlanned=true` for **all national trains** → upserts every run into `train_runs` (whole route as JSONB), and mirrors the **currently-relevant** ones (yesterday/today/tomorrow) into Redis — see [Redis cache layout](#redis-cache-layout).
- **Daily job (on Warsaw calendar-date rollover / first boot):** `GET /schedules` → upserts train identity into `trains`; then prunes `train_runs` rows before yesterday (yesterday is retained for overnight runs and Redis warm-starts).
- **Station names** are seeded from the `stations` id→name map **embedded in the `/operations` response** (only newly-seen ids each cycle), so no separate dictionary endpoint is needed.

> ⚠️ **Cycle time is data-bound.** The `/operations` full-route payload covers the entire national fleet (~40k runs across a rolling week), so one cycle measures **~70–85s** (of which ~55–70s is the paginated fetch). `POLL_INTERVAL_SECONDS` is a **floor**, not a guarantee — if a cycle runs longer, the next starts immediately (zero sleep). If you need faster refresh later, filter by station/carrier (the API supports `carriersInclude` + station filters) or split the cadence.

### Redis cache layout

| Key | Value | TTL |
|-----|-------|-----|
| `operation:<scheduleId>:<orderId>:<operatingDate>` | one train's full `/operations` object (JSON) | `CACHE_TTL_SECONDS` (default 1800) |
| `operations:index` | JSON array of all cached `<scheduleId>:<orderId>:<operatingDate>` keys | none |

The index is deliberately non-expiring, while every referenced operation value
has a TTL. This protects the index from Redis's `volatile-lfu` eviction policy;
if a value expires or is evicted, the read layer simply skips that missing MGET
result. The worker replaces the index only after a complete cache write.

> ⚠️ **The cache key MUST include `operatingDate`.** `(scheduleId, orderId)` looks unique but is not — it's only a primary key in `train_runs` *together with* `operating_date`, because `/operations` returns a rolling ~7-day window in which the same pair recurs on multiple dates. The key originally omitted the date, so **21,746 of 39,839 trains silently overwrote each other**, and the survivor for a given key was an arbitrary date (often days stale). The read layer then correctly rejected almost all of them as "past their last arrival" — the map rendered nothing while the worker logged perfect health.

> ⚠️ **Only current runs are cached.** The worker keeps just `operatingDate ∈ {yesterday, today, tomorrow}` (Warsaw) — yesterday for overnight runs still in flight, tomorrow for ones departing just after midnight. Caching the full 7-day window meant ~40k keys / ~313 MB, and since the read layer must deserialise a record to discover the run is long finished, a full read took **~100 s** — far past the client's poll timeout, so the request never returned.

> ⚠️ **The TTL must comfortably outlive a full poll cycle** — this is a trap worth understanding. It used to be `POLL_INTERVAL_SECONDS × 3` (= 90s), which was fine when the worker burst-paginated and finished in seconds. Once rate-limit handling added an inter-page delay, a cycle grew past 90s and **every batch of keys expired before its replacement was written** — Redis sat empty for most of each cycle and the map rendered nothing, while the worker looked perfectly healthy. The TTL is now independent of the poll interval and generous by default. Stale entries are harmless: each one carries its full route, and the read layer drops any train past its last arrival, so an old key self-filters rather than showing a ghost train. The TTL exists only to evict trains the API stops reporting.

---

## 🗄️ Database Schema

Defined in `schema.sql` (PostgreSQL 18), auto-applied on first DB init. Three tables, **live-only** (old runs pruned daily). All keyed by `(scheduleId, orderId)`.

### `stations` — coordinates cache
The one thing the API never provides. Seeded id + name from `/operations`; `latitude`/`longitude` are backfilled by `geocode_stations.py`.

| Column | Type | Notes |
|--------|------|-------|
| `pkp_id` | `INTEGER PK` | `stationId` from the API |
| `name` | `TEXT` | station name |
| `latitude`, `longitude` | `NUMERIC(9,6)` | NULL only for the 11 unmatched stations |
| `geocode_source` | `TEXT` | `'overpass'` \| `'nominatim'` \| `'manual'` |
| `geocode_confidence` | `TEXT` | `'high'` \| `'low'` \| `'unmatched'` |

### `trains` — train identity
Number, optional public name, carrier, and commercial category. Fed daily from
`/schedules`.

| Column | Type | Source (`/schedules` route) |
|--------|------|------------------------------|
| `schedule_id`, `order_id` | `INTEGER` (composite PK) | `scheduleId`, `orderId` |
| `number` | `VARCHAR(30)` | `nationalNumber` |
| `name` | `VARCHAR(200)` | `name` (optional/omitted when unnamed, e.g. present for named IC services) |
| `type` | `VARCHAR(30)` | `commercialCategorySymbol` (e.g. `S1`, `R7`) |
| `carrier_code` | `TEXT` | `carrierCode` (`KM`, `SKM`, `PKP INTERCITY`, …) |

### `train_runs` — live runs (hot path)
The `/operations` payload; the whole route stored verbatim. Upserted every poll. No FK to `trains` on purpose (a run can appear before its identity row exists → best-effort `LEFT JOIN`).

| Column | Type | Source (`/operations` train) |
|--------|------|-------------------------------|
| `schedule_id`, `order_id`, `operating_date` | (composite PK) | `scheduleId`, `orderId`, `operatingDate` |
| `train_status` | `TEXT` | `trainStatus` (e.g. `"C"`) |
| `stops` | `JSONB` | the train's whole `stations` array, verbatim |

> **🔑 `(schedule_id, order_id)` is NOT unique** — `operating_date` is part of the PK for a reason. `/operations` returns a rolling ~7-day window, and the same `(scheduleId, orderId)` recurs across dates: one run per day. Any identifier you build from the pair alone (a cache key, a map key, a React key) **will collide** and silently keep an arbitrary date's run. This already cost us the Redis cache once — see [Redis cache layout](#redis-cache-layout).

> **⏱️ Where delays live:** there is **no delay column**. Delays are per-stop **inside `train_runs.stops`** — each stop object has `arrivalDelayMinutes` / `departureDelayMinutes`. These keys are **absent when the delay is zero** (treat missing as `0`). A train's "current" delay = the delay at its most-recently-passed or next stop, determined by comparing `actual*`/`planned*` timestamps against now (Europe/Warsaw).

Example — max delay per active run:
```sql
SELECT schedule_id, order_id,
       max((s->>'departureDelayMinutes')::int) AS max_dep_delay
FROM train_runs, jsonb_array_elements(stops) AS s
WHERE operating_date = CURRENT_DATE
GROUP BY schedule_id, order_id;
```

---

## 🔌 PKP PLK API

| Property | Value |
|----------|-------|
| **Base URL** | `https://pdp-api.plk-sa.pl/api/v1` |
| **Auth** | `X-API-Key` header |
| **Format** | JSON |
| **Rate Limits** | Basic: 100/hr, 1k/day · Standard: 500/hr, 5k/day · Premium: 2,000/hr, 20k/day |
| **Docs** | [Swagger](https://pdp-api.plk-sa.pl/swagger) · [Scalar](https://pdp-api.plk-sa.pl/scalar/v1) |

> **Timestamps have no timezone** (e.g. `"2026-07-07T08:29:00"`). Treat them as **Europe/Warsaw** local time.

### Rate limiting

A full `/operations` sweep is ~40 pages, so **burst-paginating a cycle will trip `429 Too Many Requests`** — that's what exhausted the Basic tier (100/hr). The client now:

- Sleeps **1s between pages**, so a cycle drips rather than bursts.
- Retries `429`s with exponential backoff (max 5 attempts, capped at 120s), honouring `Retry-After` when present — as either a seconds count or an HTTP-date.

Note the knock-on effect: this makes a cycle take **minutes**, which is exactly why the Redis TTL can't be derived from `POLL_INTERVAL_SECONDS`.

### Endpoints the worker uses

| Endpoint | Purpose | Cadence |
|----------|---------|---------|
| `GET /operations?fullRoutes=true&withPlanned=true` | Every running train, whole route + per-stop delays inline | Every poll |
| `GET /schedules` | Train identity (number, carrier, category) | Daily |

### Confirmed response shapes

Verified against real API output (2026-07-07).

**`GET /operations`**
```jsonc
{
  "pagination": { "page": 1, "pageSize": 10000, "totalCount": 530,
                  "totalPages": 1, "hasNextPage": false },
  "trains": [
    {
      "scheduleId": 2026, "orderId": 460375541, "trainOrderId": 692917841,
      "operatingDate": "2026-07-07", "trainStatus": "C",
      "stations": [
        {
          "stationId": 251603,
          "plannedSequenceNumber": 3, "actualSequenceNumber": 3,
          "plannedArrival": "2026-07-07T08:34:30",
          "plannedDeparture": "2026-07-07T08:35:00",
          "actualArrival": "2026-07-07T08:35:30",
          "actualDeparture": "2026-07-07T08:36:00",
          "arrivalDelayMinutes": 1, "departureDelayMinutes": 1,
          "isConfirmed": true
        }
        // ...whole route (delay keys are absent when 0)
      ]
    }
  ],
  "stations": { "251603": "Warszawa Ursus Niedźwiadek", "38851": "Józefów" }
}
```

**`GET /schedules`**
```jsonc
{
  "period": { "from": "...", "to": "..." },
  "routes": [
    {
      "scheduleId": 2026, "orderId": 669670523, "trainOrderId": 581138886,
      "carrierCode": "KM", "nationalNumber": "91336",
      "commercialCategorySymbol": "R7", "operatingDates": ["2026-07-07"],
      "stations": [ /* planned timetable per stop */ ]
    }
  ],
  "dictionaries": { /* incl. a stations id→name map */ }
}
```

Pagination: both endpoints use `pagination.hasNextPage`; the worker requests `pageSize=10000` and follows pages until exhausted.

---

## 🧮 Train Position Interpolation

The core challenge: **the API gives station-level arrival/departure times and delays, not GPS coordinates.** Positions are computed server-side in `frontend/src/lib/server/datastore.ts` (`toLive()`):

1. Take the train's stops from its cached `/operations` object, keeping only stops whose station has coordinates (a train needs ≥2 to be placeable).
2. Compute each stop's **effective** times: `actual ?? planned + delayMinutes`.
3. Find the segment where *now* falls between one stop's effective departure and the next stop's effective arrival. A train before its first departure or past its last arrival returns `null` — so **only en-route trains are rendered**.
4. Compute time progress `t` and the effective segment duration
   (`reach - leave`). The API returns both as `segmentProgress` and
   `segmentDurationMs`, together with the instant at which the snapshot was
   sampled.
5. The browser advances `t` continuously from that sampled instant and places
   the marker by cumulative distance along the routed railway geometry. Fresh
   15-second snapshots correct the position without making movement depend on
   the polling cadence. Straight station-to-station interpolation remains the
   fallback when geometry is unavailable.

**Timezone handling:** API timestamps are naive (no offset) and mean Europe/Warsaw. Rather than convert, both the stop times and "now" are compared in the same **pseudo-UTC frame** — the wall-clock digits are read as if they were UTC, and `warsawNowMs()` derives the current time the same way. Two wrongs cancel; the comparison is correct and DST-safe.

### 🛤️ Railway geometry

The selected-route polyline and live marker use the generated static asset at
`frontend/public/data/rail-segments.json`. It contains **7,985 directed station
pairs** generated from the live database's located route sequences:

- The one-off generator is [`tools/rail-routing/generate_rail_geometry.py`](tools/rail-routing/generate_rail_geometry.py).
- The temporary OSRM railway profile and exact Poland-extract setup are documented in [`tools/rail-routing/README.md`](tools/rail-routing/README.md).
- The committed snapshot is 6,028,760 bytes, with 7,865 routed pairs and 120 logged straight-line fallbacks.
- Generation validates every final Google polyline6 value with the same decoding rules used by the browser before writing the asset. A malformed segment must fail the job rather than degrade to a straight line at runtime.
- Regenerate it after timetable or network changes; the live worker and Redis hot path never carry these polylines.

### 📍 Station Coordinates — Geocoding

The API never returns coordinates, so `data-sync/geocode_stations.py` backfills them in a one-off pass. **Result: 2,953 of 2,964 stations located.**

It is **Overpass-primary, Nominatim-fallback**, and deliberately works in bulk rather than per-station:

- **One** Overpass query fetches every `railway=station|halt|stop` node/way in Poland, then PKP names are matched against that set **locally** — exact match, then diacritic-folded (`ł`→`l`, NFKD), then fuzzy (`difflib`, 0.88 cutoff). Querying Overpass once per station would be ~3,000 requests (throttling/ban risk), and Overpass's `["name"="X"]` is an *exact* string match, so it would actually be **more** brittle than matching locally.
- Anything still unmatched optionally falls back to Nominatim (rate-limited to 1 req/1.1s).
- Each row records `geocode_source` and `geocode_confidence` (`high` for an unambiguous exact/folded hit, `low` for fuzzy/ambiguous, `unmatched` for the leftovers).

The pass is **resumable** — it only selects rows `WHERE geocode_source IS NULL`, so it can be re-run safely.

```bash
docker compose exec data-sync python geocode_stations.py
```

---

## 🚀 Deployment (Docker Compose)

The whole backend — Postgres 18, Redis 8, and the `data-sync` worker — runs from the root `docker-compose.yml`.

- **Ports are bound to `127.0.0.1` only** (reachable from the VPS itself, not the public internet). Reach them from a laptop via SSH tunnel: `ssh -L 5432:127.0.0.1:5432 -L 6379:127.0.0.1:6379 user@vps`.
- **Redis is a bounded, non-persistent cache** (`768mb` dataset / `1g` container by default). AOF and RDB are disabled to avoid write amplification; the worker warms current runs from Postgres on startup.
- **Postgres 18 volume** is mounted at `/var/lib/postgresql` (the parent, not `/data`) — required by the PG18 image.
- **`schema.sql` runs only on first init** (empty data volume). To re-apply after changes: `docker compose exec -T postgres psql -U pkpways -d pkpways < schema.sql`, or `docker compose down -v` to wipe and re-init.

```bash
cp .env.example .env        # then fill in passwords + PKP_API_KEY
docker compose up -d --build
docker compose ps           # postgres + redis should be (healthy)
docker compose logs -f data-sync
```

Healthy worker logs look like:
```
Startup: warmed 14715 current run(s) into Redis
Daily: upserted 7252 train identity row(s)
Daily: pruned 32450 stale train_run(s)
Live: seeded 2965 new station name(s)
Live: 39834 train(s) -> train_runs, 14715 -> Redis (ttl 1800s) [fetch 68s, cycle 83s]
```

Two numbers to watch on that last line:

- **`-> Redis` is much smaller than `-> train_runs`** — and should be. Postgres keeps every run in the API's rolling week; Redis keeps only the currently-relevant ones. If the two are equal, the operating-date filter isn't running.
- **`cycle`** must stay well under `CACHE_TTL_SECONDS`. If it approaches it, keys start expiring before their replacements are written and the map blanks out.

Verify data landed:
```bash
docker compose exec postgres psql -U pkpways -d pkpways -c \
  "SELECT (SELECT count(*) FROM train_runs) runs, (SELECT count(*) FROM trains) trains, (SELECT count(*) FROM stations) stations;"
```

---

## ⚙️ Configuration

**One root `.env`** (gitignored) holds all secrets. Docker Compose builds each service's env from it — including `DATABASE_URL`/`REDIS_URL`, which use the compose service hostnames **`postgres`/`redis`** (not `localhost`).

| Variable | Used by | Notes |
|----------|---------|-------|
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | postgres | DB credentials |
| `REDIS_PASSWORD` | redis | Redis auth |
| `REDIS_MAXMEMORY` | redis | default `768mb` — maximum Redis dataset size before volatile operation values are evicted |
| `REDIS_CONTAINER_MEMORY` | redis | default `1g` — hard container ceiling, leaving allocator/runtime headroom above `maxmemory` |
| `PKP_API_KEY` | data-sync | **The only secret the worker strictly needs** |
| `PKP_API_BASE_URL` | data-sync | defaults to `https://pdp-api.plk-sa.pl/api/v1` |
| `POLL_INTERVAL_SECONDS` | data-sync | default `30` (a floor — see [Data Flow](#data-flow)) |
| `CACHE_TTL_SECONDS` | data-sync | default `1800` — Redis key TTL. **Must outlive a full poll cycle** (see [Redis cache layout](#redis-cache-layout)) |
| `REQUEST_TIMEOUT_SECONDS`, `LOG_LEVEL` | data-sync | optional |
| `DATABASE_URL`, `REDIS_URL` | frontend | in `frontend/.env.local` for local dev (via SSH tunnel) |

> **Running the worker standalone (without Docker)** is also supported: it reads `data-sync/.env` and needs `DATABASE_URL` + `REDIS_URL` pointing at `localhost`. In the Compose setup this file is unused — the root `.env` is the single source of truth.

### API Key Security

- **NEVER** commit the API key. The root `.env` (and `data-sync/.env`) are gitignored.
- All PKP API calls happen server-side, exclusively from the `data-sync/` worker; the frontend never sees the key.

---

## 🖥️ Frontend (Next.js)

The app reads live data from Redis/Postgres (never the PKP API directly).

### Read layer

`src/lib/server/datastore.ts` (`import 'server-only'`) is the only thing that touches the datastores:

- Reads `operations:index` from Redis, then batched `MGET`s the `operation:*` keys (2,000 at a time).
- Joins Postgres `stations` (coordinates) and `trains` (number, name, category,
  carrier), both cached 60s.
- Computes each train's live position (see [Interpolation](#-train-position-interpolation)) and memoizes the result for 8s.
- The browser uses the bundled `rail-segments.json` geometry to replace straight
  station hops with routed railway geometry; missing or flagged pairs remain
  straight-line fallbacks. Keeping the asset in the frontend bundle prevents a
  static-file request or cache failure from degrading every route to chords.
- A single shared `requestAnimationFrame` loop advances every marker at about
  20 FPS between API snapshots. Decoded segment distances are cached and the
  current point is found with binary search, avoiding repeated full-polyline
  calculations for hundreds of trains.
- `prefers-reduced-motion: reduce` disables continuous movement and the selected
  marker pulse; those users receive discrete positions when a snapshot arrives.
- Scans every current Redis record and returns every train that is en route and
  has at least two located stations. The rolling ~34–40k Postgres dataset is not
  sent to the browser; finished, not-yet-started, and unmappable runs are
  filtered out first.

`pg.Pool` and `ioredis` clients are singletons pinned to `globalThis` so hot-reload doesn't leak connections.

Stops ship with their `name`/`lat`/`lng` embedded, so the **browser needs no station table at all**.

### API

`GET /api/trains` → `{ trains, count, at }` (`runtime = 'nodejs'`,
`force-dynamic`, `Cache-Control: no-store`). `at` is the time the interpolated
positions were sampled—not merely the HTTP response time—and each train carries
`segmentProgress` plus `segmentDurationMs`. `AppShell` polls every 15 seconds;
the animation loop fills the interval between polls.

### Running it locally

The VPS datastores are bound to `127.0.0.1`, so local dev needs an SSH tunnel:

```bash
ssh -N \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -L 5432:localhost:5432 -L 6379:localhost:6379 \
  oracle_vps
```

```bash
cd frontend
npm install
cp .env.local.example .env.local   # fill in DATABASE_URL / REDIS_URL (passwords from root .env)
npm run dev
```

> ⚠️ Use **`127.0.0.1`**, not `localhost`, in `.env.local`. `ssh -L` binds IPv4 only, while Node resolves `localhost` to `::1` (IPv6) — which produces a confusing `ioredis AggregateError` / `ECONNREFUSED`.

**Troubleshooting an empty map:** if `/api/trains` returns `count: 0` with no error, the read path is fine and the cache is empty. Check `DBSIZE` on Redis — see the TTL warning under [Redis cache layout](#redis-cache-layout).

### Design Philosophy

This is a **portfolio piece** — the design should be stunning:

- **Full-screen map** as the hero element (no unnecessary chrome)
- **Glassmorphism** panels that slide in/out over the map
- **Smooth animations** for train markers gliding between positions
- **Color-coded trains** by carrier (PKP IC = blue, Polregio = red, etc.)
- **Dark mode map** with custom tile styling

---

## ⚠️ Known Limitations

Open items, roughly by how much they'd bite:

- **Cached records are fat (~8.1 KB each).** Each keeps `plannedSequenceNumber`, `actualSequenceNumber`, `isConfirmed` and other fields the map never reads. Slimming the cached shape would cut memory and read time several-fold.
- **Client animation is schedule-derived, not GPS.** Between 15s API polls, markers advance smoothly along the current routed segment using its effective travel duration. A fresh poll corrects the snapshot, but the underlying position remains an interpolation of timetable and delay data.
- **No viewport culling or clustering.** Every currently moving, placeable train
  is rendered, so marker cost grows with the number of simultaneous runs.
- **The full route ships with every marker.** Only the *selected* train needs its route; splitting that into `/api/trains/[id]` would shrink the payload substantially.

---

## 🔗 Useful Links

- [PKP PLK API Documentation](https://pdp-api.plk-sa.pl/api-documentation) · [Swagger](https://pdp-api.plk-sa.pl/swagger) · [Scalar](https://pdp-api.plk-sa.pl/scalar/v1)
- [Portal Pasażera (reference)](https://portalpasazera.pl/)
- [Leaflet](https://leafletjs.com/reference.html) · [react-leaflet](https://react-leaflet.js.org/)
- [OpenRailwayMap](https://www.openrailwaymap.org/)
