#!/usr/bin/env python3
"""Generate the static station-to-station railway geometry asset.

This is intentionally a one-off tool. It reads the live database only to
discover the effective located station pairs and asks a temporary OSRM rail
instance for each path. It never calls the PKP API and never writes Postgres or
Redis.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg2
import requests

log = logging.getLogger("rail_geometry")

PAIR_SQL = """
WITH expanded AS (
    SELECT r.schedule_id, r.order_id, r.operating_date, x.ord,
           (x.stop->>'stationId')::integer AS station_id
      FROM train_runs AS r
      CROSS JOIN LATERAL jsonb_array_elements(r.stops)
        WITH ORDINALITY AS x(stop, ord)
), located AS (
    SELECT e.*
      FROM expanded AS e
      JOIN stations AS s ON s.pkp_id = e.station_id
                         AND s.latitude IS NOT NULL
                         AND s.longitude IS NOT NULL
), ordered AS (
    SELECT station_id AS from_id,
           lead(station_id) OVER (
               PARTITION BY schedule_id, order_id, operating_date
               ORDER BY ord
           ) AS to_id
      FROM located
), pairs AS (
    SELECT DISTINCT o.from_id, o.to_id,
           sf.latitude AS from_lat, sf.longitude AS from_lng,
           st.latitude AS to_lat, st.longitude AS to_lng
      FROM ordered AS o
      JOIN stations AS sf ON sf.pkp_id = o.from_id
      JOIN stations AS st ON st.pkp_id = o.to_id
     WHERE o.to_id IS NOT NULL
       AND o.from_id <> o.to_id
)
SELECT from_id, to_id,
       from_lat::double precision AS from_lat,
       from_lng::double precision AS from_lng,
       to_lat::double precision AS to_lat,
       to_lng::double precision AS to_lng
  FROM pairs
 ORDER BY from_id, to_id;
"""


def encode_polyline(points: list[tuple[float, float]], precision: int = 6) -> str:
    """Encode (lat, lng) points using Google's polyline representation."""
    factor = 10**precision
    previous_lat = 0
    previous_lng = 0
    out: list[str] = []

    def emit(value: int) -> None:
        value = ~(value << 1) if value < 0 else value << 1
        while value >= 0x20:
            out.append(chr(((value & 0x1F) | 0x20) + 63))
            value >>= 5
        out.append(chr(value + 63))

    for lat, lng in points:
        lat_i = int(round(lat * factor))
        lng_i = int(round(lng * factor))
        emit(lat_i - previous_lat)
        emit(lng_i - previous_lng)
        previous_lat = lat_i
        previous_lng = lng_i
    return ''.join(out)


def decode_polyline(encoded: str, precision: int = 6) -> list[tuple[float, float]]:
    """Decode an OSRM polyline6 response without an extra dependency."""
    factor = 10**precision
    points: list[tuple[float, float]] = []
    index = 0
    lat = 0
    lng = 0

    while index < len(encoded):
        values: list[int] = []
        for _ in range(2):
            shift = 0
            value = 0
            while True:
                if index >= len(encoded):
                    raise ValueError("truncated polyline")
                byte = ord(encoded[index]) - 63
                index += 1
                value |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            values.append(~(value >> 1) if value & 1 else value >> 1)
        lat += values[0]
        lng += values[1]
        points.append((lat / factor, lng / factor))
    return points


def dedupe_adjacent(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    result: list[tuple[float, float]] = []
    for point in points:
        if not result or point != result[-1]:
            result.append(point)
    return result


class Router:
    def __init__(self, base_url: str, profile: str, timeout: float, attempts: int) -> None:
        self.base_url = base_url.rstrip('/')
        self.profile = profile
        self.timeout = timeout
        self.attempts = attempts
        self.local = threading.local()

    def session(self) -> requests.Session:
        session = getattr(self.local, 'session', None)
        if session is None:
            session = requests.Session()
            session.headers.update({'Accept': 'application/json'})
            self.local.session = session
        return session

    def route(self, pair: tuple[int, int, float, float, float, float]) -> tuple[str, str | None]:
        from_id, to_id, from_lat, from_lng, to_lat, to_lng = pair
        key = f'{from_id}:{to_id}'
        start = (from_lat, from_lng)
        end = (to_lat, to_lng)
        url = f'{self.base_url}/route/v1/{self.profile}/{from_lng},{from_lat};{to_lng},{to_lat}'
        params = {'overview': 'full', 'geometries': 'polyline6', 'steps': 'false'}

        last_error = 'unknown error'
        for attempt in range(1, self.attempts + 1):
            try:
                response = self.session().get(url, params=params, timeout=self.timeout)
                response.raise_for_status()
                payload = response.json()
                if payload.get('code') != 'Ok' or not payload.get('routes'):
                    last_error = str(payload.get('code') or 'no route')
                    break

                route = payload['routes'][0]
                encoded = route.get('geometry')
                if not isinstance(encoded, str) or not encoded:
                    last_error = 'empty geometry'
                    break

                waypoints = payload.get('waypoints') or []
                snap_distances = [float(w.get('distance', 0)) for w in waypoints if w]
                max_snap = float(os.environ.get('MAX_SNAP_METERS', '2500'))
                if snap_distances and max(snap_distances) > max_snap:
                    last_error = f'snap distance {max(snap_distances):.0f}m > {max_snap:.0f}m'
                    break

                # OSRM starts at the snapped rail edge. Adding the exact station
                # coordinate makes every segment stitch to its neighbours even
                # when a station centroid is not itself on a railway way.
                points = dedupe_adjacent([start, *decode_polyline(encoded), end])
                return key, encode_polyline(points)
            except (OSError, ValueError, requests.RequestException, json.JSONDecodeError) as exc:
                last_error = str(exc)
                if attempt < self.attempts:
                    time.sleep(min(8.0, 0.5 * (2 ** (attempt - 1))))

        return key, None


def load_pairs(database_url: str) -> list[tuple[int, int, float, float, float, float]]:
    with psycopg2.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(PAIR_SQL)
            return [
                (int(row[0]), int(row[1]), float(row[2]), float(row[3]), float(row[4]), float(row[5]))
                for row in cur.fetchall()
            ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-url', default=os.environ.get('DATABASE_URL'))
    parser.add_argument('--osrm-url', default=os.environ.get('OSRM_URL', 'http://127.0.0.1:5000'))
    parser.add_argument('--profile', default=os.environ.get('OSRM_PROFILE', 'rail'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=int(os.environ.get('ROUTING_WORKERS', '8')))
    parser.add_argument('--timeout', type=float, default=float(os.environ.get('ROUTING_TIMEOUT', '45')))
    parser.add_argument('--attempts', type=int, default=int(os.environ.get('ROUTING_ATTEMPTS', '3')))
    return parser.parse_args()


def main() -> int:
    logging.basicConfig(level=os.environ.get('LOG_LEVEL', 'INFO'), format='%(asctime)s %(levelname)s %(message)s')
    args = parse_args()
    if not args.database_url:
        raise SystemExit('--database-url or DATABASE_URL is required')
    if args.workers < 1:
        raise SystemExit('--workers must be positive')

    pairs = load_pairs(args.database_url)
    log.info('Loaded %d directed located station pairs', len(pairs))
    router = Router(args.osrm_url, args.profile, args.timeout, args.attempts)
    pair_by_key = {f'{pair[0]}:{pair[1]}': pair for pair in pairs}
    segments: dict[str, str] = {}
    fallback: list[str] = []
    completed = 0
    started = time.monotonic()

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(router.route, pair) for pair in pairs]
        for future in as_completed(futures):
            key, geometry = future.result()
            completed += 1
            pair = pair_by_key[key]
            if geometry is None:
                fallback.append(key)
                geometry = encode_polyline([(pair[2], pair[3]), (pair[4], pair[5])])
                log.warning('fallback %s', key)
            segments[key] = geometry
            if completed % 250 == 0 or completed == len(pairs):
                log.info('%d/%d pairs (%.1fs)', completed, len(pairs), time.monotonic() - started)

    # Validate the final encoding, not only OSRM's input geometry. A malformed
    # polyline makes the browser reject a segment and silently draw a chord.
    for key, geometry in segments.items():
        points = decode_polyline(geometry)
        if len(points) < 2:
            raise ValueError(f'encoded segment {key} has fewer than two points')

    payload: dict[str, Any] = {
        'version': 1,
        'encoding': 'google-polyline6',
        'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'source': {
            'engine': 'Project OSRM',
            'profile': args.profile,
            'osmExtract': os.environ.get('OSM_EXTRACT', 'unspecified'),
            'osrmImage': os.environ.get('OSRM_IMAGE', 'unspecified'),
        },
        'pairCount': len(pairs),
        'routedCount': len(pairs) - len(fallback),
        'fallbackCount': len(fallback),
        'fallbackPairs': sorted(fallback),
        'segments': {key: segments[key] for key in sorted(segments)},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(',', ':'), ensure_ascii=False) + '\n', encoding='utf-8')
    log.info('Wrote %s (%d bytes), fallbacks=%d', args.output, args.output.stat().st_size, len(fallback))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
