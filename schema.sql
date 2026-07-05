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
--   (2) trains     - train identity (number, carrier, type). Also absent from
--                    /operations, so fed from /schedules once per day.
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
    geocode_source      TEXT CHECK (geocode_source IN ('nominatim', 'manual')),
    geocode_confidence  TEXT CHECK (geocode_confidence IN ('high', 'low', 'unmatched')),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (2) Train identity — number, carrier, type. NOT in /operations, so this is
-- fed from /schedules once/day. Keyed by (scheduleId, orderId), date-independent.
CREATE TABLE IF NOT EXISTS trains (
    schedule_id   INTEGER NOT NULL,
    order_id      INTEGER NOT NULL,
    number        VARCHAR(30),      -- e.g. "IC 3512"  (confirm field name in /schedules)
    name          VARCHAR(200),     -- optional service name, e.g. "Mazowsze"
    type          VARCHAR(30),      -- e.g. "IC", "REG"
    carrier_code  VARCHAR(10),      -- "IC","KM",... drives marker color + carrier filter
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (schedule_id, order_id)
);

-- (3) Live runs — the /operations payload, whole route as JSONB, upserted each
-- poll. Live-only: a daily job prunes anything before today. No FK to trains on
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
--                 updated_at   = now();
--
-- List active trains (with labels):
--   SELECT r.schedule_id, r.order_id, t.number, t.carrier_code, r.train_status, r.stops
--   FROM train_runs r
--   LEFT JOIN trains t USING (schedule_id, order_id)
--   WHERE r.operating_date = CURRENT_DATE
--     AND r.train_status = 'C'
--   ORDER BY t.carrier_code, t.number;
--
-- Daily prune (live-only retention):
--   DELETE FROM train_runs WHERE operating_date < CURRENT_DATE;
