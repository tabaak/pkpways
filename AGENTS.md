# PkpWays — Agent Guide

Live map of Polish trains. **Read `README.md` first** — it has the full architecture, database schema, and confirmed PKP API response shapes. This file is the short orientation for anyone (human or AI) making changes.

## What this repo is

A two-part app plus a Docker Compose stack that runs all of it:

- **`data-sync/`** — Python worker (`main.py`). The **only** thing that calls the PKP PLK API. Polls `/operations` every ~30s and `/schedules` daily, writing into Postgres + Redis.
- **`frontend/`** — Next.js 16 map UI. Reads Redis/Postgres only through its server read layer; **never** calls the PKP API directly. The browser interpolates live markers continuously between API snapshots and follows the bundled railway geometry.
- **`docker-compose.yml`** + **`schema.sql`** + **`Caddyfile`** (repo root) — five services: `postgres` (18), `redis` (8), `data-sync`, `frontend`, and `caddy`. This is the deploy unit, running on a VPS and serving <https://pkpways.vokh.dev>.

## Hard rules

- **The API key (`PKP_API_KEY`) lives only in the worker.** Never expose it to the frontend or commit it.
- **Secrets live in the root `.env`** (gitignored) — one source of truth. Compose injects them into all services; `DATABASE_URL`/`REDIS_URL` use the service hostnames `postgres`/`redis`, **not** `localhost`.
- **Datastore ports are bound to `127.0.0.1`** on the VPS. Don't expose them publicly without a firewall + strong passwords. The `frontend` service isn't published to the host at all — only `caddy` (80/443) faces the internet.
- **`schema.sql` auto-runs only on a fresh DB volume.** After editing it, re-apply manually (`docker compose exec -T postgres psql -U pkpways -d pkpways < schema.sql`) or `docker compose down -v` to wipe and re-init — and keep it in sync with any live `ALTER`s.

## Domain gotchas (confirmed against real API data)

- API **timestamps have no timezone** → treat as **Europe/Warsaw**.
- **Delays are not a column.** They live per-stop inside `train_runs.stops` (JSONB): `arrivalDelayMinutes` / `departureDelayMinutes`, and these keys are **absent when 0** (treat missing as 0).
- **Two different keys, don't conflate them.** A *run* is `(scheduleId, orderId, operatingDate)` — the date is part of the key because `/operations` returns a rolling ~7-day window in which the same pair recurs daily, so any identifier built from the pair alone **will collide**. *Train identity* uses the stable `(scheduleId, trainOrderId)`. Field mappings (`nationalNumber`→number, `commercialCategorySymbol`→type, `carrierCode`→carrier_code) are documented in `README.md`.
- The worker polls the **whole national fleet** (~39k runs) with full routes. Measured over 141 recent cycles: **median 30s, p90 49s, range 22–60s** (fetch is 12–51s of that). `POLL_INTERVAL_SECONDS` (default 30) is a floor, not a guarantee — a longer cycle simply starts the next one immediately.

## Working on the worker

```bash
# after editing data-sync/main.py, on the VPS:
docker compose up -d --build data-sync
docker compose logs -f data-sync
```

A healthy cycle logs:

```
Live: 38852 train(s) -> train_runs, 13282 -> Redis (ttl 1800s) [fetch 20s, cycle 30s]
```

`-> Redis` should be far smaller than `-> train_runs` (Postgres keeps the whole
rolling week, Redis only currently-relevant runs). If they match, the
operating-date filter isn't running. `cycle` must stay well under
`CACHE_TTL_SECONDS`, or keys expire before their replacements are written.

Local gitignored probe scripts (`operations.py`, `schedules.py`, `schedules.json`) exist for inspecting raw API responses — use them to confirm field names before changing extractors.

## Working on the frontend

The map reads `GET /api/trains`; it does not call the PKP API. Train snapshots
include segment progress and duration, and the client advances markers with a
shared animation loop along `frontend/public/data/rail-segments.json`. The
geometry generator is offline-only and lives under `tools/rail-routing/`.

```bash
cd frontend
npm run lint
npx tsc --noEmit
npm run build
```

Deploying a frontend change (on the VPS):

```bash
git pull && docker compose up -d --build frontend
```

The image is a multi-stage standalone build (`frontend/Dockerfile`), which
requires `output: "standalone"` in `next.config.ts`. Standalone output omits
`public/` and `.next/static`, so both are copied explicitly — dropping either
yields a map with no styling or no geometry, which reads as an app bug rather
than a packaging one.

## Current status

- **Station geocoding** — completed for 2,953 / 2,967 stations; the rest have no resolved coordinates.
- **Frontend** — deployed and live at <https://pkpways.vokh.dev>, reading through the Next.js `/api/trains` layer.
- **Railway geometry** — 7,985 directed station pairs bundled: 7,823 routed, 162 straight-line fallbacks.


# LLM-CODING-GUIDELINES.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
