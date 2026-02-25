import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router";
import { Map } from "../Map";
import { StopMarker } from "../StopMarker";
import { VehicleMarker } from "../VehicleMarker";
import { RouteTrail } from "../RouteTrail";
import { BottomSheet } from "../BottomSheet";
import { Bus, ChevronLeft } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import mapboxgl from "mapbox-gl";
import {
  nearestPointOnLine,
  nearestPointOnLineInRange,
  clipLineSegment,
  lineLength,
  haversineDistance,
  buildPrecomputedRoute,
  type PrecomputedRoute,
} from "../../utils/geo";

interface Vehicle {
  id: string;
  trip_id: string;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  current_stop_sequence: number | null;
  stop_id: string | null;
}

interface NextDeparture {
  trip_id: string;
  departure_unix: number;
  departure_display: string;
}

type BusState =
  | { type: "arriving"; etaMinutes: number; vehicle: Vehicle; trail: [number, number][] }
  | { type: "dwelling"; vehicle: Vehicle; leavingInMinutes: number | null }
  | { type: "departed"; vehicle: Vehicle | null; nextDepartures: NextDeparture[] }
  | { type: "no-data"; nextDepartures: NextDeparture[] };

const AVG_SPEED_MPS = 5.4;
/** Tight haversine fallback for dwell (when no stop_id available). 50 m keeps
 *  "at stop now" from firing for a bus parked on the other side of a building. */
const DWELL_DISTANCE_M = 50;
const BLEND_MIN_SPEED_MPS = 1.0;
/** Show vehicle icon up to this many meters past origin before hiding it */
const DEPARTED_SHOW_DISTANCE_M = 500;
/** Ignore vehicles whose GPS is more than this far from the route shape — filters
 *  deadheading buses or stale trip_ids broadcasting from a different route */
const MAX_OFF_ROUTE_M = 500;

function detectBusState(
  vehicles: Vehicle[],
  originStop: { id: string; lat: number; lon: number },
  routeCoords: [number, number][],
  precomputed?: PrecomputedRoute
): BusState {
  if (vehicles.length === 0) return { type: "no-data", nextDepartures: [] };

  const originLngLat: [number, number] = [originStop.lon, originStop.lat];

  // Dwell check.
  // Primary signal: vehicle's GTFS-RT stop_id matches this stop AND is physically close.
  // This is more reliable than haversine alone since stop_id is set by the vehicle's own
  // onboard system. Fallback: tight haversine (50 m) when stop_id is unavailable.
  for (const v of vehicles) {
    const dist = haversineDistance([v.lon, v.lat], originLngLat);
    const isDwelling =
      (v.stop_id != null && v.stop_id === originStop.id && dist <= 100) ||
      dist <= DWELL_DISTANCE_M;
    if (isDwelling) return { type: "dwelling", vehicle: v, leavingInMinutes: null };
  }

  if (routeCoords.length < 2) return { type: "departed", vehicle: null, nextDepartures: [] };

  // Use precomputed projections if available (computed once when route loads, not per-poll).
  // Fall back to inline computation if not provided.
  type StopProj = { segIndex: number; projPoint: [number, number]; t: number };
  let stopProjs: StopProj[] | null = precomputed?.stopProjs ?? null;
  let originIdx: number = precomputed?.originIdx ?? -1;
  const isLoop: boolean = precomputed?.isLoop ??
    (routeCoords.length >= 10 &&
      haversineDistance(routeCoords[0], routeCoords[routeCoords.length - 1]) < 100);

  // Origin projection — use stop-based if available (avoids wrong loop snap)
  const originProj: StopProj =
    stopProjs && originIdx >= 0
      ? stopProjs[originIdx]
      : nearestPointOnLine(routeCoords, originLngLat);

  // Project a vehicle onto the shape, constrained to its nearest stop's bracket.
  // stopPositions (parallel to stopProjs) are used for the haversine nearest-stop lookup.
  // This prevents nearestPointOnLine from snapping to the wrong iteration on loop routes.
  const stopPositions = precomputed?.stopPositions ?? null;
  const projectVehicle = (
    v: Vehicle
  ): { vProj: ReturnType<typeof nearestPointOnLine>; nearestStopIdx: number } => {
    if (stopProjs && stopPositions) {
      let nearestStopIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < stopPositions.length; i++) {
        const d = haversineDistance([v.lon, v.lat], stopPositions[i]);
        if (d < nearestDist) { nearestDist = d; nearestStopIdx = i; }
      }
      const lo = stopProjs[Math.max(0, nearestStopIdx - 1)].segIndex;
      const hi = stopProjs[Math.min(stopProjs.length - 1, nearestStopIdx + 1)].segIndex;
      return { vProj: nearestPointOnLineInRange(routeCoords, [v.lon, v.lat], lo, hi), nearestStopIdx };
    }
    return { vProj: nearestPointOnLine(routeCoords, [v.lon, v.lat]), nearestStopIdx: -1 };
  };

  let bestEta = Infinity;
  let bestVehicle: Vehicle | null = null;
  let bestTrail: [number, number][] = [];
  let closestPastVehicle: Vehicle | null = null;
  let closestPastDist = Infinity;

  for (const v of vehicles) {
    const { vProj, nearestStopIdx } = projectVehicle(v);
    if (vProj.dist > MAX_OFF_ROUTE_M) continue;

    // Determine approaching vs past using stop-sequence order (handles loops correctly).
    // For loops, use circular modular distance: if the vehicle is within half the loop
    // behind origin in stop order, it is approaching.
    let isApproaching: boolean;
    if (stopProjs && stopPositions && originIdx >= 0 && nearestStopIdx >= 0) {
      const N = stopPositions.length;
      const forwardStopDist = isLoop
        ? (originIdx - nearestStopIdx + N) % N
        : originIdx - nearestStopIdx;
      isApproaching = forwardStopDist > 0 && (isLoop ? forwardStopDist <= N / 2 : true);
    } else {
      isApproaching = !(
        vProj.segIndex > originProj.segIndex ||
        (vProj.segIndex === originProj.segIndex && vProj.t > originProj.t)
      );
    }

    if (isApproaching) {
      // Build trail from vehicle to origin along the shape.
      // For loop routes, if the vehicle is near the end of the shape and origin is near the
      // start, stitch two segments together across the loop boundary.
      let trail: [number, number][];
      if (
        vProj.segIndex < originProj.segIndex ||
        (vProj.segIndex === originProj.segIndex && vProj.t <= originProj.t)
      ) {
        // Normal case: vehicle appears before origin in shape order
        trail = clipLineSegment(
          routeCoords,
          vProj.segIndex,
          vProj.projPoint,
          originProj.segIndex,
          originProj.projPoint
        );
      } else if (isLoop) {
        // Loop wrap-around: vehicle is near end of shape, origin near start.
        // Stitch: vehicle→shape_end + shape_start→origin
        const toEnd = clipLineSegment(
          routeCoords,
          vProj.segIndex,
          vProj.projPoint,
          routeCoords.length - 2,
          routeCoords[routeCoords.length - 1]
        );
        const fromStart = clipLineSegment(
          routeCoords,
          0,
          routeCoords[0],
          originProj.segIndex,
          originProj.projPoint
        );
        trail = [...toEnd, ...fromStart];
      } else {
        trail = [];
      }

      if (trail.length < 2) continue;

      const dist = lineLength(trail);
      const speed = (v.speed ?? 0) > BLEND_MIN_SPEED_MPS ? v.speed! : AVG_SPEED_MPS;
      const eta = Math.max(1, Math.round(dist / speed / 60));

      if (eta < bestEta) {
        bestEta = eta;
        bestVehicle = v;
        bestTrail = trail;
      }
    } else {
      const dist = haversineDistance([v.lon, v.lat], originLngLat);
      if (dist < closestPastDist) {
        closestPastDist = dist;
        closestPastVehicle = v;
      }
    }
  }

  if (bestVehicle) {
    return { type: "arriving", etaMinutes: bestEta, vehicle: bestVehicle, trail: bestTrail };
  }
  return { type: "departed", vehicle: closestPastVehicle, nextDepartures: [] };
}

export function TrackingPreBoardScreen() {
  const navigate = useNavigate();
  const location = useLocation();

  const stateData = location.state || {};
  const origin =
    stateData.origin || sessionStorage.getItem("shuttle_origin") || "";
  const destination =
    stateData.destination || sessionStorage.getItem("shuttle_destination") || "";
  const shuttle = stateData.shuttle || { name: "", color: "#1E90FF", route_id: "" };

  const [busState, setBusState] = useState<BusState | null>(null);
  const [routeCoords, setRouteCoords] = useState<[number, number][]>([]);
  const [routeStops, setRouteStops] = useState<{ lat: number; lon: number }[]>([]);
  const [originStop, setOriginStop] = useState<{ id: string; lat: number; lon: number } | null>(null);
  const [destStop, setDestStop] = useState<{ id: string; lat: number; lon: number } | null>(null);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);
  const [loading, setLoading] = useState(true);

  // Redirect if no data
  useEffect(() => {
    if (!origin || !destination || !shuttle.route_id) {
      navigate("/", { replace: true });
    }
  }, []);

  const fetchNextDepartures = async (routeId: string, stopId: string): Promise<NextDeparture[]> => {
    try {
      const url = `/api/next-departures?route_id=${encodeURIComponent(routeId)}&stop_id=${encodeURIComponent(stopId)}&limit=3`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return data.departures || [];
    } catch {
      return [];
    }
  };

  /** Scheduled departure from stop_times.txt for this specific vehicle trip at this stop. */
  const fetchScheduledDeparture = async (tripId: string, stopId: string): Promise<number | null> => {
    try {
      const res = await fetch(
        `/api/scheduled-arrival?trip_id=${encodeURIComponent(tripId)}&stop_id=${encodeURIComponent(stopId)}`
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.departure_unix ?? null;
    } catch {
      return null;
    }
  };

  // Initial load
  useEffect(() => {
    if (!shuttle.route_id) return;

    const controller = new AbortController();
    const signal = controller.signal;

    const loadData = async () => {
      try {
        const [routeRes, vehiclesRes] = await Promise.all([
          fetch(`/api/route?route=${encodeURIComponent(shuttle.name)}`, { signal }),
          fetch(`/api/vehicles?route=${encodeURIComponent(shuttle.name)}`, { signal }),
        ]);

        if (!routeRes.ok || !vehiclesRes.ok) {
          throw new Error(`HTTP ${routeRes.status}/${vehiclesRes.status}`);
        }

        const routeData = await routeRes.json();
        const vehiclesData = await vehiclesRes.json();

        const stops = routeData.stops || [];
        let coords: [number, number][] = [];
        try {
          const features = routeData.route_geojson?.features;
          if (features && features.length > 0) {
            coords = features[0].geometry.coordinates;
          }
        } catch { /* no geojson */ }
        setRouteCoords(coords);
        setRouteStops(stops.map((s: { lat: number; lon: number }) => ({ lat: s.lat, lon: s.lon })));

        const oStop = stops.find(
          (s: { name: string; id: string; lat: number; lon: number }) =>
            s.name.toLowerCase().includes(origin.toLowerCase()) ||
            origin.toLowerCase().includes(s.name.toLowerCase())
        );
        const dStop = stops.find(
          (s: { name: string; id: string; lat: number; lon: number }) =>
            s.name.toLowerCase().includes(destination.toLowerCase()) ||
            destination.toLowerCase().includes(s.name.toLowerCase())
        );

        if (oStop) setOriginStop({ id: oStop.id, lat: oStop.lat, lon: oStop.lon });
        if (dStop) setDestStop({ id: dStop.id, lat: dStop.lat, lon: dStop.lon });

        const vehicles: Vehicle[] = vehiclesData.vehicles || [];

        let state: BusState;
        if (oStop) {
          // Compute precomputed data inline here since useMemo hasn't re-run yet
          // (state setters above haven't triggered a re-render).
          const initPrecomputed = buildPrecomputedRoute(
            coords,
            stops.map((s: { lat: number; lon: number }) => ({ lat: s.lat, lon: s.lon })),
            [oStop.lon, oStop.lat]
          );
          const raw = detectBusState(vehicles, oStop, coords, initPrecomputed ?? undefined);
          if (raw.type === "dwelling") {
            const depUnix = await fetchScheduledDeparture(raw.vehicle.trip_id, oStop.id);
            const leavingIn = depUnix != null
              ? Math.max(0, Math.round((depUnix - Date.now() / 1000) / 60))
              : null;
            state = { type: "dwelling", vehicle: raw.vehicle, leavingInMinutes: leavingIn };
          } else if (raw.type === "departed" || raw.type === "no-data") {
            const nextDeps = await fetchNextDepartures(shuttle.route_id, oStop.id);
            state = { ...raw, nextDepartures: nextDeps } as BusState;
          } else {
            state = raw;
          }
        } else {
          state = { type: "no-data", nextDepartures: [] };
        }
        setBusState(state);
      } catch (e) {
        if (e instanceof Error && e.name !== "AbortError") {
          console.error("Failed to load tracking data:", e);
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };

    loadData();
    return () => controller.abort();
  }, [shuttle.route_id]);

  // Fit map
  useEffect(() => {
    if (!mapInstance || !originStop || !destStop) return;
    const bounds = new mapboxgl.LngLatBounds();
    bounds.extend([originStop.lon, originStop.lat]);
    bounds.extend([destStop.lon, destStop.lat]);
    const vehicle =
      busState?.type === "arriving" ? busState.vehicle :
      busState?.type === "dwelling" ? busState.vehicle :
      busState?.type === "departed" ? busState.vehicle : null;
    if (vehicle) bounds.extend([vehicle.lon, vehicle.lat]);
    mapInstance.fitBounds(bounds, {
      padding: { top: 80, bottom: 420, left: 60, right: 60 },
      maxZoom: 16,
    });
  }, [mapInstance, originStop, destStop]);

  // Precompute stop-to-shape projections ONCE when route data loads.
  // This avoids re-projecting all stops inside detectBusState on every 5-second poll.
  const precomputedRoute = useMemo<PrecomputedRoute | null>(() => {
    if (!originStop || routeCoords.length < 2 || routeStops.length < 2) return null;
    return buildPrecomputedRoute(routeCoords, routeStops, [originStop.lon, originStop.lat]);
  }, [routeCoords, routeStops, originStop]);

  // Keep refs for polling
  const routeCoordsRef = useRef(routeCoords);
  routeCoordsRef.current = routeCoords;  // needed for fitBounds effect
  const precomputedRef = useRef(precomputedRoute);
  precomputedRef.current = precomputedRoute;
  const originStopRef = useRef(originStop);
  originStopRef.current = originStop;

  // Poll every 5s — pure position-based, no /api/eta
  useEffect(() => {
    if (!busState || !originStop) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/vehicles?route=${encodeURIComponent(shuttle.name)}`);
        if (!res.ok) return;
        const data = await res.json();
        const vehicles: Vehicle[] = data.vehicles || [];
        const coords = routeCoordsRef.current;
        const oStop = originStopRef.current;
        if (!oStop) return;

        const raw = detectBusState(vehicles, oStop, coords, precomputedRef.current ?? undefined);
        let state: BusState;

        if (raw.type === "dwelling") {
          const depUnix = await fetchScheduledDeparture(raw.vehicle.trip_id, oStop.id);
          const leavingIn = depUnix != null
            ? Math.max(0, Math.round((depUnix - Date.now() / 1000) / 60))
            : null;
          state = { type: "dwelling", vehicle: raw.vehicle, leavingInMinutes: leavingIn };
        } else if (raw.type === "departed" || raw.type === "no-data") {
          const nextDeps = await fetchNextDepartures(shuttle.route_id, oStop.id);
          state = { ...raw, nextDepartures: nextDeps } as BusState;
        } else {
          state = raw;
        }

        setBusState(state);
      } catch { /* keep current state */ }
    }, 5000);

    return () => clearInterval(interval);
  }, [!!busState, !!originStop, shuttle.name, shuttle.route_id]);

  // Derive trail from busState
  const trail = useMemo(() => {
    if (busState?.type === "arriving") return busState.trail;
    return null;
  }, [busState]);

  // Determine whether to show the vehicle on the map when departed
  const showDepartedVehicle = useMemo(() => {
    if (busState?.type !== "departed" || !busState.vehicle || !originStop) return false;
    const dist = haversineDistance(
      [busState.vehicle.lon, busState.vehicle.lat],
      [originStop.lon, originStop.lat]
    );
    return dist <= DEPARTED_SHOW_DISTANCE_M;
  }, [busState, originStop]);

  const activeVehicle = useMemo(() => {
    if (!busState) return null;
    if (busState.type === "arriving") return busState.vehicle;
    if (busState.type === "dwelling") return busState.vehicle;
    if (busState.type === "departed" && showDepartedVehicle) return busState.vehicle;
    return null;
  }, [busState, showDepartedVehicle]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-white">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
      </div>
    );
  }

  const isDeparted = busState?.type === "departed";

  return (
    <div className="relative mx-auto h-full w-full max-w-[430px] overflow-hidden bg-white">
      {/* Map */}
      <Map onMapReady={setMapInstance}>
        {(map) => (
          <>
            {/* Trail line */}
            {trail && (
              <RouteTrail
                map={map}
                id={`preboard-${shuttle.route_id}`}
                coordinates={trail}
                color={shuttle.color}
                isSelected={true}
              />
            )}

            {/* Origin marker */}
            {originStop && (
              <StopMarker
                map={map}
                lng={originStop.lon}
                lat={originStop.lat}
                type="origin"
                name={origin}
              />
            )}

            {/* Destination marker */}
            {destStop && (
              <StopMarker
                map={map}
                lng={destStop.lon}
                lat={destStop.lat}
                type="destination"
                name={destination}
              />
            )}

            {/* Vehicle marker */}
            {activeVehicle && (
              <VehicleMarker
                map={map}
                lng={activeVehicle.lon}
                lat={activeVehicle.lat}
                color={shuttle.color}
                bearing={activeVehicle.bearing}
                pulsing={busState?.type === "dwelling"}
              />
            )}
          </>
        )}
      </Map>

      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        className="absolute left-6 top-12 z-30 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white shadow-lg transition-colors hover:bg-gray-50"
      >
        <ChevronLeft className="h-5 w-5 text-gray-700" />
      </button>

      {/* Departed overlay/toast */}
      <AnimatePresence>
        {isDeparted && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute left-4 right-4 top-24 z-40 rounded-2xl bg-white p-4 shadow-xl"
            style={{ borderLeft: `4px solid ${shuttle.color}` }}
          >
            <div className="mb-1 font-medium text-gray-900">Your shuttle has left.</div>
            <div className="mb-3 text-sm text-gray-500">
              Check available shuttles for the next one.
            </div>
            {busState?.type === "departed" && busState.nextDepartures.length > 0 && (
              <div className="mb-3 text-sm text-gray-700">
                Next departure: <span className="font-medium">{busState.nextDepartures[0].departure_display}</span>
              </div>
            )}
            <button
              onClick={() =>
                navigate("/shuttle-selection", {
                  state: { origin, destination },
                })
              }
              className="w-full cursor-pointer rounded-xl py-2 font-medium text-white"
              style={{ backgroundColor: shuttle.color }}
            >
              Go Back
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom sheet */}
      <BottomSheet height="auto">
        <div className="mt-2 pb-2">
          {/* Route header */}
          <div className="mb-6 flex items-center gap-3">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-xl"
              style={{ backgroundColor: shuttle.color }}
            >
              <Bus className="h-6 w-6 text-white" />
            </div>
            <div className="flex-1">
              <div className="text-lg font-medium">{shuttle.name}</div>
              <div className="text-sm text-gray-500">To {destination}</div>
            </div>
          </div>

          {/* Status card */}
          {busState?.type === "arriving" && (
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              transition={{ repeat: Infinity, repeatType: "reverse", duration: 1.5 }}
              className="mb-6 rounded-2xl bg-blue-50 p-4 text-center"
            >
              <div className="mb-1 text-3xl">🚌</div>
              <div className="text-lg font-medium">
                Arriving in {busState.etaMinutes} min
              </div>
              <div className="mt-1 text-sm text-gray-600">At {origin}</div>
            </motion.div>
          )}

          {busState?.type === "dwelling" && (
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              transition={{ repeat: Infinity, repeatType: "reverse", duration: 1.5 }}
              className="mb-6 rounded-2xl p-4 text-center"
              style={{ backgroundColor: `${shuttle.color}15` }}
            >
              <div className="mb-1 text-3xl">🚌</div>
              <div className="text-lg font-medium" style={{ color: shuttle.color }}>
                {busState.leavingInMinutes === 0 ? "Departing now" : "At your stop now"}
              </div>
              {busState.leavingInMinutes != null && busState.leavingInMinutes > 0 && busState.leavingInMinutes <= 20 && (
                <div className="mt-0.5 text-sm font-medium" style={{ color: shuttle.color }}>
                  Leaving in ~{busState.leavingInMinutes} min
                </div>
              )}
              <div className="mt-1 text-sm text-gray-600">At {origin}</div>
            </motion.div>
          )}

          {(busState?.type === "departed" || busState?.type === "no-data") && (
            <div className="mb-6 rounded-2xl bg-gray-50 p-4 text-center">
              <div className="mb-1 text-3xl">🕐</div>
              <div className="text-lg font-medium text-gray-700">
                {busState.nextDepartures.length > 0
                  ? `Next at ${busState.nextDepartures[0].departure_display}`
                  : "No upcoming departures"}
              </div>
              <div className="mt-1 text-sm text-gray-600">At {origin}</div>
            </div>
          )}

          {/* Missed button */}
          <button
            onClick={() => navigate("/")}
            className="mt-3 w-full cursor-pointer rounded-2xl bg-gray-100 py-4 font-medium text-gray-700 transition-all hover:bg-gray-200"
          >
            I missed this shuttle
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}
