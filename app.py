import csv
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import requests
from flask import Flask, jsonify, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GTFS_DIR = os.path.join(BASE_DIR, "google_transit")

# GTFS-RT feed for realtime vehicle positions
VEHICLE_POSITIONS_URL = (
    "https://passio3.com/harvard/passioTransit/gtfs/realtime/vehiclePositions.json"
)

# Working with one route for now, will add other routes later; 
# TARGET_ROUTE_NAME = "Quad Yard Express"
TARGET_ROUTE_NAME = "Quad Express"

app = Flask(__name__, static_folder="static")


# -- pre-indexing in memory for faster lookups --
# Dict of (key, value) pairs
route_lookup_by_name: Dict[str, Dict[str, str]] = {}      # maps normalized route names -> full routes.txt row => (trip_id, route_id)
trips_grouped_by_route_id: Dict[str, List[Dict[str, str]]] = {}  # maps route_id -> list of trips for that route => (route_id, trips row)
route_id_by_trip_id: Dict[str, str] = {}                  # reverse of the above, fast lookup for joins => (trip_id, route_id)
stop_row_by_stop_id: Dict[str, Dict[str, str]] = {}       # maps stop_id to a row in stops.txt => (stop_id, stops.txt row)
shape_points_by_shape_id: Dict[str, List[Dict[str, str]]] = {}   # maps shape_id to a ordered list of shape points => (shape_id -> shpaes row)
stop_times_by_trip_id: Dict[str, List[Dict[str, str]]] = {}      # maps trip_id to the stop sequence for that trip in order => (trip_id -> stop_times rows)


# -- initialization state for ONE route --
# will replace with a dict of route_id for multiple routes later
active_route_id: Optional[str] = None
active_route_color_hex: str = "#1E90FF"
active_route_geojson: Optional[Dict[str, Any]] = None
active_route_stops: Optional[List[Dict[str, Any]]] = None

# -- small in-memory cache for realtime vehicle data --
REALTIME_CACHE_TTL_SECONDS = 2.0 # time to live cache suggested by chat
realtime_cache: Dict[str, Any] = {"fetched_at": 0.0, "vehicle_pos": None} 

# HTTP session reuse
http_session = requests.Session() #using this instead of requests.get = faster + less work

# -- helper function: read GTFS file into list of dict rows -- 
def read_gtfs_csv(filename: str) -> List[Dict[str, str]]:
    filepath = os.path.join(GTFS_DIR, filename)
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Missing GTFS file: {filepath}")

    with open(filepath, "r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))

# -- helper function: normalize to all lower + consistent spaces -- 
def normalize_text(text: str) -> str:
    return " ".join((text or "").strip().lower().split())

# -- helper function: normalize GTFS route_color into CSS hex -- 
def normalize_gtfs_hex_color(raw_color: Optional[str], default_color: str = "#1E90FF") -> str:
    if not raw_color:
        return default_color

    color = raw_color.strip()
    if not color:
        return default_color

    if not color.startswith("#"):
        color = f"#{color}"

    # Accept #RGB or #RRGGBB string; otherwise fallback
    if len(color) not in (4, 7):
        return default_color

    return color

# -- helper function: return formatted JSON error message -- 
def json_error(message: str, http_status: int = 400):
    return jsonify({"error": message}), http_status

# -- function to read GTFS file once and convert them into Dicts -- 
def build_static_gtfs_indices() -> None:
    global route_lookup_by_name, trips_grouped_by_route_id, route_id_by_trip_id, \
    stop_row_by_stop_id, shape_points_by_shape_id, stop_times_by_trip_id

    # load raw GTFS files
    routes_rows = read_gtfs_csv("routes.txt")
    stops_rows = read_gtfs_csv("stops.txt")
    trips_rows = read_gtfs_csv("trips.txt")
    stop_times_rows = read_gtfs_csv("stop_times.txt")

    # -- route lookup --
    # build route name dictionary to find a route row
    route_lookup_by_name = {}
    for route_row in routes_rows:
        for name_field in ("route_long_name", "route_short_name", "route_desc"):
            candidate = route_row.get(name_field) or ""
            key = normalize_text(candidate)
            if key:
                route_lookup_by_name.setdefault(key, route_row)

    # -- trips lookup --
    # index trips 
    trips_grouped_by_route_id = {}
    route_id_by_trip_id = {}
    for trip_row in trips_rows:
        trip_id = trip_row.get("trip_id")
        route_id = trip_row.get("route_id")
        if not trip_id or not route_id:
            continue

        route_id_by_trip_id[trip_id] = route_id
        trips_grouped_by_route_id.setdefault(route_id, []).append(trip_row)

    # -- stops lookup --
    stop_row_by_stop_id = {row["stop_id"]: row for row in stops_rows if row.get("stop_id")}

    # -- stop_times lookup --
    # Dict of (trip_id, [stop_times rows])
    stop_times_by_trip_id = {}
    for stop_time_row in stop_times_rows:
        trip_id = stop_time_row.get("trip_id")
        if not trip_id:
            continue
        stop_times_by_trip_id.setdefault(trip_id, []).append(stop_time_row)

    # -- shapes lookup --
    # (shape_id, ordered list of points for polylines)
    shape_points_by_shape_id = {}
    shapes_path = os.path.join(GTFS_DIR, "shapes.txt")
    if os.path.exists(shapes_path):
        shapes_rows = read_gtfs_csv("shapes.txt")

        for shape_point_row in shapes_rows:
            shape_id = shape_point_row.get("shape_id")
            if not shape_id:
                continue
            shape_points_by_shape_id.setdefault(shape_id, []).append(shape_point_row)

        # sorting once here to avoid re-sorting per request
        for shape_id, points in shape_points_by_shape_id.items():
            points.sort(key=lambda p: int(p.get("shape_pt_sequence", "0")))

# -- function to find GTFS route row when given a route name string -- 
def find_route_row_by_name(route_name: str) -> Optional[Dict[str, str]]:
    # normalize the input 
    normalized_target = normalize_text(route_name)
    if not normalized_target:
        return None

    # look for exact match
    match = route_lookup_by_name.get(normalized_target)
    if match:
        return match

    # check for substring match against indexed names
    for candidate_key, route_row in route_lookup_by_name.items():
        if normalized_target in candidate_key:
            return route_row

    return None

# -- route compiler function: converts route name to route object including id, color, geometry, and stops -- 
# turns a route name --> (route_id, route_color, route_geojson, ordered_stops)
def compile_route_data(route_name: str) -> Tuple[str, str, Dict[str, Any], List[Dict[str, Any]]]:
    #find route row
    route_row = find_route_row_by_name(route_name)
    if not route_row:
        raise RuntimeError(
            f'Could not find "{route_name}" in routes.txt. '
        )

    # get route_id
    route_id = route_row.get("route_id")
    if not route_id:
        raise RuntimeError(f'Route "{route_name}" is missing route_id in routes.txt')

    # normalize route color
    route_color = normalize_gtfs_hex_color(route_row.get("route_color"), default_color="#1E90FF")

    # --shapes --
    # choose the best (most points heuristic) shape among trips on this route 
    route_polyline: List[List[float]] = []
    route_trips = trips_grouped_by_route_id.get(route_id, [])
    if not route_trips:
        raise RuntimeError(f"No trips found for route_id={route_id} in trips.txt")

    best_shape_id: Optional[str] = None
    best_shape_point_count = -1

    # scan all trips for route to get shape_id points and then keep largest length
    for trip_row in route_trips:
        shape_id = trip_row.get("shape_id")
        if not shape_id:
            continue

        points = shape_points_by_shape_id.get(shape_id)
        if not points:
            continue

        if len(points) > best_shape_point_count:
            best_shape_point_count = len(points)
            best_shape_id = shape_id

    if best_shape_id:
        points = shape_points_by_shape_id[best_shape_id]
        # GeoJSON coordinates must be [lon, lat]
        route_polyline = [[float(p["shape_pt_lon"]), float(p["shape_pt_lat"])] for p in points]

    # using GeoJSON for Leaflet
    route_geojson = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"route_id": route_id, "name": route_name, "color": route_color},
            "geometry": {"type": "LineString", "coordinates": route_polyline},
        }],
    }

    # -- stops: get stop order using stop_times across all trips --
    # take min stop_sequence per stop_id across all trips, then sort by that.
    min_sequence_by_stop_id: Dict[str, int] = {}

    for trip_row in route_trips:
        trip_id = trip_row.get("trip_id")
        if not trip_id:
            continue

        for stop_time_row in stop_times_by_trip_id.get(trip_id, []):
            stop_id = stop_time_row.get("stop_id")
            if not stop_id:
                continue

            try:
                sequence = int(stop_time_row.get("stop_sequence", "0"))
            except ValueError:
                # treat malformed sequences as very large so they sort to the end
                sequence = 10**9

            prev = min_sequence_by_stop_id.get(stop_id)
            if prev is None or sequence < prev:
                min_sequence_by_stop_id[stop_id] = sequence

    ordered_stop_ids = [
        stop_id for stop_id, _ in sorted(min_sequence_by_stop_id.items(), key=lambda kv: kv[1])
    ]

    # -- build stop list (id, name, lat, long) --
    route_stops: List[Dict[str, Any]] = []
    for stop_id in ordered_stop_ids:
        stop_row = stop_row_by_stop_id.get(stop_id)
        if not stop_row:
            continue

        try:
            stop_lat = float(stop_row["stop_lat"])
            stop_lon = float(stop_row["stop_lon"])
        except Exception:
            continue

        route_stops.append({
            "id": stop_id,
            "name": stop_row.get("stop_name") or stop_row.get("name") or stop_id,
            "lat": stop_lat,
            "lon": stop_lon,
        })

    return route_id, route_color, route_geojson, route_stops

# -- function to get vehicle json with ttl cache-- 
# maybe do atomic caching/use lock later? 
def fetch_vehicle_positions() -> Dict[str, Any]:
    # get time for ttl cache
    now = time.time()
    #read cache state to get last stored data and timestamp
    cached_vehicle_pos = realtime_cache["vehicle_pos"]
    cached_time = realtime_cache["fetched_at"]

    # if we have data and its fresh return it
    if cached_vehicle_pos is not None and (now - cached_time) < REALTIME_CACHE_TTL_SECONDS:
        return cached_vehicle_pos

    # make http request
    response = http_session.get(VEHICLE_POSITIONS_URL, timeout=10)
    response.raise_for_status()
    # parse json
    vehicle_pos = response.json()

    # update cache timestamp 
    realtime_cache["vehicle_pos"] = vehicle_pos
    realtime_cache["fetched_at"] = now

    return vehicle_pos

# -- function to activate selected route at start --
# will use to extend to multiple routes later
def initialize_active_route() -> None:
    # reassign global vars
    global active_route_id, active_route_color_hex, active_route_geojson, active_route_stops

    # compile route by turning TARGET_ROUTE_NAME into (route_id, route_color, geojson, stops)
    route_id, route_color, geojson, stops = compile_route_data(TARGET_ROUTE_NAME)

    # store as active state
    active_route_id = route_id
    active_route_color_hex = route_color
    active_route_geojson = geojson
    active_route_stops = stops

    print(f"Active route initialized: {TARGET_ROUTE_NAME} (route_id={active_route_id}, color={active_route_color_hex})")

# ------- HTTP endpoints --------
# can move this into routes folder later if we need more routes 
    
# returns static/index.html
@app.route("/")
def index():
    return send_from_directory("static", "index.html")

# returns currently active route data
@app.route("/api/route")
def api_route():
    # initialization check 
    if not active_route_id or not active_route_geojson or active_route_stops is None:
        return json_error("Route not initialized", 500)

    return jsonify({
        "route_id": active_route_id,
        "route_name": TARGET_ROUTE_NAME,
        "route_color": active_route_color_hex,
        "route_geojson": active_route_geojson,
        "stops": active_route_stops,
    })

# returns vehicle for the active route
@app.route("/api/vehicles")
def api_vehicles():
    # initialization check for a route
    if not active_route_id:
        return json_error("Route not initialized", 500)

    # get live vehicle data (JSON)
    try:
        vehicle_feed = fetch_vehicle_positions()
    except requests.RequestException as e:
        return json_error(f"Failed to fetch vehicle positions: {e}", 502)
    except ValueError as e:
        # JSON decode error
        return json_error(f"Vehicle positions returned invalid JSON: {e}", 502)

    # store vehicles for active route in list
    vehicles_for_active_route: List[Dict[str, Any]] = []

    # for all vehicles, get and update info
    for entity in vehicle_feed.get("entity", []) or []:
        vehicle_update = (entity or {}).get("vehicle")
        if not vehicle_update:
            continue

        # filtering to active route
        trip_info = vehicle_update.get("trip") or {}
        trip_id = trip_info.get("trip_id") or trip_info.get("tripId")
        if not trip_id:
            continue

        # convert trip_id -> route_id using static GTFS
        route_id = route_id_by_trip_id.get(trip_id)
        if not route_id or str(route_id) != str(active_route_id):
            continue

        # get vehicle location
        position = vehicle_update.get("position") or {}
        lat = position.get("latitude")
        lon = position.get("longitude")
        if lat is None or lon is None:
            continue

        # get stop name
        stop_id = vehicle_update.get("stop_id")
        stop_name = None
        if stop_id and stop_id in stop_row_by_stop_id:
            stop_name = stop_row_by_stop_id[stop_id].get("stop_name")

        # get vehicle id and label
        vehicle_descriptor = vehicle_update.get("vehicle") or {}
        vehicle_id = vehicle_descriptor.get("id") or entity.get("id")

        # rebuild vehicle object
        vehicles_for_active_route.append({
            "id": vehicle_id,
            "label": vehicle_descriptor.get("label"),
            "trip_id": trip_id,
            "lat": float(lat),
            "lon": float(lon),
            "bearing": position.get("bearing"),
            "speed": position.get("speed"),
            "stop_id": stop_id,
            "stop_name": stop_name,
            "current_stop_sequence": vehicle_update.get("current_stop_sequence"),
            "timestamp": vehicle_update.get("timestamp"),
        })

    return jsonify({
        "vehicles": vehicles_for_active_route,
        "fetched_at": int(time.time()),
    })


if __name__ == "__main__":
    build_static_gtfs_indices()
    initialize_active_route()
    app.run(debug=True, port=5000)
