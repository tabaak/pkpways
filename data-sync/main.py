"""PkpWays data-sync worker.

Polls the PKP PLK Open Data API and writes into the three tables defined in
../schema.sql:

  * stations   — id + name, seeded from the `stations` id->name map that the
                 /operations response embeds. Geocoding (name -> lat/lng) is a
                 separate concern, left NULL here.
  * trains     — train identity (number, carrier, type), refreshed once per day
                 from /schedules.
  * train_runs — the live /operations payload; each train's whole route stored
                 as JSONB in `stops`, upserted every poll. Also mirrored into
                 Redis as a hot cache for the frontend/API layer.

A daily maintenance step prunes train_runs older than today.

Response shapes were confirmed against real API output (2026-07-07):

  /operations -> { "pagination": {...}, "trains": [ {scheduleId, orderId,
                   operatingDate, trainStatus, stations: [...] } ],
                   "stations": { "<id>": "<name>", ... } }
  /schedules  -> { "routes": [ {scheduleId, orderId, carrierCode,
                   nationalNumber, commercialCategorySymbol, ... } ],
                   "dictionaries": {...} }

Config is read entirely from environment variables (see .env.example).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass
from typing import Any

import psycopg2
import psycopg2.extras
import redis
import requests
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("data-sync")


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Config:
    pkp_api_base_url: str
    pkp_api_key: str
    database_url: str
    redis_url: str
    poll_interval_seconds: int
    request_timeout_seconds: int

    @classmethod
    def from_env(cls) -> "Config":
        pkp_api_key = os.environ.get("PKP_API_KEY")
        database_url = os.environ.get("DATABASE_URL")
        redis_url = os.environ.get("REDIS_URL")

        missing = [
            name
            for name, value in (
                ("PKP_API_KEY", pkp_api_key),
                ("DATABASE_URL", database_url),
                ("REDIS_URL", redis_url),
            )
            if not value
        ]
        if missing:
            raise RuntimeError(
                f"Missing required environment variable(s): {', '.join(missing)}. "
                "Copy .env.example to .env and fill them in."
            )

        return cls(
            pkp_api_base_url=os.environ.get(
                "PKP_API_BASE_URL", "https://pdp-api.plk-sa.pl/api/v1"
            ),
            pkp_api_key=pkp_api_key,  # type: ignore[arg-type]
            database_url=database_url,  # type: ignore[arg-type]
            redis_url=redis_url,  # type: ignore[arg-type]
            poll_interval_seconds=int(os.environ.get("POLL_INTERVAL_SECONDS", "30")),
            request_timeout_seconds=int(os.environ.get("REQUEST_TIMEOUT_SECONDS", "10")),
        )


# --------------------------------------------------------------------------- #
# API client
# --------------------------------------------------------------------------- #
class PkpApiClient:
    """Thin wrapper around the PKP PLK Open Data API."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._session = requests.Session()
        self._session.headers.update(
            {"X-API-Key": config.pkp_api_key, "Accept": "application/json"}
        )

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{self._config.pkp_api_base_url}{path}"
        response = self._session.get(
            url, params=params, timeout=self._config.request_timeout_seconds
        )
        response.raise_for_status()
        return response.json()

    def get_operations(self, page_size: int = 10000) -> tuple[list[dict[str, Any]], dict[str, str]]:
        """Every currently-running train, whole route inline.

        Returns (trains, stations) where `stations` is the id->name map the API
        embeds alongside the trains. Follows pagination.hasNextPage.
        """
        trains: list[dict[str, Any]] = []
        stations: dict[str, str] = {}
        page = 1
        while True:
            payload = self._get(
                "/operations",
                params={
                    "fullRoutes": "true",
                    "withPlanned": "true",
                    "page": page,
                    "pageSize": page_size,
                },
            )
            trains.extend(payload.get("trains") or [])
            stations.update(payload.get("stations") or {})
            pagination = payload.get("pagination") or {}
            if not pagination.get("hasNextPage"):
                break
            page += 1
        return trains, stations

    def get_schedule_routes(self, page_size: int = 10000) -> list[dict[str, Any]]:
        """Train identity rows (number, carrier, category). Refreshed daily."""
        routes: list[dict[str, Any]] = []
        page = 1
        while True:
            payload = self._get(
                "/schedules", params={"page": page, "pageSize": page_size}
            )
            batch = payload.get("routes") or []
            routes.extend(batch)
            pagination = payload.get("pagination") or {}
            if not pagination.get("hasNextPage"):
                break
            page += 1
        return routes


# --------------------------------------------------------------------------- #
# Storage — Postgres (warm) + Redis (hot)
# --------------------------------------------------------------------------- #
class Storage:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._pg = psycopg2.connect(config.database_url)
        self._pg.autocommit = True
        # Generous socket timeouts: a full national /operations cache is a large
        # write, and the default (no timeout / short) either hangs or trips
        # "Timeout writing to socket" under load.
        self._redis = redis.Redis.from_url(
            config.redis_url,
            decode_responses=True,
            socket_timeout=30,
            socket_connect_timeout=10,
            health_check_interval=30,
        )

    # --- stations -------------------------------------------------------- #
    def upsert_stations(self, stations: dict[str, str]) -> int:
        """`stations` is the {id: name} map embedded in /operations."""
        rows = []
        for raw_id, name in stations.items():
            try:
                rows.append((int(raw_id), str(name)))
            except (TypeError, ValueError):
                continue
        if not rows:
            return 0
        with self._pg.cursor() as cur:
            # Only touch identity; never clobber coordinates set by geocoding.
            psycopg2.extras.execute_batch(
                cur,
                """
                INSERT INTO stations (pkp_id, name)
                VALUES (%s, %s)
                ON CONFLICT (pkp_id)
                DO UPDATE SET name = EXCLUDED.name, updated_at = now();
                """,
                rows,
                page_size=1000,
            )
        return len(rows)

    # --- trains ---------------------------------------------------------- #
    def upsert_trains(self, routes: list[dict[str, Any]]) -> int:
        rows = []
        for r in routes:
            schedule_id = r.get("scheduleId")
            order_id = r.get("orderId")
            if schedule_id is None or order_id is None:
                continue
            rows.append(
                (
                    int(schedule_id),
                    int(order_id),
                    r.get("nationalNumber"),            # number  e.g. "99216"
                    None,                                # name (service name) — not in /schedules
                    r.get("commercialCategorySymbol"),   # type    e.g. "S1", "R7"
                    r.get("carrierCode"),                # carrier "KM", "SKM", ...
                )
            )
        if not rows:
            return 0
        with self._pg.cursor() as cur:
            psycopg2.extras.execute_batch(
                cur,
                """
                INSERT INTO trains
                    (schedule_id, order_id, number, name, type, carrier_code)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (schedule_id, order_id)
                DO UPDATE SET number       = EXCLUDED.number,
                              name         = EXCLUDED.name,
                              type         = EXCLUDED.type,
                              carrier_code = EXCLUDED.carrier_code,
                              updated_at   = now();
                """,
                rows,
                page_size=1000,
            )
        return len(rows)

    # --- train_runs (hot path) ------------------------------------------ #
    def upsert_train_runs(self, trains: list[dict[str, Any]]) -> int:
        today = dt.date.today().isoformat()
        rows = []
        for t in trains:
            schedule_id = t.get("scheduleId")
            order_id = t.get("orderId")
            if schedule_id is None or order_id is None:
                continue
            rows.append(
                (
                    int(schedule_id),
                    int(order_id),
                    t.get("operatingDate") or today,
                    t.get("trainStatus"),
                    json.dumps(t.get("stations") or []),  # whole route, verbatim
                )
            )
        if not rows:
            return 0
        with self._pg.cursor() as cur:
            psycopg2.extras.execute_batch(
                cur,
                """
                INSERT INTO train_runs
                    (schedule_id, order_id, operating_date, train_status, stops)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (schedule_id, order_id, operating_date)
                DO UPDATE SET train_status = EXCLUDED.train_status,
                              stops        = EXCLUDED.stops,
                              updated_at   = now();
                """,
                rows,
                page_size=1000,
            )
        return len(rows)

    def prune_old_runs(self) -> int:
        with self._pg.cursor() as cur:
            cur.execute("DELETE FROM train_runs WHERE operating_date < CURRENT_DATE;")
            return cur.rowcount

    # --- Redis hot cache ------------------------------------------------- #
    def cache_operations(
        self, trains: list[dict[str, Any]], ttl_seconds: int, chunk: int = 1000
    ) -> None:
        keys: list[str] = []
        pipe = self._redis.pipeline()
        pending = 0
        for t in trains:
            schedule_id = t.get("scheduleId")
            order_id = t.get("orderId")
            if schedule_id is None or order_id is None:
                continue
            run_key = f"{schedule_id}:{order_id}"
            keys.append(run_key)
            pipe.set(f"operation:{run_key}", json.dumps(t), ex=ttl_seconds)
            pending += 1
            # Flush in chunks so we never buffer the whole national fleet into
            # one round trip (which overflows the socket write timeout).
            if pending >= chunk:
                pipe.execute()
                pipe = self._redis.pipeline()
                pending = 0
        pipe.set("operations:index", json.dumps(keys), ex=ttl_seconds)
        pipe.execute()

    def close(self) -> None:
        self._pg.close()
        self._redis.close()


# --------------------------------------------------------------------------- #
# Sync steps
# --------------------------------------------------------------------------- #
def sync_live(
    client: PkpApiClient,
    storage: Storage,
    config: Config,
    known_station_ids: set[int],
) -> None:
    """Hot path — runs every poll interval."""
    trains, stations = client.get_operations()

    # Seed station names, but only for ids we haven't written this process-run,
    # so we don't re-upsert the whole catalogue every 30s.
    new_stations = {sid: name for sid, name in stations.items() if int(sid) not in known_station_ids}
    if new_stations:
        n_new = storage.upsert_stations(new_stations)
        known_station_ids.update(int(sid) for sid in new_stations)
        log.info("Live: seeded %d new station name(s)", n_new)

    n_runs = storage.upsert_train_runs(trains)
    storage.cache_operations(trains, ttl_seconds=config.poll_interval_seconds * 3)
    log.info("Live: %d train(s) -> train_runs + Redis", n_runs)


def sync_daily(client: PkpApiClient, storage: Storage) -> None:
    """Cold path — runs once per calendar day."""
    routes = client.get_schedule_routes()
    n_trains = storage.upsert_trains(routes)
    log.info("Daily: upserted %d train identity row(s)", n_trains)

    n_pruned = storage.prune_old_runs()
    log.info("Daily: pruned %d stale train_run(s)", n_pruned)


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def main() -> int:
    config = Config.from_env()
    client = PkpApiClient(config)
    storage = Storage(config)

    running = True

    def handle_shutdown(signum: int, _frame: Any) -> None:
        nonlocal running
        log.info("Received signal %s, shutting down after current cycle...", signum)
        running = False

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    log.info(
        "Starting data-sync worker (poll every %ds, base URL %s)",
        config.poll_interval_seconds,
        config.pkp_api_base_url,
    )

    last_daily: dt.date | None = None
    known_station_ids: set[int] = set()

    try:
        while running:
            cycle_start = time.monotonic()

            # Run the daily job once when the calendar date rolls over (and on
            # first boot). Failures are logged but don't stop the live loop.
            today = dt.date.today()
            if last_daily != today:
                try:
                    sync_daily(client, storage)
                    last_daily = today
                except requests.RequestException as exc:
                    log.error("Daily sync — PKP API request failed: %s", exc)
                except psycopg2.Error as exc:
                    log.error("Daily sync — Postgres error: %s", exc)

            try:
                sync_live(client, storage, config, known_station_ids)
            except requests.RequestException as exc:
                log.error("PKP API request failed: %s", exc)
            except psycopg2.Error as exc:
                log.error("Postgres error: %s", exc)
            except redis.RedisError as exc:
                log.error("Redis error: %s", exc)

            elapsed = time.monotonic() - cycle_start
            time.sleep(max(config.poll_interval_seconds - elapsed, 0))
    finally:
        storage.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
