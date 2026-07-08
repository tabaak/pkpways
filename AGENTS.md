# PkpWays — Agent Guide

Live map of Polish trains. **Read `README.md` first** — it has the full architecture, database schema, and confirmed PKP API response shapes. This file is the short orientation for anyone (human or AI) making changes.

## What this repo is

A two-part app plus a Docker Compose stack that runs the backend:

- **`data-sync/`** — Python worker (`main.py`). The **only** thing that calls the PKP PLK API. Polls `/operations` every ~30s and `/schedules` daily, writing into Postgres + Redis.
- **`frontend/`** — Next.js 16 map UI. Reads Redis/Postgres only; **never** calls the PKP API directly. Currently scaffolded.
- **`docker-compose.yml`** + **`schema.sql`** (repo root) — Postgres 18, Redis 8, and the worker. This is the deploy unit, running on a VPS.

## Hard rules

- **The API key (`PKP_API_KEY`) lives only in the worker.** Never expose it to the frontend or commit it.
- **Secrets live in the root `.env`** (gitignored) — one source of truth. Compose injects them into all services; `DATABASE_URL`/`REDIS_URL` use the service hostnames `postgres`/`redis`, **not** `localhost`.
- **Datastore ports are bound to `127.0.0.1`** on the VPS. Don't expose them publicly without a firewall + strong passwords.
- **`schema.sql` auto-runs only on a fresh DB volume.** After editing it, re-apply manually (`docker compose exec -T postgres psql -U pkpways -d pkpways < schema.sql`) or `docker compose down -v` to wipe and re-init — and keep it in sync with any live `ALTER`s.

## Domain gotchas (confirmed against real API data)

- API **timestamps have no timezone** → treat as **Europe/Warsaw**.
- **Delays are not a column.** They live per-stop inside `train_runs.stops` (JSONB): `arrivalDelayMinutes` / `departureDelayMinutes`, and these keys are **absent when 0** (treat missing as 0).
- Everything is keyed by `(scheduleId, orderId)`. Field mappings (`nationalNumber`→number, `commercialCategorySymbol`→type, `carrierCode`→carrier_code) are documented in `README.md`.
- The worker polls the **whole national fleet** (~40k trains) with full routes, so a cycle takes minutes; `POLL_INTERVAL_SECONDS` is a floor, not a guarantee.

## Working on the worker

```bash
# after editing data-sync/main.py, on the VPS:
docker compose up -d --build data-sync
docker compose logs -f data-sync          # expect "Live: N train(s) -> train_runs + Redis"
```

Local gitignored probe scripts (`operations.py`, `schedules.py`, `schedules.json`) exist for inspecting raw API responses — use them to confirm field names before changing extractors.

## Outstanding work

- **Station geocoding** — `stations.latitude/longitude` are still NULL; needed before the map can render moving trains.
- **Frontend wiring** — connect the Next.js app to Redis/Postgres.
