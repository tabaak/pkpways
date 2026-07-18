"""PkpWays data-sync worker.

Polls the PKP PLK Open Data API and writes into the three tables defined in
../schema.sql:

  * stations   — id + name, seeded from the `stations` id->name map that the
                 /operations response embeds. Geocoding (name -> lat/lng) is a
                 separate concern, left NULL here.
  * trains     — train identity (number, name, carrier, category), refreshed
                 once per day from /schedules.
  * train_runs — the live /operations payload; each train's whole route stored
                 as JSONB in `stops`, upserted every poll. Also mirrored into
                 Redis as a hot cache for the frontend/API layer.

A daily maintenance step prunes train_runs older than yesterday. Yesterday is
retained for overnight runs and Redis warm-starts.

Response shapes were confirmed against real API output (2026-07-07):

  /operations -> { "pagination": {...}, "trains": [ {scheduleId, orderId,
                   operatingDate, trainStatus, stations: [...] } ],
                   "stations": { "<id>": "<name>", ... } }
  /schedules  -> { "routes": [ {scheduleId, orderId, name, carrierCode,
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
from collections.abc import Iterable
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras
import redis
import requests
from dotenv import load_dotenv

load_dotenv()

# The API's `operatingDate` (and its naive timestamps) are Europe/Warsaw, which
# is not the container's clock (UTC) — they disagree about the date for the ~2h
# either side of midnight.
WARSAW_TZ = ZoneInfo("Europe/Warsaw")

# Per-stop fields worth keeping in the Redis copy. The first block is what the
# frontend's live-map read layer actually reads today (see the RawStop type in
# frontend .../datastore.ts); isConfirmed/isCancelled are cheap booleans that
# carry real run status, so they're retained for likely future use rather than
# discarded. Everything else /operations returns per stop is dropped:
# plannedSequenceNumber and actualSequenceNumber (no consumer; stop order comes
# from array position), and plannedArrivalTime/plannedDepartureTime (pure HH:MM
# duplicates of the ISO *Arrival/*Departure values). Trimming shrinks the cached
# fleet payload ~44% (~62MB -> ~35MB), and with it the frontend's cold read. The
# durable train_runs.stops column keeps the full verbatim route untouched.
_LIVE_STOP_FIELDS = frozenset(
    {
        "stationId",
        "plannedArrival",
        "plannedDeparture",
        "actualArrival",
        "actualDeparture",
        "arrivalDelayMinutes",
        "departureDelayMinutes",
        "isConfirmed",
        "isCancelled",
    }
)


def _slim_train_for_cache(train: dict[str, Any]) -> dict[str, Any]:
    """A shallow copy of `train` whose stops carry only frontend-read fields.

    Returns a new dict (and new stop dicts) so the caller's objects — and the
    full route already written to Postgres — are never mutated.
    """
    slim_stops = [
        {k: v for k, v in stop.items() if k in _LIVE_STOP_FIELDS}
        for stop in (train.get("stations") or [])
    ]
    return {**train, "stations": slim_stops}

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
    cache_ttl_seconds: int

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
            # Must comfortably outlive a full poll cycle, which takes minutes:
            # ~40 paginated pages with an inter-page delay, plus any 429 backoff.
            # If keys expire mid-cycle the cache is empty (or half-written) for
            # most of every cycle. Stale entries are harmless — each one carries
            # its full route, and the read layer drops trains past their last
            # arrival — so the TTL only needs to evict trains the API forgot.
            cache_ttl_seconds=int(os.environ.get("CACHE_TTL_SECONDS", "1800")),
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

    # Max times to retry a single request when the API returns 429.
    _MAX_RETRIES = 5
    # Never sleep longer than this on a single backoff, even if asked to.
    _MAX_BACKOFF_SECONDS = 120
    # Polite gap between paginated page requests, so one cycle (which can be
    # several pages of the national fleet) doesn't burst and trip a 429.
    _INTER_PAGE_DELAY_SECONDS = 1.0

    @classmethod
    def _retry_after_seconds(cls, response: requests.Response, attempt: int) -> int:
        """How long to wait before retrying a throttled request.

        Prefers the server's `Retry-After` header (seconds or HTTP-date), else
        falls back to exponential backoff (5, 10, 20, ...), capped.
        """
        header = response.headers.get("Retry-After")
        if header:
            try:
                return max(1, min(int(header), cls._MAX_BACKOFF_SECONDS))
            except ValueError:
                try:
                    when = parsedate_to_datetime(header)
                    delta = (when - dt.datetime.now(dt.timezone.utc)).total_seconds()
                    return max(1, min(int(delta), cls._MAX_BACKOFF_SECONDS))
                except (TypeError, ValueError):
                    pass
        return min(5 * (2 ** (attempt - 1)), cls._MAX_BACKOFF_SECONDS)

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{self._config.pkp_api_base_url}{path}"
        response: requests.Response | None = None
        for attempt in range(1, self._MAX_RETRIES + 1):
            response = self._session.get(
                url, params=params, timeout=self._config.request_timeout_seconds
            )
            if response.status_code == 429:
                backoff = self._retry_after_seconds(response, attempt)
                log.warning(
                    "PKP API 429 Too Many Requests on %s (attempt %d/%d) — "
                    "backing off %ds",
                    path, attempt, self._MAX_RETRIES, backoff,
                )
                time.sleep(backoff)
                continue
            response.raise_for_status()
            return response.json()
        # Retries exhausted — raise the last 429 for the caller to log/skip.
        assert response is not None
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
            time.sleep(self._INTER_PAGE_DELAY_SECONDS)
        return trains, stations

    def get_schedule_routes(self, page_size: int = 10000) -> list[dict[str, Any]]:
        """Train identity rows (number, name, carrier, category). Refreshed daily."""
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
            time.sleep(self._INTER_PAGE_DELAY_SECONDS)
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
        # Keyed by trainOrderId, NOT orderId: orderId is a per-operating-date
        # instance id that rotates daily, while trainOrderId is the stable train
        # identity. Keying on orderId only matched runs on the exact day the
        # schedule was captured, so most live trains missed their identity.
        rows = []
        for r in routes:
            schedule_id = r.get("scheduleId")
            train_order_id = r.get("trainOrderId")
            if schedule_id is None or train_order_id is None:
                continue
            rows.append(
                (
                    int(schedule_id),
                    int(train_order_id),
                    r.get("nationalNumber"),             # number   e.g. "99216"
                    r.get("name"),                       # name     e.g. an IC service name
                    r.get("commercialCategorySymbol"),  # category e.g. "S1", "R7"
                    r.get("carrierCode"),                # carrier  "KM", "SKM", ...
                )
            )
        if not rows:
            return 0
        with self._pg.cursor() as cur:
            psycopg2.extras.execute_batch(
                cur,
                """
                INSERT INTO trains
                    (schedule_id, train_order_id, number, name, type, carrier_code)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (schedule_id, train_order_id)
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
        today = dt.datetime.now(WARSAW_TZ).date().isoformat()
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
                              updated_at   = now()
                WHERE train_runs.train_status IS DISTINCT FROM EXCLUDED.train_status
                   OR train_runs.stops        IS DISTINCT FROM EXCLUDED.stops;
                """,
                rows,
                page_size=1000,
            )
        return len(rows)

    def prune_old_runs(self) -> int:
        # Retain yesterday for overnight trains that remain in flight after
        # midnight and for a complete Redis warm-start window.
        cutoff = dt.datetime.now(WARSAW_TZ).date() - dt.timedelta(days=1)
        with self._pg.cursor() as cur:
            cur.execute(
                "DELETE FROM train_runs WHERE operating_date < %s;", (cutoff,)
            )
            return cur.rowcount

    # --- Redis hot cache ------------------------------------------------- #
    def _cache_operation_values(
        self,
        trains: Iterable[dict[str, Any]],
        ttl_seconds: int,
        chunk: int,
    ) -> list[str]:
        """Write operation values in bounded pipelines and return their keys."""
        keys: list[str] = []
        pipe = self._redis.pipeline()
        pending = 0
        for train in trains:
            schedule_id = train.get("scheduleId")
            order_id = train.get("orderId")
            operating_date = train.get("operatingDate")
            if schedule_id is None or order_id is None or operating_date is None:
                continue

            date = str(operating_date)[:10]
            run_key = f"{schedule_id}:{order_id}:{date}"
            keys.append(run_key)
            pipe.set(
                f"operation:{run_key}",
                json.dumps(_slim_train_for_cache(train)),
                ex=ttl_seconds,
            )
            pending += 1

            # Flush in chunks so we never buffer the whole national fleet into
            # one round trip (which overflows the socket write timeout).
            if pending >= chunk:
                pipe.execute()
                pipe = self._redis.pipeline()
                pending = 0

        if pending:
            pipe.execute()
        return keys

    def _replace_operations_index(self, keys: list[str]) -> None:
        """Publish a completed cache generation.

        The index deliberately has no TTL. Only operation values are eligible
        for volatile eviction; if the worker stops, those values expire and the
        frontend safely skips the missing MGET results referenced by this index.
        """
        self._redis.set("operations:index", json.dumps(keys))

    def cache_operations(
        self, trains: list[dict[str, Any]], ttl_seconds: int, chunk: int = 1000
    ) -> int:
        """Cache only runs that could plausibly be moving right now.

        /operations returns a rolling ~7-day window (~40k trains), but a live
        map only cares about runs in flight. Caching the whole window cost
        ~313MB and — because the map's read layer has to deserialise every key
        to discover a run is long finished — made a full read take ~100s.

        The cache key MUST include operating_date: (scheduleId, orderId) is not
        unique across dates (it's only a PK in `train_runs` together with
        operating_date). Without it ~55% of runs silently overwrote each other,
        and the surviving record for a given key was an arbitrary date.
        """
        today = dt.datetime.now(WARSAW_TZ).date()
        # Yesterday covers overnight runs still in flight past midnight;
        # tomorrow covers runs that depart just after it.
        wanted = {
            (today - dt.timedelta(days=1)).isoformat(),
            today.isoformat(),
            (today + dt.timedelta(days=1)).isoformat(),
        }

        current_trains = (
            train
            for train in trains
            if str(train.get("operatingDate") or "")[:10] in wanted
        )
        keys = self._cache_operation_values(current_trains, ttl_seconds, chunk)
        # Publish the index only after every value pipeline succeeded. Readers
        # therefore continue using the previous complete generation on failure.
        self._replace_operations_index(keys)
        return len(keys)

    def warm_cache_from_postgres(
        self, ttl_seconds: int, chunk: int = 1000
    ) -> int:
        """Rebuild the current Redis cache from Postgres after a restart.

        Redis is intentionally non-persistent because all of its data is
        reconstructable. A server-side cursor bounds Python memory while the
        current three-day window is streamed from the durable train_runs table.
        """
        today = dt.datetime.now(WARSAW_TZ).date()
        date_from = today - dt.timedelta(days=1)
        date_to = today + dt.timedelta(days=1)
        keys: list[str] = []

        # Named cursors require a transaction. This method runs once at startup,
        # before the normal autocommit write loop begins.
        self._pg.autocommit = False
        try:
            with self._pg.cursor(name="warm_redis_cache") as cur:
                cur.itersize = chunk
                cur.execute(
                    """
                    SELECT schedule_id, order_id, operating_date,
                           train_status, stops
                    FROM train_runs
                    WHERE operating_date BETWEEN %s AND %s
                    ORDER BY operating_date, schedule_id, order_id;
                    """,
                    (date_from, date_to),
                )

                def cached_trains() -> Iterable[dict[str, Any]]:
                    for schedule_id, order_id, operating_date, status, stops in cur:
                        yield {
                            "scheduleId": schedule_id,
                            "orderId": order_id,
                            "operatingDate": operating_date.isoformat(),
                            "trainStatus": status,
                            "stations": stops or [],
                        }

                keys = self._cache_operation_values(
                    cached_trains(), ttl_seconds, chunk
                )
            self._pg.commit()
        except Exception:
            self._pg.rollback()
            raise
        finally:
            self._pg.autocommit = True

        self._replace_operations_index(keys)
        return len(keys)

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
    started = time.monotonic()
    trains, stations = client.get_operations()
    fetch_seconds = time.monotonic() - started

    # Seed station names, but only for ids we haven't written this process-run,
    # so we don't re-upsert the whole catalogue every 30s.
    new_stations = {sid: name for sid, name in stations.items() if int(sid) not in known_station_ids}
    if new_stations:
        n_new = storage.upsert_stations(new_stations)
        known_station_ids.update(int(sid) for sid in new_stations)
        log.info("Live: seeded %d new station name(s)", n_new)

    n_runs = storage.upsert_train_runs(trains)
    n_cached = storage.cache_operations(trains, ttl_seconds=config.cache_ttl_seconds)
    log.info(
        "Live: %d train(s) -> train_runs, %d -> Redis (ttl %ds) "
        "[fetch %.0fs, cycle %.0fs]",
        n_runs,
        n_cached,
        config.cache_ttl_seconds,
        fetch_seconds,
        time.monotonic() - started,
    )


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
        try:
            n_warmed = storage.warm_cache_from_postgres(config.cache_ttl_seconds)
            log.info("Startup: warmed %d current run(s) into Redis", n_warmed)
        except psycopg2.Error as exc:
            log.error("Startup cache warm — Postgres error: %s", exc)
        except redis.RedisError as exc:
            log.error("Startup cache warm — Redis error: %s", exc)

        while running:
            cycle_start = time.monotonic()

            # Run the daily job once when the calendar date rolls over (and on
            # first boot). Failures are logged but don't stop the live loop.
            today = dt.datetime.now(WARSAW_TZ).date()
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
