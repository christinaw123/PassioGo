import time
from datetime import date

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


@api_bp.route("/next-departures")
def api_next_departures():
    """Return next scheduled departures for a stop on a route.
    Query params: ?stop_id=<id>&route_id=<id>&limit=<n>&vehicle_trip_id=<id>

    vehicle_trip_id: optional — if provided, that trip's departure is included
    even if it's up to 5 minutes in the past (handles a vehicle dwelling
    slightly past its scheduled departure time).
    """
    stop_id = request.args.get("stop_id")
    route_id = request.args.get("route_id")
    vehicle_trip_id = request.args.get("vehicle_trip_id")
    try:
        limit = int(request.args.get("limit", "3"))
    except ValueError:
        limit = 3

    if not stop_id or not route_id:
        return json_error("Missing 'stop_id' and/or 'route_id' query parameters")

    active_service_ids = gtfs.get_active_service_ids(date.today())
    trips_for_route = gtfs.trips_grouped_by_route_id.get(route_id, [])

    now_unix = int(time.time())
    DWELL_GRACE_S = 300  # 5 minutes — allow vehicle_trip_id's departure if recently passed
    departures = []

    from datetime import datetime as _dt
    for trip_row in trips_for_route:
        service_id = trip_row.get("service_id", "")
        if service_id not in active_service_ids:
            continue
        trip_id = trip_row.get("trip_id")
        if not trip_id:
            continue
        stop_times = gtfs.stop_times_by_trip_id.get(trip_id, [])
        is_vehicle_trip = trip_id == vehicle_trip_id

        # For the vehicle's own trip, find the terminal stop_sequence so we can
        # skip that occurrence — the vehicle is arriving there, not departing.
        terminal_seq = None
        if is_vehicle_trip and stop_times:
            try:
                terminal_seq = max(int(s.get("stop_sequence", 0)) for s in stop_times)
            except ValueError:
                pass

        for st in stop_times:
            if st.get("stop_id") != stop_id:
                continue
            # Skip if this is the last stop of the vehicle's current trip;
            # the shuttle is pulling into its terminal, not about to depart.
            if terminal_seq is not None:
                try:
                    if int(st.get("stop_sequence", 0)) == terminal_seq:
                        break
                except ValueError:
                    pass
            dep_time_str = st.get("departure_time") or st.get("arrival_time", "")
            if not dep_time_str:
                continue
            try:
                dep_unix = gtfs.gtfs_time_to_today_unix(dep_time_str)
            except ValueError:
                continue
            # Include if in the future, or if this is the vehicle's current trip
            # and departure was within the dwell grace window
            cutoff = now_unix - DWELL_GRACE_S if is_vehicle_trip else now_unix
            if dep_unix > cutoff:
                dep_display = _dt.fromtimestamp(dep_unix).strftime("%-I:%M %p")
                departures.append({
                    "trip_id": trip_id,
                    "departure_unix": dep_unix,
                    "departure_display": dep_display,
                })
            break  # only one stop_time entry per stop per trip

    departures.sort(key=lambda d: d["departure_unix"])
    return jsonify({
        "stop_id": stop_id,
        "route_id": route_id,
        "departures": departures[:limit],
    })


@api_bp.route("/scheduled-arrival")
def api_scheduled_arrival():
    """Scheduled departure time for a specific trip at a specific stop.

    Finds the first non-terminal occurrence of stop_id in the trip's stop_times,
    which is the scheduled departure for a dwelling vehicle.  If the stop is the
    terminal (last stop) of the trip the vehicle is pulling in, not departing.

    Query params: ?trip_id=<id>&stop_id=<id>
    """
    trip_id = request.args.get("trip_id")
    stop_id = request.args.get("stop_id")
    if not trip_id or not stop_id:
        return json_error("Missing 'trip_id' and/or 'stop_id' query parameters")

    stop_times = gtfs.stop_times_by_trip_id.get(trip_id)
    if not stop_times:
        return json_error(f"No stop times found for trip '{trip_id}'", 404)

    sorted_stops = sorted(stop_times, key=lambda s: int(s.get("stop_sequence", 0)))
    terminal_seq = int(sorted_stops[-1].get("stop_sequence", 0)) if sorted_stops else -1

    now_unix = int(time.time())
    GRACE_S = 600  # 10 min: vehicle may still be at stop slightly past scheduled departure

    from datetime import datetime as _dt
    for st in sorted_stops:
        if st.get("stop_id") != stop_id:
            continue
        try:
            seq = int(st.get("stop_sequence", 0))
        except ValueError:
            continue
        if seq == terminal_seq:
            return json_error(
                f"Stop '{stop_id}' is the terminal of trip '{trip_id}' — vehicle is arriving, not departing",
                404,
            )
        dep_str = st.get("departure_time") or st.get("arrival_time", "")
        if not dep_str:
            continue
        try:
            dep_unix = gtfs.gtfs_time_to_today_unix(dep_str)
        except ValueError:
            continue
        if dep_unix >= now_unix - GRACE_S:
            return jsonify({
                "trip_id": trip_id,
                "stop_id": stop_id,
                "departure_unix": dep_unix,
                "departure_display": _dt.fromtimestamp(dep_unix).strftime("%-I:%M %p"),
            })

    return json_error(
        f"No upcoming scheduled departure for stop '{stop_id}' in trip '{trip_id}'", 404
    )


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
