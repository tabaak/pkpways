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
- **🎛️ Carrier Filters** — Filter by carrier type (PKP Intercity, Polregio, Koleje Mazowieckie, SKM, etc.)
- **🌐 Bilingual** — Full PL/EN language toggle
- **🌙 Dark Mode** — Beautiful dark map theme option

---

## 🏗️ Architecture

### Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Framework** | Next.js 16 (App Router) | SSR, API routes, React 19 |
| **Map** | Leaflet + react-leaflet | Free, lightweight, OSM tiles |
| **Styling** | Tailwind CSS v4 | Utility-first, dark mode |
| **Language** | TypeScript 5 | Type safety for API responses |
| **Database** | PostgreSQL | Persistent storage for schedules, stations, and historical data |
| **Cache** | Redis | Fast in-memory cache to absorb traffic spikes and minimize API calls |
| **API Source** | PKP PLK Open Data API | Official railway data source |

### Data Architecture

The app uses a **VPS-hosted backend with PostgreSQL and Redis** to decouple user traffic from the PKP PLK API:

- **A background worker** polls the PKP API at controlled intervals and writes fresh data into Postgres/Redis
- **User requests hit Redis first** (cached real-time data), falling back to Postgres, and only reaching the PKP API as a last resort
- This means **thousands of users can view the map simultaneously** without multiplying API requests — the PKP API is hit once per polling cycle, not once per user

```
Users ──► Next.js App ──► Redis (hot cache) ──► PostgreSQL (warm storage)
                                                        ▲
                                        Background Worker │ (polls every 30s)
                                                        │
                                              PKP PLK Open Data API
```

This architecture handles traffic spikes gracefully and keeps us well within API rate limits regardless of user count.

---

## 🔌 PKP PLK API

### API Details

| Property | Value |
|----------|-------|
| **Base URL** | `https://pdp-api.plk-sa.pl/api/v1` |
| **Auth** | `X-API-Key` header |
| **Format** | JSON |
| **Rate Limits** | Basic: 100/hr · Standard: 500/hr · Premium: 2,000/hr |
| **Docs** | [Swagger](https://pdp-api.plk-sa.pl/swagger) · [Scalar](https://pdp-api.plk-sa.pl/scalar/v1) |

### Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/operations` | All currently running trains (real-time delays, status) |
| `GET /api/v1/operations/train/{id}/{ord}/{date}` | Specific train execution details |
| `GET /api/v1/schedules` | Planned timetable data |
| `GET /api/v1/schedules/route/{id}/{ord}` | Specific route with all stops |
| `GET /api/v1/schedules/routes/{date}` | All route IDs for a given date |
| `GET /api/v1/disruptions` | Active disruptions on the network |
| `GET /api/v1/data-version` | Check if data has changed since last fetch |

---

## 🧮 Train Position Interpolation

The core challenge: **the API provides station-level arrival/departure times and delays, not GPS coordinates.**

To show trains "moving" on the map, we **interpolate positions between stations**:

1. Get the train's scheduled stops with planned times
2. Apply real-time delay adjustments
3. Determine which two stations the train is currently between (based on current time)
4. Calculate a progress ratio and linearly interpolate lat/lng between those stations
5. Animate the marker smoothly between polling updates

Station coordinates are sourced from the API's dictionary endpoints and supplemented with [OpenRailwayMap](https://www.openrailwaymap.org/) data where needed.

---

## 🎨 Design Philosophy

This is a **portfolio piece** — the design should be stunning:

- **Full-screen map** as the hero element (no unnecessary chrome)
- **Glassmorphism** panels that slide in/out over the map
- **Smooth animations** for train markers gliding between positions
- **Color-coded trains** by carrier (PKP IC = blue, Polregio = red, etc.)
- **Premium feel**: custom train icons, smooth transitions, responsive
- **Dark mode map** with custom tile styling

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL
- Redis
- PKP PLK API key ([request here](https://pdp-api.plk-sa.pl/))

### Setup

```bash
git clone https://github.com/your-username/PkpWays.git
cd PkpWays
npm install
cp .env.example .env.local
# Add your PKP_API_KEY and database credentials to .env.local
npm run dev
```

---

## 🧪 Development Notes

### API Key Security

- **NEVER** commit the API key to git
- The key lives in `.env.local` (gitignored)
- All PKP API calls happen server-side (background worker or API routes)
- The `api-key-pkp.txt` file in the repo root should be **deleted and gitignored** before any public push

### Useful Links

- [PKP PLK API Documentation](https://pdp-api.plk-sa.pl/api-documentation)
- [PKP PLK Swagger](https://pdp-api.plk-sa.pl/swagger)
- [PKP PLK Scalar](https://pdp-api.plk-sa.pl/scalar/v1)
- [Portal Pasażera (reference)](https://portalpasazera.pl/)
- [Leaflet Documentation](https://leafletjs.com/reference.html)
- [react-leaflet](https://react-leaflet.js.org/)
- [OpenRailwayMap](https://www.openrailwaymap.org/)
