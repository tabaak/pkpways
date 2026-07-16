# One-off railway geometry generation

This job converts the currently observed station-to-station pairs into a
static asset. It is deliberately separate from `data-sync`: it does not call
the PKP API, does not write Postgres or Redis, and must not run on the VPS in
production.

## Inputs and output

The generator reads `train_runs.stops` and joins `stations` to reproduce the
frontend's effective route: stations without coordinates are removed before
consecutive pairs are formed. The current live database contains 7,985
directed pairs (4,038 unordered pairs).

It writes `frontend/public/data/rail-segments.json` with one directed key,
`fromStationId:toStationId`, per pair. Values are Google polyline6 strings.
Every value begins and ends at the exact station coordinates, even though OSRM
snaps its route endpoints to the nearest rail edge. A failed route is encoded as
the straight segment and listed in `fallbackPairs`.

Before writing the asset, the generator decodes every final polyline6 value.
This validates the generator's own encoding (not only the OSRM response), so a
corrupt segment fails generation instead of silently rendering as a straight
line in the browser.

The profile keeps sidings, yards and industrial trackage connected for station
access, but assigns them much lower speeds than passenger main/branch tracks so
they are selected only when the topology requires them.

## Reproducible temporary OSRM setup

The commands below use the dated Poland extract and the OSRM arm64 image used
for the generation host. Keep the extract checksum and the image digest with
the generation log.

```bash
export PKPWAYS_REPO=/absolute/path/to/pkpways
mkdir -p /tmp/pkpways-rail-routing
cd /tmp/pkpways-rail-routing
cp "$PKPWAYS_REPO/tools/rail-routing/rail.lua" ./rail.lua

curl -fL -o poland-260715.osm.pbf \
  https://download.geofabrik.de/europe/poland-260715.osm.pbf
curl -fL -o poland-260715.osm.pbf.md5 \
  https://download.geofabrik.de/europe/poland-260715.osm.pbf.md5
md5sum -c poland-260715.osm.pbf.md5

export OSRM_IMAGE='ghcr.io/project-osrm/osrm-backend:v6.0.0@sha256:733da1be48587358a417750655cc4748bbae9af60e3ace610db68d4febe038d8'
docker run --rm -v "$PWD:/data" -v "$PWD/rail.lua:/work/rail.lua:ro" \
  "$OSRM_IMAGE" osrm-extract -p /work/rail.lua \
  /data/poland-260715.osm.pbf
docker run --rm -v "$PWD:/data" "$OSRM_IMAGE" \
  osrm-partition /data/poland-260715
docker run --rm -v "$PWD:/data" "$OSRM_IMAGE" \
  osrm-customize /data/poland-260715

docker run --rm --name pkpways-osrm --network host \
  -v "$PWD:/data:ro" "$OSRM_IMAGE" \
  osrm-routed --algorithm mld /data/poland-260715.osrm
```

Run `osrm-routed` in the background or a separate terminal while generating.
The engine is temporary; remove the container and its working directory after
the asset has been copied into the repository.

## Run the generator

The repository's `data-sync` image already contains Python 3.12, `requests`,
and `psycopg2-binary`. Alternatively, on a host Python environment install the
same dependencies first:

```bash
python3 -m venv /tmp/pkpways-rail-venv
/tmp/pkpways-rail-venv/bin/pip install -r "$PKPWAYS_REPO/data-sync/requirements.txt"
```

Then mount this directory and the output directory into the image (or run the
script with that virtualenv), set `OSRM_URL` to the temporary engine, and run:

```bash
/tmp/pkpways-rail-venv/bin/python "$PKPWAYS_REPO/tools/rail-routing/generate_rail_geometry.py" \
  --database-url "$DATABASE_URL" \
  --osrm-url http://127.0.0.1:5000 \
  --output "$PKPWAYS_REPO/frontend/public/data/rail-segments.json"
```

The generator retries transient HTTP failures three times. Any `NoRoute`, bad
geometry, or station snap farther than 2,500 m is logged and becomes a straight
fallback, so no route renders blank. The final log is the source of truth for
the asset byte size and fallback count.
