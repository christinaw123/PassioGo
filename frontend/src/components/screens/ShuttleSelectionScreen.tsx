import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router";
import { Map } from "../Map";
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
  lineLength,
  haversineDistance,
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
}

type BusState =
  | { type: "arriving"; etaMinutes: number; vehicle: Vehicle; trail: [number, number][] }
  | { type: "dwelling"; vehicle: Vehicle; leavingInMinutes: number | null }
  | { type: "departed" | "no-data"; nextDepartures: NextDeparture[] };

interface ShuttleOption {
  route: RouteInfo;
  vehicles: Vehicle[];
  busState: BusState;
  routeCoords: [number, number][];
}

/** ~12 mph average shuttle speed in m/s */
const AVG_SPEED_MPS = 5.4;
const DWELL_DISTANCE_M = 100;
const BLEND_MIN_SPEED_MPS = 1.0;
const MAX_OFF_ROUTE_M = 500;

function detectBusState(
  vehicles: Vehicle[],
  originStop: { lat: number; lon: number },
  routeCoords: [number, number][]
): Omit<BusState, "leavingInMinutes" | "departureDisplay" | "nextDepartures"> & { nextDepartures?: NextDeparture[] } {
  if (vehicles.length === 0) {
    return { type: "no-data", nextDepartures: [] };
  }

  const originLngLat: [number, number] = [originStop.lon, originStop.lat];

  // Check if any vehicle is dwelling (within DWELL_DISTANCE_M of origin stop)
  for (const v of vehicles) {
    const dist = haversineDistance([v.lon, v.lat], originLngLat);
    if (dist <= DWELL_DISTANCE_M) {
      return { type: "dwelling", vehicle: v };
    }
  }

  // Find nearest vehicle approaching the origin stop along the route
  if (routeCoords.length >= 2) {
    const originProj = nearestPointOnLine(routeCoords, originLngLat);

    let bestEta = Infinity;
    let bestVehicle: Vehicle | null = null;
    let bestTrail: [number, number][] = [];

    for (const v of vehicles) {
      const vProj = nearestPointOnLine(routeCoords, [v.lon, v.lat]);
      // Skip vehicles too far from the route shape (deadheading / stale trip_id)
      if (vProj.dist > MAX_OFF_ROUTE_M) continue;
      // Only consider vehicles that haven't passed origin yet
      if (
        vProj.segIndex > originProj.segIndex ||
        (vProj.segIndex === originProj.segIndex && vProj.t > originProj.t)
      ) {
        continue;
      }

      const trail = clipLineSegment(
        routeCoords,
        vProj.segIndex,
        vProj.projPoint,
        originProj.segIndex,
        originProj.projPoint
      );
      if (trail.length < 2) continue;

      const dist = lineLength(trail);
      const speed = (v.speed ?? 0) > BLEND_MIN_SPEED_MPS ? v.speed! : AVG_SPEED_MPS;
      const eta = Math.max(1, Math.round(dist / speed / 60));

      if (eta < bestEta) {
        bestEta = eta;
        bestVehicle = v;
        bestTrail = trail;
      }
    }

    if (bestVehicle) {
      return { type: "arriving", etaMinutes: bestEta, vehicle: bestVehicle, trail: bestTrail };
    }
  }

  return { type: "departed", nextDepartures: [] };
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

            let busState: BusState;
            if (oStop) {
              const raw = detectBusState(vehicles, oStop, routeCoords);
              if (raw.type === "dwelling") {
                const dwellingVehicle = (raw as { vehicle: Vehicle }).vehicle;
                const depUnix = await fetchScheduledDeparture(dwellingVehicle.trip_id, oStop.id);
                const leavingIn = depUnix != null
                  ? Math.max(0, Math.round((depUnix - Date.now() / 1000) / 60))
                  : null;
                busState = { type: "dwelling", vehicle: dwellingVehicle, leavingInMinutes: leavingIn };
              } else if (raw.type === "departed" || raw.type === "no-data") {
                const nextDepartures = await fetchNextDepartures(route.route_id, oStop.id);
                busState = { type: raw.type, nextDepartures };
              } else {
                busState = raw as BusState;
              }
            } else {
              busState = { type: "no-data", nextDepartures: [] };
            }

            return { route, vehicles, busState, routeCoords };
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
            const res = await fetch(
              `/api/vehicles?route=${encodeURIComponent(opt.route.route_name)}`
            );
            if (!res.ok) return opt;
            const data = await res.json();
            const freshVehicles: Vehicle[] = data.vehicles || [];

            const routeOStop = oStop
              ? oStop
              : opt.route.stops.find(
                  (s) =>
                    s.name.toLowerCase().includes(origin.toLowerCase()) ||
                    origin.toLowerCase().includes(s.name.toLowerCase())
                );

            if (!routeOStop) return { ...opt, vehicles: freshVehicles };

            const raw = detectBusState(freshVehicles, routeOStop, opt.routeCoords);
            let busState: BusState;

            if (raw.type === "dwelling") {
              const dwellingVehicle = (raw as { vehicle: Vehicle }).vehicle;
              const depUnix = await fetchScheduledDeparture(dwellingVehicle.trip_id, routeOStop.id);
              const leavingIn = depUnix != null
                ? Math.max(0, Math.round((depUnix - Date.now() / 1000) / 60))
                : null;
              busState = { type: "dwelling", vehicle: dwellingVehicle, leavingInMinutes: leavingIn };
            } else if (raw.type === "departed" || raw.type === "no-data") {
              const nextDepartures = await fetchNextDepartures(opt.route.route_id, routeOStop.id);
              busState = { type: raw.type, nextDepartures };
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
      }
      // departed / no-data: no vehicle to show
    }

    return results;
  }, [shuttleOptions, selectedShuttle]);

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
      if (busState.leavingInMinutes === 0) return "Departing now";
      if (busState.leavingInMinutes != null && busState.leavingInMinutes <= 20)
        return `At stop · leaving in ~${busState.leavingInMinutes} min`;
      return "At stop now";
    }
    if (busState.type === "departed" || busState.type === "no-data") {
      if (busState.nextDepartures.length > 0) {
        return `Next at ${busState.nextDepartures[0].departure_display}`;
      }
      return "No upcoming departures";
    }
    return "";
  };

  return (
    <div className="relative mx-auto h-[100dvh] w-full max-w-[430px] overflow-hidden bg-white">
      {/* Map */}
      <Map onMapReady={setMapInstance}>
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
      </Map>

      {/* Back button */}
      <button
        onClick={() =>
          navigate("/", {
            state: { origin, destination, returningFrom: "shuttle-selection" },
          })
        }
        className="absolute left-6 top-12 z-30 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white shadow-lg transition-colors hover:bg-gray-50"
      >
        <ChevronLeft className="h-5 w-5 text-gray-700" />
      </button>

      {/* Bottom sheet */}
      <BottomSheet height="45%">
        <div className="mt-2">
          <h2 className="mb-1 text-xl font-medium">Available Shuttles</h2>
          <p className="mb-6 text-sm text-gray-500">
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
            <div className="space-y-3">
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
                    className="w-full cursor-pointer rounded-2xl border-2 bg-white p-4 text-left transition-all hover:shadow-md"
                    style={{
                      borderLeftColor: opt.route.route_color,
                      borderLeftWidth: 4,
                      borderColor: isSelected ? opt.route.route_color : "#f3f4f6",
                      boxShadow: isSelected
                        ? `0 0 0 2px ${opt.route.route_color}40, 0 8px 16px -4px ${opt.route.route_color}30`
                        : "0 1px 3px 0 rgb(0 0 0 / 0.1)",
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="mb-1 font-medium">{opt.route.route_name}</div>
                        <div className="flex items-center gap-4 text-sm text-gray-600">
                          <div className="flex items-center gap-1">
                            <Clock className="h-4 w-4" />
                            <span>{renderEtaLabel(opt)}</span>
                          </div>
                        </div>
                      </div>
                      <div
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: opt.route.route_color }}
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
                  className="mt-4 w-full cursor-pointer rounded-2xl p-4 font-medium text-white shadow-md transition-all hover:shadow-lg"
                  style={{ backgroundColor: selectedShuttle.route.route_color }}
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
