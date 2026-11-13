#!/usr/bin/env bash
# Downloads OpenStreetMap data for the area in BBOX (south,west,north,east).
# Default: University of Waterloo main campus + Columbia Lake edge.
set -euo pipefail
BBOX="${BBOX:-43.4650,-80.5570,43.4790,-80.5370}"
cd "$(dirname "$0")/.."
Q="[out:json][timeout:90];(
way[\"building\"]($BBOX);relation[\"building\"]($BBOX);way[\"building:part\"]($BBOX);relation[\"building:part\"]($BBOX);
way[\"highway\"]($BBOX);
way[\"natural\"~\"water|wood|scrub|tree_row|grass\"]($BBOX);relation[\"natural\"=\"water\"]($BBOX);
way[\"waterway\"]($BBOX);
way[\"landuse\"]($BBOX);way[\"leisure\"]($BBOX);
way[\"amenity\"=\"parking\"]($BBOX);
way[\"railway\"]($BBOX);
node[\"natural\"=\"tree\"]($BBOX););out geom;"
curl -sf -A "isometric-waterloo/0.1" --data-urlencode "data=$Q" https://overpass-api.de/api/interpreter -o data/osm_raw.json
echo "$BBOX" > data/bbox.txt
echo "saved data/osm_raw.json ($(wc -c < data/osm_raw.json) bytes) for bbox $BBOX"
