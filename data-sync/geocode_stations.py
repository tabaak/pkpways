"""One-off station geocoder (Overpass / OpenStreetMap, Nominatim fallback).

The PKP PLK API gives us station ids + names but never coordinates. This script
backfills `stations.latitude/longitude`.

Strategy
--------
1. **Overpass (primary).** One query pulls *every* railway station/halt/stop in
   Poland with its coordinates. We match PKP names against that set locally —
   exact normalised name first, then a fuzzy pass. This is fast (one HTTP call
   for the whole catalogue) and accurate (we only match against actual railway
   features). Written with geocode_source='overpass'.
2. **Nominatim (fallback).** For names Overpass can't match, optionally geocode
   them one-by-one against Nominatim (rate-limited, ~1 req/s). Enable with
   NOMINATIM_FALLBACK=1. Written with geocode_source='nominatim'.

It is NOT part of the live worker loop. Run it by hand whenever new stations
have appeared with NULL coordinates:

    docker compose run --rm data-sync python geocode_stations.py
    # include the slower Nominatim pass for the leftovers:
    docker compose run --rm -e NOMINATIM_FALLBACK=1 data-sync python geocode_stations.py

Resumable: by default it only touches rows never attempted
(`geocode_source IS NULL`). Set RETRY_UNMATCHED=1 to also re-try rows previously
marked 'unmatched'.

Confidence
----------
* 'high'      — unambiguous exact name match (Overpass), or a Nominatim
                railway-class hit.
* 'low'       — fuzzy / ambiguous match; review these before trusting them.
* 'unmatched' — nothing found (lat/lng left NULL).
"""

from __future__ import annotations

import difflib
import logging
import os
import re
import time
import unicodedata
from typing import Any

import psycopg2
import requests
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("geocode")

OVERPASS_URL = os.environ.get(
    "OVERPASS_URL", "https://overpass-api.de/api/interpreter"
)
NOMINATIM_URL = os.environ.get(
    "NOMINATIM_URL", "https://nominatim.openstreetmap.org/search"
)
USER_AGENT = os.environ.get(
    "GEOCODE_USER_AGENT", "PkpWays/1.0 (viktorr200830@gmail.com)"
)

NOMINATIM_FALLBACK = os.environ.get("NOMINATIM_FALLBACK", "").lower() in ("1", "true", "yes")
RETRY_UNMATCHED = os.environ.get("RETRY_UNMATCHED", "").lower() in ("1", "true", "yes")

# Public Nominatim: keep to <=1 req/s.
NOMINATIM_DELAY_SECONDS = float(os.environ.get("NOMINATIM_DELAY_SECONDS", "1.1"))
# Fuzzy-match cutoff for the Overpass name index (0..1). Higher = stricter.
FUZZY_CUTOFF = float(os.environ.get("FUZZY_CUTOFF", "0.88"))

# Every railway feature we consider a valid station location, in Poland.
OVERPASS_QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="PL"][admin_level=2]->.pl;
(
  node["railway"~"^(station|halt|stop)$"](area.pl);
  way["railway"~"^(station|halt|stop)$"](area.pl);
);
out center tags;
"""


# --------------------------------------------------------------------------- #
# Name normalisation
# --------------------------------------------------------------------------- #
def _ascii_fold(text: str) -> str:
    # 'ł'/'Ł' don't decompose under NFKD, so handle them explicitly.
    text = text.replace("ł", "l").replace("Ł", "L")
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def normalize(name: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace. Keeps Polish letters."""
    text = name.lower().strip()
    text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def fold_key(name: str) -> str:
    """Diacritic-insensitive key, for robustness against ł/ą/ę mismatches."""
    return normalize(_ascii_fold(name))


# --------------------------------------------------------------------------- #
# Overpass
# --------------------------------------------------------------------------- #
def fetch_overpass_index(
    session: requests.Session,
) -> tuple[dict[str, list[tuple[float, float]]], dict[str, list[tuple[float, float]]]]:
    """Build name -> coordinates indexes from all PL railway features.

    Returns (exact_index, folded_index), each mapping a normalised name to the
    list of distinct (lat, lon) it resolves to (deduped to ~100 m).
    """
    log.info("Fetching Polish railway features from Overpass...")
    resp = session.post(OVERPASS_URL, data={"data": OVERPASS_QUERY}, timeout=200)
    resp.raise_for_status()
    elements = resp.json().get("elements", [])

    exact: dict[str, list[tuple[float, float]]] = {}
    folded: dict[str, list[tuple[float, float]]] = {}

    def add(index: dict[str, list[tuple[float, float]]], key: str, coord: tuple[float, float]) -> None:
        if not key:
            return
        bucket = index.setdefault(key, [])
        # Dedupe coordinates within ~100 m so the same station tagged twice
        # (e.g. a node + a way) doesn't read as "ambiguous".
        if all(abs(coord[0] - c[0]) > 1e-3 or abs(coord[1] - c[1]) > 1e-3 for c in bucket):
            bucket.append(coord)

    kept = 0
    for el in elements:
        tags = el.get("tags") or {}
        name = tags.get("name")
        if not name:
            continue
        if el.get("type") == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:  # way — coordinates come from `out center`
            center = el.get("center") or {}
            lat, lon = center.get("lat"), center.get("lon")
        if lat is None or lon is None:
            continue
        coord = (float(lat), float(lon))
        add(exact, normalize(name), coord)
        add(folded, fold_key(name), coord)
        kept += 1

    log.info("Overpass: %d named railway features, %d distinct names", kept, len(exact))
    return exact, folded


def match_overpass(
    name: str,
    exact: dict[str, list[tuple[float, float]]],
    folded: dict[str, list[tuple[float, float]]],
) -> tuple[float, float, str] | None:
    """Return (lat, lon, confidence) or None."""
    key = normalize(name)
    # 1) exact normalised match
    coords = exact.get(key)
    if coords:
        # Unambiguous -> high; several far-apart candidates -> low (pick first).
        return (*coords[0], "high" if len(coords) == 1 else "low")
    # 2) diacritic-folded exact match
    coords = folded.get(fold_key(name))
    if coords:
        return (*coords[0], "high" if len(coords) == 1 else "low")
    # 3) fuzzy against the exact index
    close = difflib.get_close_matches(key, exact.keys(), n=1, cutoff=FUZZY_CUTOFF)
    if close:
        return (*exact[close[0]][0], "low")
    return None


# --------------------------------------------------------------------------- #
# Nominatim fallback
# --------------------------------------------------------------------------- #
RAILWAY_TYPES = ("station", "halt", "stop")


def geocode_nominatim(session: requests.Session, name: str) -> tuple[float, float, str] | None:
    params = {
        "q": name,
        "countrycodes": "pl",
        "format": "jsonv2",
        "limit": 5,
        "addressdetails": 0,
    }
    for attempt in range(4):
        resp = session.get(NOMINATIM_URL, params=params, timeout=30)
        if resp.status_code in (429, 503):
            backoff = NOMINATIM_DELAY_SECONDS * (2 ** attempt)
            log.warning("Nominatim %s, backing off %.1fs", resp.status_code, backoff)
            time.sleep(backoff)
            continue
        resp.raise_for_status()
        results = resp.json()
        if not results:
            return None
        for wanted in RAILWAY_TYPES:
            for r in results:
                if r.get("category") == "railway" and r.get("type") == wanted:
                    return (float(r["lat"]), float(r["lon"]), "high")
        top = results[0]
        return (float(top["lat"]), float(top["lon"]), "low")
    log.error("Giving up on %r after repeated Nominatim throttling", name)
    return None


# --------------------------------------------------------------------------- #
# DB helpers
# --------------------------------------------------------------------------- #
def fetch_stations(cur: Any) -> list[tuple[int, str]]:
    if RETRY_UNMATCHED:
        where = "latitude IS NULL AND (geocode_source IS NULL OR geocode_confidence = 'unmatched')"
    else:
        where = "geocode_source IS NULL"
    cur.execute(f"SELECT pkp_id, name FROM stations WHERE {where} ORDER BY pkp_id;")
    return [(row[0], row[1]) for row in cur.fetchall()]


def write_hit(conn: Any, pkp_id: int, lat: float, lon: float, source: str, confidence: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE stations
            SET latitude = %s, longitude = %s,
                geocode_source = %s, geocode_confidence = %s, updated_at = now()
            WHERE pkp_id = %s;
            """,
            (lat, lon, source, confidence, pkp_id),
        )


def write_unmatched(conn: Any, pkp_id: int, source: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE stations
            SET geocode_source = %s, geocode_confidence = 'unmatched', updated_at = now()
            WHERE pkp_id = %s;
            """,
            (source, pkp_id),
        )


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set (copy .env.example to .env).")

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})

    conn = psycopg2.connect(database_url)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            todo = fetch_stations(cur)
        total = len(todo)
        if not total:
            log.info("Nothing to geocode — all stations already attempted.")
            return 0
        log.info("Geocoding %d station(s)%s", total, " [retrying unmatched]" if RETRY_UNMATCHED else "")

        exact, folded = fetch_overpass_index(session)

        counts = {"high": 0, "low": 0, "unmatched": 0}
        leftovers: list[tuple[int, str]] = []
        for i, (pkp_id, name) in enumerate(todo, start=1):
            hit = match_overpass(name, exact, folded)
            if hit is None:
                leftovers.append((pkp_id, name))
                continue
            lat, lon, confidence = hit
            write_hit(conn, pkp_id, lat, lon, "overpass", confidence)
            counts[confidence] += 1
            log.info("[%d/%d] %s (id=%d): %.5f,%.5f overpass/%s", i, total, name, pkp_id, lat, lon, confidence)

        log.info(
            "Overpass pass done: high=%d low=%d, %d unmatched",
            counts["high"], counts["low"], len(leftovers),
        )

        if leftovers and NOMINATIM_FALLBACK:
            log.info(
                "Nominatim fallback on %d name(s) (~%.0f min at %.1fs/req)",
                len(leftovers), len(leftovers) * NOMINATIM_DELAY_SECONDS / 60, NOMINATIM_DELAY_SECONDS,
            )
            for j, (pkp_id, name) in enumerate(leftovers, start=1):
                try:
                    hit = geocode_nominatim(session, name)
                except requests.RequestException as exc:
                    log.error("[%d/%d] %s (id=%d): Nominatim failed: %s", j, len(leftovers), name, pkp_id, exc)
                    time.sleep(NOMINATIM_DELAY_SECONDS)
                    continue
                if hit is None:
                    write_unmatched(conn, pkp_id, "nominatim")
                    counts["unmatched"] += 1
                    log.info("[%d/%d] %s (id=%d): UNMATCHED", j, len(leftovers), name, pkp_id)
                else:
                    lat, lon, confidence = hit
                    write_hit(conn, pkp_id, lat, lon, "nominatim", confidence)
                    counts[confidence] += 1
                    log.info("[%d/%d] %s (id=%d): %.5f,%.5f nominatim/%s", j, len(leftovers), name, pkp_id, lat, lon, confidence)
                time.sleep(NOMINATIM_DELAY_SECONDS)
        else:
            # Mark the leftovers so a plain re-run doesn't reprocess them.
            for pkp_id, name in leftovers:
                write_unmatched(conn, pkp_id, "overpass")
                counts["unmatched"] += 1

        log.info(
            "Done. high=%d low=%d unmatched=%d (of %d)%s",
            counts["high"], counts["low"], counts["unmatched"], total,
            "" if NOMINATIM_FALLBACK else "  [run with NOMINATIM_FALLBACK=1 to retry unmatched via Nominatim]",
        )
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
