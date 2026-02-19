import csv
import os
from typing import Any, Dict, List, Optional, Tuple

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GTFS_DIR = os.path.join(BASE_DIR, "data", "google_transit")

# -- pre-indexing in memory for faster lookups --
route_lookup_by_name: Dict[str, Dict[str, str]] = {}
trips_grouped_by_route_id: Dict[str, List[Dict[str, str]]] = {}
route_id_by_trip_id: Dict[str, str] = {}
stop_row_by_stop_id: Dict[str, Dict[str, str]] = {}
shape_points_by_shape_id: Dict[str, List[Dict[str, str]]] = {}
stop_times_by_trip_id: Dict[str, List[Dict[str, str]]] = {}


def read_gtfs_csv(filename: str) -> List[Dict[str, str]]:
    filepath = os.path.join(GTFS_DIR, filename)
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Missing GTFS file: {filepath}")

    with open(filepath, "r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def normalize_text(text: str) -> str:
    return " ".join((text or "").strip().lower().split())


def normalize_gtfs_hex_color(raw_color: Optional[str], default_color: str = "#1E90FF") -> str:
    if not raw_color:
        return default_color

    color = raw_color.strip()
    if not color:
        return default_color

    if not color.startswith("#"):
        color = f"#{color}"

    if len(color) not in (4, 7):
        return default_color

    return color


def build_static_gtfs_indices() -> None:
    global route_lookup_by_name, trips_grouped_by_route_id, route_id_by_trip_id, \
        stop_row_by_stop_id, shape_points_by_shape_id, stop_times_by_trip_id

    routes_rows = read_gtfs_csv("routes.txt")
    stops_rows = read_gtfs_csv("stops.txt")
    trips_rows = read_gtfs_csv("trips.txt")
    stop_times_rows = read_gtfs_csv("stop_times.txt")

    # route lookup
    route_lookup_by_name = {}
    for route_row in routes_rows:
        for name_field in ("route_long_name", "route_short_name", "route_desc"):
            candidate = route_row.get(name_field) or ""
            key = normalize_text(candidate)
            if key:
                route_lookup_by_name.setdefault(key, route_row)

    # trips lookup
    trips_grouped_by_route_id = {}
    route_id_by_trip_id = {}
    for trip_row in trips_rows:
        trip_id = trip_row.get("trip_id")
        route_id = trip_row.get("route_id")
        if not trip_id or not route_id:
            continue
        route_id_by_trip_id[trip_id] = route_id
        trips_grouped_by_route_id.setdefault(route_id, []).append(trip_row)

    # stops lookup
    stop_row_by_stop_id = {row["stop_id"]: row for row in stops_rows if row.get("stop_id")}

    # stop_times lookup
    stop_times_by_trip_id = {}
    for stop_time_row in stop_times_rows:
        trip_id = stop_time_row.get("trip_id")
        if not trip_id:
            continue
        stop_times_by_trip_id.setdefault(trip_id, []).append(stop_time_row)

    # shapes lookup
    shape_points_by_shape_id = {}
    shapes_path = os.path.join(GTFS_DIR, "shapes.txt")
    if os.path.exists(shapes_path):
        shapes_rows = read_gtfs_csv("shapes.txt")
        for shape_point_row in shapes_rows:
            shape_id = shape_point_row.get("shape_id")
            if not shape_id:
                continue
            shape_points_by_shape_id.setdefault(shape_id, []).append(shape_point_row)

        for shape_id, points in shape_points_by_shape_id.items():
            points.sort(key=lambda p: int(p.get("shape_pt_sequence", "0")))


def find_route_row_by_name(route_name: str) -> Optional[Dict[str, str]]:
    normalized_target = normalize_text(route_name)
    if not normalized_target:
        return None

    match = route_lookup_by_name.get(normalized_target)
    if match:
        return match

    for candidate_key, route_row in route_lookup_by_name.items():
        if normalized_target in candidate_key:
            return route_row

    return None


def compile_route_data(route_name: str) -> Tuple[str, str, Dict[str, Any], List[Dict[str, Any]]]:
    route_row = find_route_row_by_name(route_name)
    if not route_row:
        raise RuntimeError(f'Could not find "{route_name}" in routes.txt.')

    route_id = route_row.get("route_id")
    if not route_id:
        raise RuntimeError(f'Route "{route_name}" is missing route_id in routes.txt')

    route_color = normalize_gtfs_hex_color(route_row.get("route_color"), default_color="#1E90FF")

    # shapes — choose the best (most points) shape among trips on this route
    route_polyline: List[List[float]] = []
    route_trips = trips_grouped_by_route_id.get(route_id, [])
    if not route_trips:
        raise RuntimeError(f"No trips found for route_id={route_id} in trips.txt")

    best_shape_id: Optional[str] = None
    best_shape_point_count = -1

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
        route_polyline = [[float(p["shape_pt_lon"]), float(p["shape_pt_lat"])] for p in points]

    route_geojson = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"route_id": route_id, "name": route_name, "color": route_color},
            "geometry": {"type": "LineString", "coordinates": route_polyline},
        }],
    }

    # stops: get stop order using stop_times across all trips
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
                sequence = 10**9
            prev = min_sequence_by_stop_id.get(stop_id)
            if prev is None or sequence < prev:
                min_sequence_by_stop_id[stop_id] = sequence

    ordered_stop_ids = [
        stop_id for stop_id, _ in sorted(min_sequence_by_stop_id.items(), key=lambda kv: kv[1])
    ]

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


def find_route_name_by_id(route_id: str) -> Optional[str]:
    """Look up a route's display name given its route_id."""
    for _key, row in route_lookup_by_name.items():
        if row.get("route_id") == route_id:
            return row.get("route_long_name") or row.get("route_short_name")
    return None


def get_all_route_names() -> List[str]:
    """Return a list of unique route long names from the loaded GTFS data."""
    seen = set()
    names = []
    for key, row in route_lookup_by_name.items():
        name = row.get("route_long_name") or row.get("route_short_name") or key
        if name not in seen:
            seen.add(name)
            names.append(name)
    return sorted(names)
