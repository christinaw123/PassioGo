import time

from flask import jsonify, request

from api import api_bp
import utils.gtfs_loader as gtfs
from utils.vehicle_fetcher import fetch_vehicle_positions, get_vehicles_for_route


def json_error(message: str, http_status: int = 400):
    return jsonify({"error": message}), http_status


@api_bp.route("/vehicles")
def api_vehicles():
    """Return realtime vehicles for a route.
    Query param: ?route=Quad+Express
    """
    route_name = request.args.get("route", "Quad Express")

    try:
        route_id, _color, _geojson, _stops = gtfs.compile_route_data(route_name)
    except RuntimeError as e:
        return json_error(str(e), 404)

    vehicles = get_vehicles_for_route(route_id)

    return jsonify({
        "route_name": route_name,
        "route_id": route_id,
        "vehicles": vehicles,
        "fetched_at": int(time.time()),
    })


@api_bp.route("/vehicles/<vehicle_id>")
def api_vehicle_detail(vehicle_id: str):
    """Return current position of a specific vehicle."""
    vehicle_feed = fetch_vehicle_positions()

    for entity in vehicle_feed.get("entity", []) or []:
        vehicle_update = (entity or {}).get("vehicle")
        if not vehicle_update:
            continue

        vehicle_descriptor = vehicle_update.get("vehicle") or {}
        vid = vehicle_descriptor.get("id") or entity.get("id")
        if str(vid) != vehicle_id:
            continue

        position = vehicle_update.get("position") or {}
        lat = position.get("latitude")
        lon = position.get("longitude")
        if lat is None or lon is None:
            continue

        trip_info = vehicle_update.get("trip") or {}
        trip_id = trip_info.get("trip_id") or trip_info.get("tripId")

        return jsonify({
            "id": vid,
            "label": vehicle_descriptor.get("label"),
            "trip_id": trip_id,
            "route_id": gtfs.route_id_by_trip_id.get(trip_id) if trip_id else None,
            "lat": float(lat),
            "lon": float(lon),
            "bearing": position.get("bearing"),
            "speed": position.get("speed"),
            "stop_id": vehicle_update.get("stop_id"),
            "current_stop_sequence": vehicle_update.get("current_stop_sequence"),
            "timestamp": vehicle_update.get("timestamp"),
        })

    return json_error(f"Vehicle '{vehicle_id}' not found", 404)


@api_bp.route("/vehicles/<vehicle_id>/trail")
def api_vehicle_trail(vehicle_id: str):
    """Return the shape (polyline) of the route a vehicle is currently on."""
    vehicle_feed = fetch_vehicle_positions()

    for entity in vehicle_feed.get("entity", []) or []:
        vehicle_update = (entity or {}).get("vehicle")
        if not vehicle_update:
            continue

        vehicle_descriptor = vehicle_update.get("vehicle") or {}
        vid = vehicle_descriptor.get("id") or entity.get("id")
        if str(vid) != vehicle_id:
            continue

        trip_info = vehicle_update.get("trip") or {}
        trip_id = trip_info.get("trip_id") or trip_info.get("tripId")
        if not trip_id:
            return json_error("Vehicle has no active trip", 404)

        route_id = gtfs.route_id_by_trip_id.get(trip_id)
        if not route_id:
            return json_error("Could not map vehicle trip to a route", 404)

        # find route name from route_id
        route_name = None
        for key, row in gtfs.route_lookup_by_name.items():
            if row.get("route_id") == route_id:
                route_name = row.get("route_long_name") or row.get("route_short_name") or key
                break

        if not route_name:
            return json_error("Could not find route name for vehicle's route", 404)

        try:
            _rid, _color, route_geojson, _stops = gtfs.compile_route_data(route_name)
        except RuntimeError as e:
            return json_error(str(e), 500)

        return jsonify({
            "vehicle_id": vid,
            "route_id": route_id,
            "route_name": route_name,
            "trail": route_geojson,
        })

    return json_error(f"Vehicle '{vehicle_id}' not found", 404)
