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
- **🚄 Live Train Markers** — Animated train icons moving between stations based on real-time schedule + delay data
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
| Station geocoding (lat/lng) | ⏳ TODO — coordinates are still `NULL` (see [Station Coordinates](#-station-coordinates--geocoding)) |
| `frontend/` map UI | 🚧 Scaffolded — not yet reading from the datastores |

---

## 📁 Repository Structure

Two independent, separately-deployable parts that only ever talk to each other through Postgres/Redis (never directly), plus a root-level Docker Compose stack that runs the datastores and the worker.

```
pkpways/
├── docker-compose.yml   # Postgres 18 + Redis + data-sync worker (the deploy unit)
├── schema.sql           # PostgreSQL schema, auto-applied on first DB init
├── .env.example         # Template for the single root .env (passwords + API key)
├── frontend/            # Next.js 16 app (the map UI) — reads Redis/Postgres, never the PKP API
└── data-sync/           # Python worker: the ONLY thing that calls the PKP PLK API
    ├── main.py          # Poll loop + Postgres/Redis writers
    ├── Dockerfile       # Built as the compose `data-sync` service
    └── requirements.txt
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

- **Live loop (every `POLL_INTERVAL_SECONDS`, default 30s):** `GET /operations?fullRoutes=true&withPlanned=true` for **all national trains** → upserts each into `train_runs` (whole route as JSONB) and mirrors each into Redis.
- **Daily job (on calendar-date rollover / first boot):** `GET /schedules` → upserts train identity into `trains`; then prunes `train_runs` rows before today.
- **Station names** are seeded from the `stations` id→name map **embedded in the `/operations` response** (only newly-seen ids each cycle), so no separate dictionary endpoint is needed.

> ⚠️ **Cycle time is data-bound.** The `/operations` full-route payload covers the entire national fleet (~40k trains), so one cycle takes a couple of minutes. `POLL_INTERVAL_SECONDS` is a **floor**, not a guarantee — if a cycle runs longer, the next starts immediately (zero sleep). If you need faster refresh later, filter by station/carrier (the API supports `carriersInclude` + station filters) or split the cadence.

### Redis cache layout

| Key | Value | TTL |
|-----|-------|-----|
| `operation:<scheduleId>:<orderId>` | one train's full `/operations` object (JSON) | `POLL_INTERVAL_SECONDS × 3` |
| `operations:index` | JSON array of all active `<scheduleId>:<orderId>` keys | `POLL_INTERVAL_SECONDS × 3` |

---

## 🗄️ Database Schema

Defined in `schema.sql` (PostgreSQL 18), auto-applied on first DB init. Three tables, **live-only** (old runs pruned daily). All keyed by `(scheduleId, orderId)`.

### `stations` — coordinates cache
The one thing the API never provides. Seeded id + name from `/operations`; `latitude`/`longitude` are geocoded separately (still TODO).

| Column | Type | Notes |
|--------|------|-------|
| `pkp_id` | `INTEGER PK` | `stationId` from the API |
| `name` | `TEXT` | station name |
| `latitude`, `longitude` | `NUMERIC(9,6)` | **NULL until geocoded** |
| `geocode_source` | `TEXT` | `'nominatim'` \| `'manual'` |
| `geocode_confidence` | `TEXT` | `'high'` \| `'low'` \| `'unmatched'` |

### `trains` — train identity
Number, carrier, type. Fed daily from `/schedules`.

| Column | Type | Source (`/schedules` route) |
|--------|------|------------------------------|
| `schedule_id`, `order_id` | `INTEGER` (composite PK) | `scheduleId`, `orderId` |
| `number` | `VARCHAR(30)` | `nationalNumber` |
| `name` | `VARCHAR(200)` | (none — always NULL) |
| `type` | `VARCHAR(30)` | `commercialCategorySymbol` (e.g. `S1`, `R7`) |
| `carrier_code` | `TEXT` | `carrierCode` (`KM`, `SKM`, `PKP INTERCITY`, …) |

### `train_runs` — live runs (hot path)
The `/operations` payload; the whole route stored verbatim. Upserted every poll. No FK to `trains` on purpose (a run can appear before its identity row exists → best-effort `LEFT JOIN`).

| Column | Type | Source (`/operations` train) |
|--------|------|-------------------------------|
| `schedule_id`, `order_id`, `operating_date` | (composite PK) | `scheduleId`, `orderId`, `operatingDate` |
| `train_status` | `TEXT` | `trainStatus` (e.g. `"C"`) |
| `stops` | `JSONB` | the train's whole `stations` array, verbatim |

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
| **Rate Limits** | Basic: 100/hr · Standard: 500/hr · Premium: 2,000/hr |
| **Docs** | [Swagger](https://pdp-api.plk-sa.pl/swagger) · [Scalar](https://pdp-api.plk-sa.pl/scalar/v1) |

> **Timestamps have no timezone** (e.g. `"2026-07-07T08:29:00"`). Treat them as **Europe/Warsaw** local time.

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

The core challenge: **the API gives station-level arrival/departure times and delays, not GPS coordinates.** To show trains "moving":

1. Read the run's stops from `train_runs.stops` (planned + actual times).
2. Determine which two stations the train is currently between (compare times against now, Europe/Warsaw).
3. Compute a progress ratio and linearly interpolate lat/lng between those two stations' coordinates.
4. Animate the marker smoothly between polling updates.

This depends on `stations.latitude/longitude`, which is why geocoding is a prerequisite for the moving-marker feature.

### 📍 Station Coordinates — Geocoding

The API never returns coordinates. `stations` rows are seeded with id + name only; `latitude`/`longitude` stay `NULL` until a one-time geocoding pass (planned: Nominatim, with `geocode_source`/`geocode_confidence` recorded, supplemented by [OpenRailwayMap](https://www.openrailwaymap.org/) where needed). **This is the main outstanding task before the map can render moving trains.**

---

## 🚀 Deployment (Docker Compose)

The whole backend — Postgres 18, Redis 8, and the `data-sync` worker — runs from the root `docker-compose.yml`.

- **Ports are bound to `127.0.0.1` only** (reachable from the VPS itself, not the public internet). Reach them from a laptop via SSH tunnel: `ssh -L 5432:127.0.0.1:5432 -L 6379:127.0.0.1:6379 user@vps`.
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
Daily: upserted N train identity row(s)
Live: seeded N new station name(s)
Live: N train(s) -> train_runs + Redis
```

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
| `PKP_API_KEY` | data-sync | **The only secret the worker strictly needs** |
| `PKP_API_BASE_URL` | data-sync | defaults to `https://pdp-api.plk-sa.pl/api/v1` |
| `POLL_INTERVAL_SECONDS` | data-sync | default `30` (a floor — see [Data Flow](#data-flow)) |
| `REQUEST_TIMEOUT_SECONDS`, `LOG_LEVEL` | data-sync | optional |

> **Running the worker standalone (without Docker)** is also supported: it reads `data-sync/.env` and needs `DATABASE_URL` + `REDIS_URL` pointing at `localhost`. In the Compose setup this file is unused — the root `.env` is the single source of truth.

### API Key Security

- **NEVER** commit the API key. The root `.env` (and `data-sync/.env`) are gitignored.
- All PKP API calls happen server-side, exclusively from the `data-sync/` worker; the frontend never sees the key.

---

## 🖥️ Frontend (Next.js)

```bash
cd frontend
npm install
npm run dev
```

The app reads live data from Redis/Postgres (never the PKP API directly). It is currently scaffolded; wiring it to the datastores is upcoming work.

### Design Philosophy

This is a **portfolio piece** — the design should be stunning:

- **Full-screen map** as the hero element (no unnecessary chrome)
- **Glassmorphism** panels that slide in/out over the map
- **Smooth animations** for train markers gliding between positions
- **Color-coded trains** by carrier (PKP IC = blue, Polregio = red, etc.)
- **Dark mode map** with custom tile styling

---

## 🔗 Useful Links

- [PKP PLK API Documentation](https://pdp-api.plk-sa.pl/api-documentation) · [Swagger](https://pdp-api.plk-sa.pl/swagger) · [Scalar](https://pdp-api.plk-sa.pl/scalar/v1)
- [Portal Pasażera (reference)](https://portalpasazera.pl/)
- [Leaflet](https://leafletjs.com/reference.html) · [react-leaflet](https://react-leaflet.js.org/)
- [OpenRailwayMap](https://www.openrailwaymap.org/)
