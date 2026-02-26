import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router";
import { Map as MapView } from "../Map";
import { StopMarker } from "../StopMarker";
import { VehicleMarker } from "../VehicleMarker";
import { RouteTrail } from "../RouteTrail";
import { BottomSheet } from "../BottomSheet";
import { Bus, ChevronLeft } from "lucide-react";
import { motion } from "motion/react";
import mapboxgl from "mapbox-gl";
import {
  buildPrecomputedRoute,
  type PrecomputedRoute,
} from "../../utils/geo";
import {
  computeApproachTrail,
  detectBusState,
  type NextDeparture,
} from "../../utils/busState";

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

type BusState =
  | { type: "arriving"; etaMinutes: number; vehicle: Vehicle; trail: [number, number][] }
  | { type: "dwelling"; vehicle: Vehicle; scheduledDepUnix: number | null }
  | { type: "departed"; vehicle: Vehicle | null; nextDepartures: NextDeparture[] }
  | { type: "no-data"; vehicle: Vehicle | null; nextDepartures: NextDeparture[] };

// ─── Layout knobs ─────────────────────────────────────────────────────────────
const SHEET_CONTENT_TOP_MARGIN = 12;
const HEADER_MARGIN_BOTTOM = 16;
const HEADER_GAP = 12;
const HEADER_ICON_SIZE = 48;
const HEADER_ICON_RADIUS = 12;
const STATUS_CARD_RADIUS = 16;
const STATUS_CARD_PADDING = 16;
const STATUS_CARD_MARGIN = 24;
const MISSED_BTN_RADIUS = 16;
const MISSED_BTN_PADDING_Y = 16;
// ─────────────────────────────────────────────────────────────────────────────

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
  const [allVehicles, setAllVehicles] = useState<Vehicle[]>([]);
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
        setAllVehicles(vehicles);

        let state: BusState;
        if (oStop) {
          // Compute precomputed data inline here since useMemo hasn't re-run yet
          // (state setters above haven't triggered a re-render).
          const initPrecomputed = buildPrecomputedRoute(
            coords,
            stops.map((s: { lat: number; lon: number }) => ({ lat: s.lat, lon: s.lon })),
            [oStop.lon, oStop.lat]
          );

          // Fetch PassioGo's predicted arrival times for the origin stop.
          let feedEtas: { trip_id: string | null; arrival_time: number | null }[] = [];
          try {
            const etaRes = await fetch(
              `/api/eta?stop_id=${encodeURIComponent(oStop.id)}`,
              { signal }
            );
            if (etaRes.ok) {
              const etaData = await etaRes.json();
              feedEtas = etaData.etas || [];
            }
          } catch { /* no feed ETAs — schedule fallback will be used */ }

          const detectedState = detectBusState(vehicles, oStop, feedEtas, coords, initPrecomputed ?? undefined);
          if (detectedState.type === "dwelling") {
            const depUnix = await fetchScheduledDeparture(detectedState.vehicle.trip_id, oStop.id);
            state = { type: "dwelling", vehicle: detectedState.vehicle, scheduledDepUnix: depUnix };
          } else if (detectedState.type === "departed" || detectedState.type === "no-data") {
            const nextDeps = await fetchNextDepartures(shuttle.route_id, oStop.id);
            // Match the vehicle that will run the next scheduled trip.
            // Primary: match the preceding block trip (vehicle is currently running it).
            // Fallback: match the scheduled trip_id directly (vehicle already switched).
            const nextTripVehicle = nextDeps.length > 0
              ? (vehicles.find(v => v.trip_id === nextDeps[0].prev_block_trip_id)
                  ?? vehicles.find(v => v.trip_id === nextDeps[0].trip_id)
                  ?? null)
              : null;
            console.log('[TrackingPreBoard] next dep:', nextDeps[0]?.trip_id, 'prev_block:', nextDeps[0]?.prev_block_trip_id, 'live trip_ids:', vehicles.map(v => v.trip_id), 'matched:', !!nextTripVehicle);
            state = { ...detectedState, nextDepartures: nextDeps, vehicle: nextTripVehicle } as BusState;
          } else {
            state = detectedState;
          }
        } else {
          state = { type: "no-data", vehicle: null, nextDepartures: [] };
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

  // Poll every 5s — fetches vehicle positions + feed ETAs in parallel
  useEffect(() => {
    if (!busState || !originStop) return;

    const interval = setInterval(async () => {
      try {
        const oStop = originStopRef.current;
        if (!oStop) return;

        // Fetch vehicle positions and feed ETAs in parallel.
        const [vRes, etaRes] = await Promise.all([
          fetch(`/api/vehicles?route=${encodeURIComponent(shuttle.name)}`),
          fetch(`/api/eta?stop_id=${encodeURIComponent(oStop.id)}`),
        ]);
        if (!vRes.ok) return;
        const data = await vRes.json();
        const vehicles: Vehicle[] = data.vehicles || [];
        setAllVehicles(vehicles);
        const coords = routeCoordsRef.current;

        let feedEtas: { trip_id: string | null; arrival_time: number | null }[] = [];
        if (etaRes.ok) {
          const etaData = await etaRes.json();
          feedEtas = etaData.etas || [];
        }

        const detectedState = detectBusState(vehicles, oStop, feedEtas, coords, precomputedRef.current ?? undefined);
        let state: BusState;

        if (detectedState.type === "dwelling") {
          const depUnix = await fetchScheduledDeparture(detectedState.vehicle.trip_id, oStop.id);
          state = { type: "dwelling", vehicle: detectedState.vehicle, scheduledDepUnix: depUnix };
        } else if (detectedState.type === "departed" || detectedState.type === "no-data") {
          const nextDeps = await fetchNextDepartures(shuttle.route_id, oStop.id);
          const nextTripVehicle = nextDeps.length > 0
            ? (vehicles.find(v => v.trip_id === nextDeps[0].prev_block_trip_id)
                ?? vehicles.find(v => v.trip_id === nextDeps[0].trip_id)
                ?? null)
            : null;
          state = { ...detectedState, nextDepartures: nextDeps, vehicle: nextTripVehicle } as BusState;
        } else {
          state = detectedState;
        }

        setBusState(state);
      } catch { /* keep current state */ }
    }, 5000);

    return () => clearInterval(interval);
  }, [!!busState, !!originStop, shuttle.name, shuttle.route_id]);

  // Derive trail and vehicles to display on the map.
  // - arriving: approach trail + specific vehicle from feed match
  // - dwelling: specific vehicle, no trail
  // - departed, specific vehicle identified (block_id match): approach trail + that vehicle
  // - departed, no specific match but next departure exists: full route shape + ALL live vehicles
  const trail = useMemo(() => {
    if (busState?.type === "arriving") return busState.trail;
    if (busState?.type === "departed" && busState.vehicle && originStop && routeCoords.length >= 2) {
      return computeApproachTrail(busState.vehicle, originStop, routeCoords, precomputedRoute ?? undefined);
    }
    // Can't identify specific vehicle — show full route shape so user sees where the route goes
    if ((busState?.type === "departed" || busState?.type === "no-data")
        && !busState.vehicle
        && busState.nextDepartures.length > 0
        && routeCoords.length >= 2) {
      return routeCoords;
    }
    return null;
  }, [busState, originStop, routeCoords, precomputedRoute]);

  // Which vehicles to render. Array so we can show all of them when the specific one is unknown.
  const displayVehicles = useMemo(() => {
    if (!busState) return [];
    if (busState.type === "arriving") return [busState.vehicle];
    if (busState.type === "dwelling") return [busState.vehicle];
    if (busState.type === "departed") {
      if (busState.vehicle) return [busState.vehicle];
      // Block-id match failed — show every live vehicle on the route so the user
      // can see where all shuttles currently are.
      if (busState.nextDepartures.length > 0) return allVehicles;
    }
    return [];
  }, [busState, allVehicles]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-white">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
      </div>
    );
  }

  return (
    <div className="relative mx-auto h-full w-full max-w-[430px] overflow-hidden bg-white">
      {/* Map */}
      <MapView onMapReady={setMapInstance}>
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

            {/* Vehicle markers */}
            {displayVehicles.map((v) => (
              <VehicleMarker
                key={v.id}
                map={map}
                lng={v.lon}
                lat={v.lat}
                color={shuttle.color}
                bearing={v.bearing}
                pulsing={busState?.type === "dwelling"}
              />
            ))}
          </>
        )}
      </MapView>

      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        className="absolute left-6 top-12 z-30 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white shadow-lg transition-colors hover:bg-gray-50"
      >
        <ChevronLeft className="h-5 w-5 text-gray-700" />
      </button>


      {/* Bottom sheet */}
      <BottomSheet height="auto">
        <div style={{ marginTop: SHEET_CONTENT_TOP_MARGIN, paddingBottom: 8 }}>
          {/* Route header */}
          <div className="flex items-center" style={{ marginBottom: HEADER_MARGIN_BOTTOM, gap: HEADER_GAP }}>
            <div
              className="flex shrink-0 items-center justify-center"
              style={{ backgroundColor: shuttle.color, width: HEADER_ICON_SIZE, height: HEADER_ICON_SIZE, borderRadius: HEADER_ICON_RADIUS }}
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
              className="bg-blue-50 text-center"
              style={{ borderRadius: STATUS_CARD_RADIUS, padding: STATUS_CARD_PADDING, marginBottom: STATUS_CARD_MARGIN }}
            >
              <div className="mb-1 text-3xl">🚌</div>
              <div className="text-lg font-medium">
                Arriving in {busState.etaMinutes} min
              </div>
              <div className="mt-1 text-sm text-gray-600">At {origin}</div>
            </motion.div>
          )}

          {busState?.type === "dwelling" && (() => {
            const now = Date.now() / 1000;
            const depUnix = busState.scheduledDepUnix;
            const isDeparting = depUnix != null && depUnix <= now;
            const minsUntilDep = depUnix != null ? Math.round((depUnix - now) / 60) : null;
            return (
              <motion.div
                initial={{ scale: 0.95 }}
                animate={{ scale: 1 }}
                transition={{ repeat: Infinity, repeatType: "reverse", duration: 1.5 }}
                className="text-center"
                style={{ backgroundColor: `${shuttle.color}15`, borderRadius: STATUS_CARD_RADIUS, padding: STATUS_CARD_PADDING, marginBottom: STATUS_CARD_MARGIN }}
              >
                <div className="mb-1 text-3xl">🚌</div>
                <div className="text-lg font-medium" style={{ color: shuttle.color }}>
                  {isDeparting ? "Departing now" : "Shuttle is here"}
                </div>
                {!isDeparting && depUnix != null && (
                  <div className="mt-0.5 text-sm font-medium" style={{ color: shuttle.color }}>
                    {minsUntilDep != null && minsUntilDep > 0
                      ? `Scheduled to depart in ${minsUntilDep} min`
                      : "Departing any moment"}
                  </div>
                )}
                <div className="mt-1 text-sm text-gray-600">At {origin}</div>
              </motion.div>
            );
          })()}

          {(busState?.type === "departed" || busState?.type === "no-data") && (
            <div className="bg-gray-50 text-center" style={{ borderRadius: STATUS_CARD_RADIUS, padding: STATUS_CARD_PADDING, marginBottom: STATUS_CARD_MARGIN }}>
              <div className="mb-1 text-3xl">🕐</div>
              {busState.nextDepartures.length > 0 ? (
                <>
                  <div className="text-lg font-medium text-gray-700">
                    Scheduled in {Math.max(1, Math.round((busState.nextDepartures[0].departure_unix - Date.now() / 1000) / 60))} min
                  </div>
                  <div className="mt-0.5 text-sm text-gray-500">
                    Next scheduled at {busState.nextDepartures[0].departure_display}
                  </div>
                </>
              ) : (
                <div className="text-lg font-medium text-gray-700">No upcoming departures</div>
              )}
              <div className="mt-1 text-sm text-gray-600">At {origin}</div>
            </div>
          )}

          {/* Back to shuttles button */}
          <button
            onClick={() => navigate("/shuttle-selection", { state: { origin, destination } })}
            className="mt-3 w-full cursor-pointer bg-gray-100 font-medium text-gray-700 transition-all hover:bg-gray-200"
            style={{ borderRadius: MISSED_BTN_RADIUS, paddingTop: MISSED_BTN_PADDING_Y, paddingBottom: MISSED_BTN_PADDING_Y }}
          >
            View Available Shuttles
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}
