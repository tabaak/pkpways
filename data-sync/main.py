"""PkpWays data-sync worker.

Polls the PKP PLK Open Data API on an interval, writes timetable/route data
into PostgreSQL (warm storage), and caches live operations/delays in Redis
(hot cache) so the Next.js frontend never has to call the PKP API directly.

This is a skeleton: the PKP API's exact response fields aren't pinned down
here (only endpoint paths and auth are documented in the project README), so
payloads are stored as JSONB alongside a few indexed columns. Once you've
inspected real responses (via the Swagger/Scalar docs linked in the README),
tighten `extract_*` below to pull out the specific fields you need.

Configuration is read entirely from environment variables (see .env.example).
"""

from __future__ import annotations

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


class PkpApiClient:
    """Thin wrapper around the PKP PLK Open Data API."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._session = requests.Session()
        self._session.headers.update({"X-API-Key": config.pkp_api_key})

    def _get(self, path: str) -> Any:
        url = f"{self._config.pkp_api_base_url}{path}"
        response = self._session.get(url, timeout=self._config.request_timeout_seconds)
        response.raise_for_status()
        return response.json()

    def get_data_version(self) -> Any:
        return self._get("/data-version")

    def get_operations(self) -> Any:
        """All currently running trains (real-time delays, status)."""
        return self._get("/operations")

    def get_disruptions(self) -> Any:
        return self._get("/disruptions")

    def get_routes_for_date(self, date: str) -> Any:
        """All route IDs for a given date, e.g. date='2026-07-03'."""
        return self._get(f"/schedules/routes/{date}")

    def get_route(self, route_id: str, ord_: int) -> Any:
        """A specific route with all of its stops."""
        return self._get(f"/schedules/route/{route_id}/{ord_}")


class Storage:
    """PostgreSQL (warm storage) + Redis (hot cache) sinks."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._pg = psycopg2.connect(config.database_url)
        self._pg.autocommit = True
        self._redis = redis.Redis.from_url(config.redis_url, decode_responses=True)
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with self._pg.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS routes (
                    route_id    TEXT NOT NULL,
                    ord         INTEGER NOT NULL,
                    date        DATE NOT NULL,
                    payload     JSONB NOT NULL,
                    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                    PRIMARY KEY (route_id, ord, date)
                );

                CREATE TABLE IF NOT EXISTS disruptions (
                    id          TEXT PRIMARY KEY,
                    payload     JSONB NOT NULL,
                    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
                );
                """
            )

    def upsert_route(self, route_id: str, ord_: int, date: str, payload: Any) -> None:
        with self._pg.cursor() as cur:
            cur.execute(
                """
                INSERT INTO routes (route_id, ord, date, payload, updated_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (route_id, ord, date)
                DO UPDATE SET payload = EXCLUDED.payload, updated_at = now();
                """,
                (route_id, ord_, date, json.dumps(payload)),
            )

    def upsert_disruptions(self, disruptions: list[dict[str, Any]]) -> None:
        if not disruptions:
            return
        with self._pg.cursor() as cur:
            psycopg2.extras.execute_batch(
                cur,
                """
                INSERT INTO disruptions (id, payload, updated_at)
                VALUES (%s, %s, now())
                ON CONFLICT (id)
                DO UPDATE SET payload = EXCLUDED.payload, updated_at = now();
                """,
                [(str(d.get("id")), json.dumps(d)) for d in disruptions],
            )

    def cache_operations(self, operations: list[dict[str, Any]], ttl_seconds: int) -> None:
        """Cache each train's live operation under its own key, plus an index
        of all currently-active train IDs, so the frontend/API layer can do
        cheap lookups without scanning."""
        pipe = self._redis.pipeline()
        train_ids: list[str] = []
        for op in operations:
            train_id = str(op.get("trainId") or op.get("id"))
            train_ids.append(train_id)
            pipe.set(f"operation:{train_id}", json.dumps(op), ex=ttl_seconds)
        pipe.set("operations:index", json.dumps(train_ids), ex=ttl_seconds)
        pipe.execute()

    def close(self) -> None:
        self._pg.close()
        self._redis.close()


def sync_once(client: PkpApiClient, storage: Storage, config: Config) -> None:
    operations = client.get_operations()
    op_list = operations if isinstance(operations, list) else operations.get("items", [])
    storage.cache_operations(op_list, ttl_seconds=config.poll_interval_seconds * 3)
    log.info("Cached %d live operation(s) in Redis", len(op_list))

    disruptions = client.get_disruptions()
    disruption_list = (
        disruptions if isinstance(disruptions, list) else disruptions.get("items", [])
    )
    storage.upsert_disruptions(disruption_list)
    log.info("Upserted %d disruption(s) in Postgres", len(disruption_list))

    # NOTE: schedules/routes change far less often than operations. Fetching
    # every route on every poll would be wasteful; a real implementation
    # should compare `client.get_data_version()` against the last-seen value
    # and only refresh routes when it changes. Left as a TODO since the exact
    # shape of the data-version response isn't pinned down yet.


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

    try:
        while running:
            cycle_start = time.monotonic()
            try:
                sync_once(client, storage, config)
            except requests.RequestException as exc:
                log.error("PKP API request failed: %s", exc)
            except psycopg2.Error as exc:
                log.error("Postgres error: %s", exc)
            except redis.RedisError as exc:
                log.error("Redis error: %s", exc)

            elapsed = time.monotonic() - cycle_start
            sleep_for = max(config.poll_interval_seconds - elapsed, 0)
            time.sleep(sleep_for)
    finally:
        storage.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
