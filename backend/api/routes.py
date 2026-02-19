import time

from flask import jsonify, request

from api import api_bp
import utils.gtfs_loader as gtfs
from utils.vehicle_fetcher import get_eta_for_stop, get_trip_timeline


def json_error(message: str, http_status: int = 400):
    return jsonify({"error": message}), http_status


@api_bp.route("/route")
def api_route():
    """Return compiled route data for a given route name.
    Query param: ?route=Quad+Express (defaults to Quad Express)
    """
    route_name = request.args.get("route", "Quad Express")

    try:
        route_id, route_color, route_geojson, route_stops = gtfs.compile_route_data(route_name)
    except RuntimeError as e:
        return json_error(str(e), 404)

    return jsonify({
        "route_id": route_id,
        "route_name": route_name,
        "route_color": route_color,
        "route_geojson": route_geojson,
        "stops": route_stops,
    })


@api_bp.route("/routes")
def api_routes_list():
    """Return list of all available route names."""
    return jsonify({"routes": gtfs.get_all_route_names()})


@api_bp.route("/stops")
def api_stops():
    """Return stops for a route.
    Query param: ?route=Quad+Express
    """
    route_name = request.args.get("route")
    if not route_name:
        return json_error("Missing 'route' query parameter")

    try:
        _route_id, _color, _geojson, stops = gtfs.compile_route_data(route_name)
    except RuntimeError as e:
        return json_error(str(e), 404)

    return jsonify({"route_name": route_name, "stops": stops})


@api_bp.route("/all-stops")
def api_all_stops():
    """Return all unique stops, grouping directional variants.

    Stops like 'Barry's Corner (Northbound)' and 'Barry's Corner (Southbound)'
    are merged into a single 'Barry's Corner' entry at the midpoint.
    The variant_ids field lists the original stop_ids for trip resolution.
    """
    import re

    _DIR_SUFFIX = re.compile(r"\s*\((Northbound|Southbound|Eastbound|Westbound)\)\s*$", re.IGNORECASE)

    # Stops whose directional variants are too far apart to merge
    _NO_MERGE = {"Harvard Square", "Kennedy School"}

    # First pass: collect all stops and identify directional groups
    groups: dict[str, list[dict]] = {}
    standalone: list[dict] = []

    for stop_id, row in gtfs.stop_row_by_stop_id.items():
        name = row.get("stop_name") or stop_id
        try:
            lat = float(row["stop_lat"])
            lon = float(row["stop_lon"])
        except (KeyError, ValueError):
            continue

        match = _DIR_SUFFIX.search(name)
        if match:
            base_name = _DIR_SUFFIX.sub("", name)
            if base_name in _NO_MERGE:
                standalone.append({
                    "id": stop_id, "name": name, "lat": lat, "lon": lon,
                })
            else:
                groups.setdefault(base_name, []).append({
                    "id": stop_id, "name": name, "lat": lat, "lon": lon,
                })
        else:
            standalone.append({
                "id": stop_id, "name": name, "lat": lat, "lon": lon,
            })

    # Build final list: merge directional groups into midpoint entries
    stops = list(standalone)
    for base_name, variants in groups.items():
        mid_lat = sum(v["lat"] for v in variants) / len(variants)
        mid_lon = sum(v["lon"] for v in variants) / len(variants)
        variant_ids = [v["id"] for v in variants]
        stops.append({
            "id": variant_ids[0],  # primary id for lookups
            "name": base_name,
            "lat": mid_lat,
            "lon": mid_lon,
            "variant_ids": variant_ids,
        })

    return jsonify({"stops": stops})


@api_bp.route("/routes-between")
def api_routes_between():
    """Find routes that connect an origin stop to a destination stop.
    Query params: ?origin=Stop+A&destination=Stop+B
    """
    origin = request.args.get("origin")
    destination = request.args.get("destination")

    if not origin or not destination:
        return json_error("Missing 'origin' and/or 'destination' query parameters")

    origin_lower = origin.strip().lower()
    destination_lower = destination.strip().lower()

    # find stop_ids matching origin and destination
    origin_ids = set()
    destination_ids = set()
    for stop_id, row in gtfs.stop_row_by_stop_id.items():
        name = (row.get("stop_name") or "").strip().lower()
        if origin_lower in name or name in origin_lower:
            origin_ids.add(stop_id)
        if destination_lower in name or name in destination_lower:
            destination_ids.add(stop_id)

    if not origin_ids:
        return json_error(f"No stops found matching origin '{origin}'", 404)
    if not destination_ids:
        return json_error(f"No stops found matching destination '{destination}'", 404)

    # check each route's trips for both stops in order
    matching_routes = []
    for route_id, trips in gtfs.trips_grouped_by_route_id.items():
        for trip in trips:
            trip_id = trip.get("trip_id")
            if not trip_id:
                continue
            stop_times = gtfs.stop_times_by_trip_id.get(trip_id, [])

            origin_seq = None
            dest_seq = None
            for st in stop_times:
                sid = st.get("stop_id")
                try:
                    seq = int(st.get("stop_sequence", "0"))
                except ValueError:
                    continue
                if sid in origin_ids and (origin_seq is None or seq < origin_seq):
                    origin_seq = seq
                if sid in destination_ids and (dest_seq is None or seq < dest_seq):
                    dest_seq = seq

            if origin_seq is not None and dest_seq is not None and origin_seq < dest_seq:
                matching_routes.append({
                    "route_id": route_id,
                    "route_name": gtfs.find_route_name_by_id(route_id),
                })
                break  # one match per route is enough

    # deduplicate by route_id
    seen = set()
    unique_routes = []
    for r in matching_routes:
        if r["route_id"] not in seen:
            seen.add(r["route_id"])
            unique_routes.append(r)

    return jsonify({
        "origin": origin,
        "destination": destination,
        "routes": unique_routes,
    })


@api_bp.route("/eta")
def api_eta():
    """Get predicted arrival times for a stop.
    Query param: ?stop_id=1234
    """
    stop_id = request.args.get("stop_id")
    if not stop_id:
        return json_error("Missing 'stop_id' query parameter")

    if stop_id not in gtfs.stop_row_by_stop_id:
        return json_error(f"Unknown stop_id '{stop_id}'", 404)

    stop_row = gtfs.stop_row_by_stop_id[stop_id]
    etas = get_eta_for_stop(stop_id)

    return jsonify({
        "stop_id": stop_id,
        "stop_name": stop_row.get("stop_name"),
        "etas": etas,
        "fetched_at": int(time.time()),
    })


@api_bp.route("/trip-timeline")
def api_trip_timeline():
    """Return ordered stops for a trip with scheduled and predicted times.
    Query param: ?trip_id=12345
    """
    trip_id = request.args.get("trip_id")
    if not trip_id:
        return json_error("Missing 'trip_id' query parameter")

    timeline = get_trip_timeline(trip_id)
    if not timeline:
        return json_error(f"No stop times found for trip '{trip_id}'", 404)

    return jsonify({
        "trip_id": trip_id,
        "stops": timeline,
        "fetched_at": int(time.time()),
    })
