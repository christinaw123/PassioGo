import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router";
import { Map as MapView } from "../Map";
import { StopMarker } from "../StopMarker";
import { VehicleMarker } from "../VehicleMarker";
import { RouteTrail } from "../RouteTrail";
import { BottomSheet } from "../BottomSheet";
import { Clock, ChevronLeft } from "lucide-react";
import { motion } from "motion/react";
import mapboxgl from "mapbox-gl";
import {
  nearestPointOnLine,
  clipLineSegment,
  haversineDistance,
  buildPrecomputedRoute,
  type PrecomputedRoute,
} from "../../utils/geo";

interface RouteInfo {
  route_id: string;
  route_name: string;
  route_color: string;
  stops: { id: string; name: string; lat: number; lon: number }[];
}

interface Vehicle {
  id: string;
  label: string | null;
  trip_id: string;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  stop_id: string | null;
  stop_name: string | null;
}

interface NextDeparture {
  trip_id: string;
  departure_unix: number;
  departure_display: string;
  prev_block_trip_id: string | null;
}

type BusState =
  | { type: "arriving"; etaMinutes: number; vehicle: Vehicle; trail: [number, number][] }
  | { type: "dwelling"; vehicle: Vehicle; scheduledDepUnix: number | null }
  | { type: "departed" | "no-data"; nextDepartures: NextDeparture[]; vehicle: Vehicle | null };

interface ShuttleOption {
  route: RouteInfo;
  vehicles: Vehicle[];
  busState: BusState;
  routeCoords: [number, number][];
  /** Precomputed stop projections — built once at load time, reused every poll */
  precomputed: PrecomputedRoute | null;
}

// ─── Layout knobs ────────────────────────────────────────────────────────────
/** Corner radius of each shuttle option card, in px */
const SHUTTLE_CARD_RADIUS = 16;       // try: 8  12  16  20  24
/** Padding inside each shuttle option card, in px */
const SHUTTLE_CARD_PADDING = 12;      // try: 12  16  20  24
/** Vertical gap between shuttle option cards, in px */
const SHUTTLE_CARD_GAP = 12;          // try: 6  8  12  16
/** Gap between the route name/eta block and the color dot, in px */
const SHUTTLE_ITEM_GAP = 16;          // try: 8  12  16  24
/** Gap between the clock icon and the ETA text, in px */
const SHUTTLE_ETA_ICON_GAP = 4;       // try: 2  4  6  8
/** Corner radius of the "Track" confirm button, in px */
const SHUTTLE_BTN_RADIUS = 16;        // try: 8  12  16  20  24
/** Padding of the "Track" confirm button, in px */
const SHUTTLE_BTN_PADDING = 12;       // try: 12  16  20
/** Top margin above the "Available Shuttles" heading, in px */
const HEADER_TOP_MARGIN =12;          // try: 4   8   12  16
/** Bottom margin below the "From X to Y" subtitle (gap before cards), in px */
const HEADER_SUBTITLE_MARGIN = 12;    // try: 12  16  20  24
// ─────────────────────────────────────────────────────────────────────────────

const DWELL_DISTANCE_M = 50;

/** Best-effort trail from vehicle to origin along the route shape, for map display only.
 *  Returns [] if the trail can't be built (arriving state is unaffected). */
function computeApproachTrail(
  vehicle: Vehicle,
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

function detectBusState(
  vehicles: Vehicle[],
  originStop: { id: string; lat: number; lon: number },
  feedEtas: { trip_id: string | null; arrival_time: number | null }[],
  routeCoords: [number, number][],
  precomputed?: PrecomputedRoute
):
  | { type: "arriving"; etaMinutes: number; vehicle: Vehicle; trail: [number, number][] }
  | { type: "dwelling"; vehicle: Vehicle; scheduledDepUnix: null }
  | { type: "departed" | "no-data"; nextDepartures: NextDeparture[]; vehicle: null }
{
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
  let bestVehicle: Vehicle | null = null;
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

  if (vehicles.length === 0) return { type: "no-data", nextDepartures: [], vehicle: null };
  return { type: "departed", nextDepartures: [], vehicle: null };
}

export function ShuttleSelectionScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const stateOrigin = location.state?.origin || "";
  const stateDestination = location.state?.destination || "";
  const origin = stateOrigin || sessionStorage.getItem("shuttle_origin") || "";
  const destination =
    stateDestination || sessionStorage.getItem("shuttle_destination") || "";

  const [shuttleOptions, setShuttleOptions] = useState<ShuttleOption[]>([]);
  const [selectedShuttle, setSelectedShuttle] = useState<ShuttleOption | null>(null);
  const [originStop, setOriginStop] = useState<{ id: string; lat: number; lon: number } | null>(null);
  const [destStop, setDestStop] = useState<{ id: string; lat: number; lon: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);

  // Redirect to home if no origin/destination
  useEffect(() => {
    if (!origin || !destination) navigate("/", { replace: true });
  }, []);

  const fetchNextDepartures = useCallback(
    async (routeId: string, stopId: string): Promise<NextDeparture[]> => {
      try {
        const url = `/api/next-departures?route_id=${encodeURIComponent(routeId)}&stop_id=${encodeURIComponent(stopId)}&limit=3`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return data.departures || [];
      } catch {
        return [];
      }
    },
    []
  );

  /** Scheduled departure from stop_times.txt for this specific vehicle trip at this stop. */
  const fetchScheduledDeparture = useCallback(
    async (tripId: string, stopId: string): Promise<number | null> => {
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
    },
    []
  );

  // Initial load
  useEffect(() => {
    if (!origin || !destination) return;

    const controller = new AbortController();
    const signal = controller.signal;

    const loadData = async () => {
      try {
        const rbRes = await fetch(
          `/api/routes-between?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`,
          { signal }
        );
        if (!rbRes.ok) throw new Error(`HTTP ${rbRes.status}`);
        const rbData = await rbRes.json();
        const matchingRoutes: { route_id: string; route_name: string }[] = rbData.routes || [];

        if (matchingRoutes.length === 0) {
          setLoading(false);
          return;
        }

        const allOptions: ShuttleOption[] = await Promise.all(
          matchingRoutes.map(async (r) => {
            const [routeRes, vehiclesRes] = await Promise.all([
              fetch(`/api/route?route=${encodeURIComponent(r.route_name || "")}`, { signal }),
              fetch(`/api/vehicles?route=${encodeURIComponent(r.route_name || "")}`, { signal }),
            ]);

            if (!routeRes.ok || !vehiclesRes.ok) {
              throw new Error(`HTTP ${routeRes.status}/${vehiclesRes.status}`);
            }

            const routeData = await routeRes.json();
            const vehiclesData = await vehiclesRes.json();

            const route: RouteInfo = {
              route_id: routeData.route_id || r.route_id,
              route_name: routeData.route_name || r.route_name || "",
              route_color: routeData.route_color || "#1E90FF",
              stops: routeData.stops || [],
            };

            let routeCoords: [number, number][] = [];
            try {
              const features = routeData.route_geojson?.features;
              if (features && features.length > 0) {
                routeCoords = features[0].geometry?.coordinates ?? [];
              }
            } catch { /* GeoJSON unavailable */ }

            const oStop = route.stops.find(
              (s) =>
                s.name.toLowerCase().includes(origin.toLowerCase()) ||
                origin.toLowerCase().includes(s.name.toLowerCase())
            );

            if (oStop && !signal.aborted) {
              setOriginStop((prev) => prev ?? { id: oStop.id, lat: oStop.lat, lon: oStop.lon });
            }

            const dStop = route.stops.find(
              (s) =>
                s.name.toLowerCase().includes(destination.toLowerCase()) ||
                destination.toLowerCase().includes(s.name.toLowerCase())
            );
            if (dStop && !signal.aborted) {
              setDestStop((prev) => prev ?? { id: dStop.id, lat: dStop.lat, lon: dStop.lon });
            }

            const vehicles: Vehicle[] = vehiclesData.vehicles || [];

            // Build precomputed route data once — reused on every poll to avoid
            // re-projecting all stops inside detectBusState each time.
            const precomputed = oStop
              ? buildPrecomputedRoute(routeCoords, route.stops, [oStop.lon, oStop.lat])
              : null;

            // Fetch PassioGo's predicted arrival times for the origin stop.
            let feedEtas: { trip_id: string | null; arrival_time: number | null }[] = [];
            if (oStop) {
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
            }

            let busState: BusState;
            if (oStop) {
              const raw = detectBusState(vehicles, oStop, feedEtas, routeCoords, precomputed ?? undefined);
              if (raw.type === "dwelling") {
                const dwellingVehicle = raw.vehicle;
                const depUnix = await fetchScheduledDeparture(dwellingVehicle.trip_id, oStop.id);
                busState = { type: "dwelling", vehicle: dwellingVehicle, scheduledDepUnix: depUnix };
              } else if (raw.type === "departed" || raw.type === "no-data") {
                const nextDepartures = await fetchNextDepartures(route.route_id, oStop.id);
                const nextVehicle = nextDepartures.length > 0
                  ? (vehicles.find(v => v.trip_id === nextDepartures[0].prev_block_trip_id)
                      ?? vehicles.find(v => v.trip_id === nextDepartures[0].trip_id)
                      ?? null)
                  : null;
                console.log(`[${route.route_name}] next trip_id:`, nextDepartures[0]?.trip_id, '| prev_block_trip_id:', nextDepartures[0]?.prev_block_trip_id, '| live trip_ids:', vehicles.map(v => v.trip_id), '| matched:', !!nextVehicle);
                busState = { type: raw.type, nextDepartures, vehicle: nextVehicle };
              } else {
                busState = raw as BusState;
              }
            } else {
              busState = { type: "no-data", nextDepartures: [], vehicle: null };
            }

            return { route, vehicles, busState, routeCoords, precomputed };
          })
        );

        // Sort: arriving first (by ETA), then dwelling, then departed/no-data
        const sorted = allOptions.sort((a, b) => {
          const rank = (s: BusState) =>
            s.type === "arriving" ? 0 : s.type === "dwelling" ? 1 : 2;
          const ra = rank(a.busState);
          const rb = rank(b.busState);
          if (ra !== rb) return ra - rb;
          if (a.busState.type === "arriving" && b.busState.type === "arriving") {
            return a.busState.etaMinutes - b.busState.etaMinutes;
          }
          return 0;
        });

        if (!signal.aborted) setShuttleOptions(sorted);
      } catch (e) {
        if (e instanceof Error && e.name !== "AbortError") {
          console.error("Failed to load shuttle data:", e);
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };

    loadData();
    return () => controller.abort();
  }, [origin, destination]);

  // Fit map to origin + destination
  useEffect(() => {
    if (!mapInstance || !originStop || !destStop) return;
    const bounds = new mapboxgl.LngLatBounds();
    bounds.extend([originStop.lon, originStop.lat]);
    bounds.extend([destStop.lon, destStop.lat]);
    mapInstance.fitBounds(bounds, {
      padding: { top: 80, bottom: 420, left: 60, right: 60 },
      maxZoom: 16,
    });
  }, [mapInstance, originStop, destStop]);

  // Poll every 5s
  const shuttleOptionsRef = useRef(shuttleOptions);
  shuttleOptionsRef.current = shuttleOptions;
  const originStopRef = useRef(originStop);
  originStopRef.current = originStop;

  useEffect(() => {
    if (shuttleOptions.length === 0) return;

    const interval = setInterval(async () => {
      const current = shuttleOptionsRef.current;
      const oStop = originStopRef.current;

      const updated = await Promise.all(
        current.map(async (opt) => {
          try {
            // Pre-compute origin stop so we can fetch vehicles + ETA in parallel.
            const routeOStop = oStop
              ? oStop
              : opt.route.stops.find(
                  (s) =>
                    s.name.toLowerCase().includes(origin.toLowerCase()) ||
                    origin.toLowerCase().includes(s.name.toLowerCase())
                );

            const [vRes, etaRes] = await Promise.all([
              fetch(`/api/vehicles?route=${encodeURIComponent(opt.route.route_name)}`),
              routeOStop
                ? fetch(`/api/eta?stop_id=${encodeURIComponent(routeOStop.id)}`)
                : Promise.resolve(null),
            ]);
            if (!vRes.ok) return opt;
            const data = await vRes.json();
            const freshVehicles: Vehicle[] = data.vehicles || [];

            if (!routeOStop) return { ...opt, vehicles: freshVehicles };

            let feedEtas: { trip_id: string | null; arrival_time: number | null }[] = [];
            if (etaRes?.ok) {
              const etaData = await etaRes.json();
              feedEtas = etaData.etas || [];
            }

            const raw = detectBusState(freshVehicles, routeOStop, feedEtas, opt.routeCoords, opt.precomputed ?? undefined);
            let busState: BusState;

            if (raw.type === "dwelling") {
              const dwellingVehicle = raw.vehicle;
              const depUnix = await fetchScheduledDeparture(dwellingVehicle.trip_id, routeOStop.id);
              busState = { type: "dwelling", vehicle: dwellingVehicle, scheduledDepUnix: depUnix };
            } else if (raw.type === "departed" || raw.type === "no-data") {
              const nextDepartures = await fetchNextDepartures(opt.route.route_id, routeOStop.id);
              const nextVehicle = nextDepartures.length > 0
                ? (freshVehicles.find(v => v.trip_id === nextDepartures[0].prev_block_trip_id)
                    ?? freshVehicles.find(v => v.trip_id === nextDepartures[0].trip_id)
                    ?? null)
                : null;
              console.log(`[poll][${opt.route.route_name}] next trip_id:`, nextDepartures[0]?.trip_id, '| prev_block_trip_id:', nextDepartures[0]?.prev_block_trip_id, '| live trip_ids:', freshVehicles.map(v => v.trip_id), '| matched:', !!nextVehicle);
              busState = { type: raw.type, nextDepartures, vehicle: nextVehicle };
            } else {
              busState = raw as BusState;
            }

            return { ...opt, vehicles: freshVehicles, busState };
          } catch {
            return opt;
          }
        })
      );
      setShuttleOptions(updated);
    }, 5000);

    return () => clearInterval(interval);
  }, [shuttleOptions.length]);

  // Derive map markers from busState
  const nearestByRoute = useMemo(() => {
    const results: {
      routeId: string;
      vehicle: Vehicle;
      trail: [number, number][] | null;
      color: string;
      isSelected: boolean;
      pulsing: boolean;
    }[] = [];

    for (const opt of shuttleOptions) {
      const { busState } = opt;
      if (busState.type === "arriving") {
        results.push({
          routeId: opt.route.route_id,
          vehicle: busState.vehicle,
          trail: busState.trail,
          color: opt.route.route_color,
          isSelected: selectedShuttle?.route.route_id === opt.route.route_id,
          pulsing: false,
        });
      } else if (busState.type === "dwelling") {
        results.push({
          routeId: opt.route.route_id,
          vehicle: busState.vehicle,
          trail: null,
          color: opt.route.route_color,
          isSelected: selectedShuttle?.route.route_id === opt.route.route_id,
          pulsing: true,
        });
      } else if (busState.type === "departed" || busState.type === "no-data") {
        const isSelected = selectedShuttle?.route.route_id === opt.route.route_id;
        if (busState.vehicle) {
          // Block-id match succeeded — show specific vehicle with approach trail.
          const oStop = originStop;
          const trail = oStop
            ? computeApproachTrail(busState.vehicle, oStop, opt.routeCoords, opt.precomputed ?? undefined)
            : null;
          results.push({
            routeId: opt.route.route_id,
            vehicle: busState.vehicle,
            trail,
            color: opt.route.route_color,
            isSelected,
            pulsing: false,
          });
        } else if (opt.vehicles.length > 0 && busState.nextDepartures.length > 0) {
          // Can't identify specific vehicle — show ALL live vehicles on the route.
          // Full route shape as trail for the first entry only (avoids duplicate layers).
          opt.vehicles.forEach((v, i) => {
            results.push({
              routeId: opt.route.route_id,
              vehicle: v,
              trail: i === 0 ? opt.routeCoords : null,
              color: opt.route.route_color,
              isSelected,
              pulsing: false,
            });
          });
        }
      }
    }

    return results;
  }, [shuttleOptions, selectedShuttle, originStop]);

  // Only show departed/no-data routes if their next departure is within 30 min
  const SHOW_WINDOW_S = 30 * 60;
  const visibleOptions = useMemo(() => {
    const nowSecs = Date.now() / 1000;
    return shuttleOptions.filter((opt) => {
      const { busState } = opt;
      if (busState.type === "arriving" || busState.type === "dwelling") return true;
      return (
        busState.nextDepartures.length > 0 &&
        busState.nextDepartures[0].departure_unix - nowSecs <= SHOW_WINDOW_S
      );
    });
  }, [shuttleOptions]);

  const handleConfirm = () => {
    if (selectedShuttle) {
      navigate("/tracking-pre-board", {
        state: {
          origin,
          destination,
          shuttle: {
            name: selectedShuttle.route.route_name,
            color: selectedShuttle.route.route_color,
            route_id: selectedShuttle.route.route_id,
          },
        },
      });
    }
  };

  const renderEtaLabel = (opt: ShuttleOption) => {
    const { busState } = opt;
    if (busState.type === "arriving") {
      return `Arrives in ${busState.etaMinutes} min`;
    }
    if (busState.type === "dwelling") {
      const now = Date.now() / 1000;
      const dep = busState.scheduledDepUnix;
      if (dep != null && dep <= now) return "Departing now";
      if (dep != null) {
        const mins = Math.round((dep - now) / 60);
        return mins > 0 ? `At stop · departs in ${mins} min` : "At stop · departing any moment";
      }
      return "At stop now";
    }
    if (busState.type === "departed" || busState.type === "no-data") {
      if (busState.nextDepartures.length > 0) {
        return `Next scheduled at ${busState.nextDepartures[0].departure_display}`;
      }
      return "No upcoming departures";
    }
    return "";
  };

  return (
    <div className="relative mx-auto h-full w-full max-w-[430px] overflow-hidden bg-white">
      {/* Map */}
      <MapView onMapReady={setMapInstance}>
        {(map) => (
          <>
            {/* Route trail lines */}
            {nearestByRoute
              .filter((e) => e.trail && e.trail.length >= 2)
              .map((entry) => (
                <RouteTrail
                  key={entry.routeId}
                  map={map}
                  id={entry.routeId}
                  coordinates={entry.trail!}
                  color={entry.color}
                  isSelected={entry.isSelected}
                />
              ))}

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
            {(selectedShuttle
              ? nearestByRoute.filter((e) => e.routeId === selectedShuttle.route.route_id)
              : nearestByRoute
            ).map((entry) => (
              <VehicleMarker
                key={entry.vehicle.id}
                map={map}
                lng={entry.vehicle.lon}
                lat={entry.vehicle.lat}
                color={entry.color}
                bearing={entry.vehicle.bearing}
                pulsing={entry.pulsing}
              />
            ))}
          </>
        )}
      </MapView>

      {/* Back button */}
      <button
        onClick={() =>
          navigate("/")
        }
        className="absolute left-6 top-12 z-30 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white shadow-lg transition-colors hover:bg-gray-50"
      >
        <ChevronLeft className="h-5 w-5 text-gray-700" />
      </button>

      {/* Bottom sheet */}
      <BottomSheet height="45%">
        <div style={{ marginTop: HEADER_TOP_MARGIN }}>
          <h2 className="mb-1 text-xl font-medium">Available Shuttles</h2>
          <p className="text-sm text-gray-500" style={{ marginBottom: HEADER_SUBTITLE_MARGIN }}>
            From {origin} to {destination}
          </p>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
            </div>
          ) : visibleOptions.length === 0 ? (
            <div className="py-8 text-center text-gray-500">
              <p className="font-medium">No shuttles in the next 30 min</p>
              <p className="mt-1 text-sm">
                No shuttles are departing between {origin} and {destination} within 30 minutes
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: SHUTTLE_CARD_GAP }}>
              {visibleOptions.map((opt, index) => {
                const isSelected = selectedShuttle?.route.route_id === opt.route.route_id;

                return (
                  <motion.button
                    key={opt.route.route_id}
                    initial={{ y: 20, opacity: 0 }}
                    animate={{
                      y: 0,
                      opacity: 1,
                      scale: isSelected ? 1.02 : 1,
                    }}
                    transition={{ delay: index * 0.1 }}
                    onClick={() => setSelectedShuttle(opt)}
                    className="w-full cursor-pointer bg-white text-left transition-all hover:shadow-md"
                    style={{
                      borderRadius: SHUTTLE_CARD_RADIUS,
                      padding: SHUTTLE_CARD_PADDING,
                      borderLeft: `4px solid ${opt.route.route_color}`,
                      border: isSelected ? `2px solid ${opt.route.route_color}` : "2px solid #f3f4f6",
                      borderLeftWidth: 4,
                      boxShadow: isSelected
                        ? `0 0 0 2px ${opt.route.route_color}40, 0 8px 16px -4px ${opt.route.route_color}30`
                        : "0 1px 3px 0 rgb(0 0 0 / 0.1)",
                    }}
                  >
                    <div className="flex items-center justify-between" style={{ gap: SHUTTLE_ITEM_GAP }}>
                      <div>
                        <div className="mb-1 font-medium">{opt.route.route_name}</div>
                        <div className="flex items-center text-sm text-gray-600" style={{ gap: SHUTTLE_ETA_ICON_GAP }}>
                          <Clock className="h-4 w-4 shrink-0" />
                          <span>{renderEtaLabel(opt)}</span>
                        </div>
                      </div>
                      <div
                        className="shrink-0 rounded-full"
                        style={{ backgroundColor: opt.route.route_color, width: 12, height: 12 }}
                      />
                    </div>
                  </motion.button>
                );
              })}

              {selectedShuttle && (
                <motion.button
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  onClick={handleConfirm}
                  className="mt-4 w-full cursor-pointer font-medium text-white shadow-md transition-all hover:shadow-lg"
                  style={{
                    borderRadius: SHUTTLE_BTN_RADIUS,
                    padding: SHUTTLE_BTN_PADDING,
                    backgroundColor: selectedShuttle.route.route_color,
                  }}
                >
                  Track {selectedShuttle.route.route_name}
                </motion.button>
              )}
            </div>
          )}
        </div>
      </BottomSheet>
    </div>
  );
}
