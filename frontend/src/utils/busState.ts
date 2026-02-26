import {
  nearestPointOnLine,
  clipLineSegment,
  haversineDistance,
  type PrecomputedRoute,
} from "./geo";

/** Minimum fields required by detectBusState and computeApproachTrail */
export interface VehiclePosition {
  id: string;
  lat: number;
  lon: number;
  trip_id: string;
  stop_id: string | null;
}

export interface NextDeparture {
  trip_id: string;
  departure_unix: number;
  departure_display: string;
  prev_block_trip_id: string | null;
}

/** Return type of detectBusState — pre-enrichment (scheduledDepUnix and nextDepartures
 *  are filled in by the caller after fetching schedule data). Generic over V so that
 *  callers with a richer Vehicle type get that type back, not just VehiclePosition. */
export type DetectedBusState<V extends VehiclePosition = VehiclePosition> =
  | { type: "arriving"; etaMinutes: number; vehicle: V; trail: [number, number][] }
  | { type: "dwelling"; vehicle: V; scheduledDepUnix: null }
  | { type: "departed"; vehicle: V | null; nextDepartures: NextDeparture[] }
  | { type: "no-data"; vehicle: null; nextDepartures: NextDeparture[] };

/** Tight haversine fallback for dwell (when no stop_id available). 50 m keeps
 *  "at stop now" from firing for a bus parked on the other side of a building. */
const DWELL_DISTANCE_M = 50;

/** Best-effort trail from vehicle to origin along the route shape, for map display only.
 *  Returns [] if the trail can't be built (arriving state is unaffected). */
export function computeApproachTrail(
  vehicle: { lat: number; lon: number },
  originStop: { id: string; lat: number; lon: number },
  routeCoords: [number, number][],
  precomputed?: PrecomputedRoute
): [number, number][] {
  if (routeCoords.length < 2) return [];
  try {
    const isLoop: boolean = precomputed?.isLoop ??
      (routeCoords.length >= 10 &&
        haversineDistance(routeCoords[0], routeCoords[routeCoords.length - 1]) < 100);
    const originProj =
      precomputed?.stopProjs && (precomputed?.originIdx ?? -1) >= 0
        ? precomputed.stopProjs[precomputed.originIdx]
        : nearestPointOnLine(routeCoords, [originStop.lon, originStop.lat]);
    const vProj = nearestPointOnLine(routeCoords, [vehicle.lon, vehicle.lat]);
    if (
      vProj.segIndex < originProj.segIndex ||
      (vProj.segIndex === originProj.segIndex && vProj.t <= originProj.t)
    ) {
      const trail = clipLineSegment(routeCoords, vProj.segIndex, vProj.projPoint, originProj.segIndex, originProj.projPoint);
      return trail.length >= 2 ? trail : [];
    } else if (isLoop) {
      const toEnd = clipLineSegment(routeCoords, vProj.segIndex, vProj.projPoint, routeCoords.length - 2, routeCoords[routeCoords.length - 1]);
      const fromStart = clipLineSegment(routeCoords, 0, routeCoords[0], originProj.segIndex, originProj.projPoint);
      const stitched = [...toEnd, ...fromStart];
      return stitched.length >= 2 ? stitched : [];
    }
    return [];
  } catch {
    return [];
  }
}

/** Classify the current bus state from live vehicle positions and feed ETAs.
 *  Returns a DetectedBusState — callers are responsible for enriching dwelling/departed
 *  states with scheduled departure times and next departure data from the backend. */
export function detectBusState<V extends VehiclePosition>(
  vehicles: V[],
  originStop: { id: string; lat: number; lon: number },
  feedEtas: { trip_id: string | null; arrival_time: number | null }[],
  routeCoords: [number, number][],
  precomputed?: PrecomputedRoute
): DetectedBusState<V> {
  const originLngLat: [number, number] = [originStop.lon, originStop.lat];

  // Dwell check: vehicle is physically at the stop.
  for (const v of vehicles) {
    const dist = haversineDistance([v.lon, v.lat], originLngLat);
    const isDwelling =
      (v.stop_id != null && v.stop_id === originStop.id && dist <= 100) ||
      dist <= DWELL_DISTANCE_M;
    if (isDwelling) return { type: "dwelling", vehicle: v, scheduledDepUnix: null };
  }

  // Use PassioGo's trip updates feed to find the soonest arriving vehicle.
  // Match each ETA entry to a visible vehicle by trip_id.
  const vehicleByTripId = new Map(vehicles.map(v => [v.trip_id, v]));
  const now = Date.now() / 1000;
  let bestEta = Infinity;
  let bestVehicle: V | null = null;
  let bestTrail: [number, number][] = [];

  for (const e of feedEtas) {
    if (!e.trip_id || e.arrival_time == null || e.arrival_time <= now) continue;
    const vehicle = vehicleByTripId.get(e.trip_id);
    if (!vehicle) continue;
    const etaMin = Math.max(1, Math.round((e.arrival_time - now) / 60));
    if (etaMin < bestEta) {
      bestEta = etaMin;
      bestVehicle = vehicle;
      bestTrail = computeApproachTrail(vehicle, originStop, routeCoords, precomputed);
    }
  }

  if (bestVehicle) {
    return { type: "arriving", etaMinutes: bestEta, vehicle: bestVehicle, trail: bestTrail };
  }

  // No feed ETA matched a visible vehicle — shuttle departed or feed not yet publishing.
  // Return the closest live vehicle so callers can show it on the map while the user waits.
  const closestVehicle = vehicles.reduce<V | null>((best, v) => {
    if (!best) return v;
    return haversineDistance([v.lon, v.lat], originLngLat) <
      haversineDistance([best.lon, best.lat], originLngLat) ? v : best;
  }, null);

  if (vehicles.length === 0) return { type: "no-data", vehicle: null, nextDepartures: [] };
  return { type: "departed", vehicle: closestVehicle, nextDepartures: [] };
}
