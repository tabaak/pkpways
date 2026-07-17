-- PkpWays database schema (PostgreSQL 18).
--
-- Three tables, live-only. Built around the PKP PLK Open Data API, where
-- /operations?fullRoutes=true&withPlanned=true returns each train's ENTIRE
-- route inline (all stops, planned + actual times as full DateTimes, per-stop
-- delays). Because the API carries the whole route on every poll, there is no
-- need for separate static "schedule"/"stop" tables.
--
--   (1) stations   - coordinates. The ONLY data the API never provides; we
--                    geocode station names once and cache them here.
--   (2) trains     - train identity (number, name, carrier, category). Also
--                    absent from /operations, so fed from /schedules daily.
--   (3) train_runs - live runs: the /operations payload, whole route as JSONB,
--                    upserted every poll. Live-only (old rows pruned daily).
--
-- Note: /operations timestamps have no timezone ("2026-07-05T04:40:00"); treat
-- them as Europe/Warsaw local time when comparing against now().
--
-- Apply with: psql "$DATABASE_URL" -f schema.sql

BEGIN;

-- (1) Station coordinates — the one thing the API never gives you.
-- Seed names/ids from /dictionaries/stations, geocode names -> lat/lng once.
CREATE TABLE IF NOT EXISTS stations (
    pkp_id              INTEGER PRIMARY KEY,        -- stationId from the API
    name                TEXT NOT NULL,
    latitude            NUMERIC(9, 6),
    longitude           NUMERIC(9, 6),
    geocode_source      TEXT CHECK (geocode_source IN ('overpass', 'nominatim', 'manual')),
    geocode_confidence  TEXT CHECK (geocode_confidence IN ('high', 'low', 'unmatched')),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (2) Train identity — number, name, carrier, category. NOT in /operations, so
-- this is fed from /schedules once/day. Keyed by (scheduleId, trainOrderId).
--
-- IMPORTANT: identity is keyed by trainOrderId, NOT orderId. Both /operations
-- and /schedules expose both ids, but orderId is a PER-OPERATING-DATE instance
-- id (it rotates every day), whereas trainOrderId is the STABLE train identity
-- that stays constant across operating dates. Keying on orderId only matched a
-- run whose /schedules row happened to be captured on that exact day, so ~10%
-- of live trains missed their identity and rendered the raw run id instead.
CREATE TABLE IF NOT EXISTS trains (
    schedule_id     INTEGER NOT NULL,
    train_order_id  INTEGER NOT NULL,  -- trainOrderId: stable across operating dates
    number          VARCHAR(30),       -- nationalNumber, e.g. "99216"
    name            VARCHAR(200),      -- optional service name from /schedules
    type            VARCHAR(30),       -- commercialCategorySymbol, e.g. "S2", "IC"
    carrier_code    TEXT,              -- "KM","SKM","PKP INTERCITY",... drives marker color + carrier filter
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (schedule_id, train_order_id)
);

-- (3) Live runs — the /operations payload, whole route as JSONB, upserted each
-- poll. Live-only: a daily job prunes anything before yesterday. Yesterday is
-- retained for overnight runs and Redis warm-starts. No FK to trains on
-- purpose — a run can appear in /operations before the daily /schedules sync has
-- inserted its train row, so the join stays best-effort (LEFT JOIN).
CREATE TABLE IF NOT EXISTS train_runs (
    schedule_id     INTEGER NOT NULL,
    order_id        INTEGER NOT NULL,
    operating_date  DATE    NOT NULL,
    train_status    TEXT,                          -- e.g. "C"; confirm via /operations/statistics
    stops           JSONB   NOT NULL,              -- the per-train "stations" array, verbatim
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (schedule_id, order_id, operating_date)
);

CREATE INDEX IF NOT EXISTS idx_train_runs_date_status ON train_runs (operating_date, train_status);

COMMIT;

-- --------------------------------------------------------------------------
-- Reference queries (not executed as part of the schema)
-- --------------------------------------------------------------------------
--
-- Upsert a live run (hot path, ~30s):
--   INSERT INTO train_runs (schedule_id, order_id, operating_date, train_status, stops)
--   VALUES ($1, $2, $3, $4, $5)
--   ON CONFLICT (schedule_id, order_id, operating_date)
--   DO UPDATE SET train_status = EXCLUDED.train_status,
--                 stops        = EXCLUDED.stops,
--                 updated_at   = now()
--   WHERE train_runs.train_status IS DISTINCT FROM EXCLUDED.train_status
--      OR train_runs.stops        IS DISTINCT FROM EXCLUDED.stops;
--
-- List active trains: `trains` identity is keyed by trainOrderId, but train_runs
-- stores only the per-day orderId, so there is no direct SQL join key here. The
-- runtime read layer performs the join in the app: it reads each run's
-- trainOrderId from the cached /operations JSON in Redis and looks it up against
-- the trains map. (A pure-SQL join would require carrying trainOrderId into
-- train_runs as its own column.)
--   SELECT schedule_id, order_id, train_status, stops
--   FROM train_runs
--   WHERE operating_date = CURRENT_DATE AND train_status = 'C';
--
-- Daily prune (live-only retention):
--   DELETE FROM train_runs WHERE operating_date < CURRENT_DATE - 1;
