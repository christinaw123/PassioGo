import time
from typing import Any, Dict, List, Optional

import requests

import utils.gtfs_loader as gtfs

# GTFS-RT feeds
VEHICLE_POSITIONS_URL = (
    "https://passio3.com/harvard/passioTransit/gtfs/realtime/vehiclePositions.json"
)
TRIP_UPDATES_URL = (
    "https://passio3.com/harvard/passioTransit/gtfs/realtime/tripUpdates.json"
)

# TTL cache settings
REALTIME_CACHE_TTL_SECONDS = 2.0

# caches
_vehicle_cache: Dict[str, Any] = {"fetched_at": 0.0, "data": None}
_trip_updates_cache: Dict[str, Any] = {"fetched_at": 0.0, "data": None}

# HTTP session reuse
http_session = requests.Session()


def fetch_vehicle_positions() -> Dict[str, Any]:
    now = time.time()
    if _vehicle_cache["data"] is not None and (now - _vehicle_cache["fetched_at"]) < REALTIME_CACHE_TTL_SECONDS:
        return _vehicle_cache["data"]

    response = http_session.get(VEHICLE_POSITIONS_URL, timeout=10)
    response.raise_for_status()
    data = response.json()

    _vehicle_cache["data"] = data
    _vehicle_cache["fetched_at"] = now
    return data


def fetch_trip_updates() -> Dict[str, Any]:
    now = time.time()
    if _trip_updates_cache["data"] is not None and (now - _trip_updates_cache["fetched_at"]) < REALTIME_CACHE_TTL_SECONDS:
        return _trip_updates_cache["data"]

    response = http_session.get(TRIP_UPDATES_URL, timeout=10)
    response.raise_for_status()
    data = response.json()

    _trip_updates_cache["data"] = data
    _trip_updates_cache["fetched_at"] = now
    return data


def get_vehicles_for_route(route_id: str) -> List[Dict[str, Any]]:
    """Filter realtime vehicle positions to a specific route_id."""
    vehicle_feed = fetch_vehicle_positions()
    vehicles: List[Dict[str, Any]] = []

    for entity in vehicle_feed.get("entity", []) or []:
        vehicle_update = (entity or {}).get("vehicle")
        if not vehicle_update:
            continue

        trip_info = vehicle_update.get("trip") or {}
        trip_id = trip_info.get("trip_id") or trip_info.get("tripId")
        if not trip_id:
            continue

        mapped_route_id = gtfs.route_id_by_trip_id.get(trip_id)
        if not mapped_route_id or str(mapped_route_id) != str(route_id):
            continue

        position = vehicle_update.get("position") or {}
        lat = position.get("latitude")
        lon = position.get("longitude")
        if lat is None or lon is None:
            continue

        stop_id = vehicle_update.get("stop_id")
        stop_name = None
        if stop_id and stop_id in gtfs.stop_row_by_stop_id:
            stop_name = gtfs.stop_row_by_stop_id[stop_id].get("stop_name")

        vehicle_descriptor = vehicle_update.get("vehicle") or {}
        vehicle_id = vehicle_descriptor.get("id") or entity.get("id")

        vehicles.append({
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

    return vehicles


def get_eta_for_stop(stop_id: str) -> List[Dict[str, Any]]:
    """Get predicted arrival times for a specific stop from trip updates feed."""
    trip_updates_feed = fetch_trip_updates()
    etas: List[Dict[str, Any]] = []

    for entity in trip_updates_feed.get("entity", []) or []:
        trip_update = (entity or {}).get("tripUpdate") or (entity or {}).get("trip_update")
        if not trip_update:
            continue

        trip_info = trip_update.get("trip") or {}
        trip_id = trip_info.get("trip_id") or trip_info.get("tripId")
        route_id = gtfs.route_id_by_trip_id.get(trip_id) if trip_id else None

        stop_time_updates = trip_update.get("stopTimeUpdate") or trip_update.get("stop_time_update") or []
        for stu in stop_time_updates:
            stu_stop_id = stu.get("stop_id") or stu.get("stopId")
            if stu_stop_id != stop_id:
                continue

            arrival = stu.get("arrival") or {}
            departure = stu.get("departure") or {}

            etas.append({
                "trip_id": trip_id,
                "route_id": route_id,
                "stop_id": stop_id,
                "arrival_time": arrival.get("time"),
                "arrival_delay": arrival.get("delay"),
                "departure_time": departure.get("time"),
                "departure_delay": departure.get("delay"),
            })

    # sort by arrival time (soonest first)
    etas.sort(key=lambda e: e.get("arrival_time") or float("inf"))
    return etas


def get_trip_timeline(trip_id: str) -> List[Dict[str, Any]]:
    """Return ordered stops for a trip with scheduled and predicted times."""
    static_stops = gtfs.stop_times_by_trip_id.get(trip_id, [])
    if not static_stops:
        return []

    static_stops = sorted(static_stops, key=lambda s: int(s.get("stop_sequence", 0)))

    # Build prediction lookup from trip updates feed
    predictions: Dict[str, Dict] = {}
    trip_updates_feed = fetch_trip_updates()
    for entity in trip_updates_feed.get("entity", []) or []:
        trip_update = (entity or {}).get("tripUpdate") or (entity or {}).get("trip_update")
        if not trip_update:
            continue
        trip_info = trip_update.get("trip") or {}
        tu_trip_id = trip_info.get("trip_id") or trip_info.get("tripId")
        if tu_trip_id != trip_id:
            continue
        for stu in trip_update.get("stopTimeUpdate") or trip_update.get("stop_time_update") or []:
            sid = stu.get("stop_id") or stu.get("stopId")
            if sid:
                predictions[sid] = stu
        break  # found our trip

    timeline: List[Dict[str, Any]] = []
    for st in static_stops:
        stop_id = st.get("stop_id")
        stop_row = gtfs.stop_row_by_stop_id.get(stop_id, {})

        pred = predictions.get(stop_id, {})
        arrival_pred = pred.get("arrival") or {}
        departure_pred = pred.get("departure") or {}

        timeline.append({
            "stop_id": stop_id,
            "stop_name": stop_row.get("stop_name", stop_id),
            "lat": float(stop_row.get("stop_lat", 0)),
            "lon": float(stop_row.get("stop_lon", 0)),
            "stop_sequence": int(st.get("stop_sequence", 0)),
            "scheduled_arrival": st.get("arrival_time"),
            "scheduled_departure": st.get("departure_time"),
            "predicted_arrival": arrival_pred.get("time"),
            "arrival_delay": arrival_pred.get("delay"),
            "predicted_departure": departure_pred.get("time"),
            "departure_delay": departure_pred.get("delay"),
        })

    return timeline
