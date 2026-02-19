import { useState, useEffect, useMemo, useRef } from "react";
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

interface ShuttleOption {
  route: RouteInfo;
  vehicles: Vehicle[];
  eta: string | null;
  etaMinutes: number;
  routeCoords: [number, number][];
}

/** ~12 mph average shuttle speed in m/s */
const AVG_SPEED_MPS = 5.4;

export function ShuttleSelectionScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const stateOrigin = location.state?.origin || "";
  const stateDestination = location.state?.destination || "";
  const origin = stateOrigin || sessionStorage.getItem("shuttle_origin") || "";
  const destination =
    stateDestination || sessionStorage.getItem("shuttle_destination") || "";

  const [shuttleOptions, setShuttleOptions] = useState<ShuttleOption[]>([]);
  const [selectedShuttle, setSelectedShuttle] = useState<ShuttleOption | null>(
    null
  );
  const [originStop, setOriginStop] = useState<{
    id: string;
    lat: number;
    lon: number;
  } | null>(null);
  const [destStop, setDestStop] = useState<{
    id: string;
    lat: number;
    lon: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);

  // Redirect to home if no origin/destination (e.g. direct URL visit)
  useEffect(() => {
    if (!origin || !destination) navigate("/", { replace: true });
  }, []);

  // Fetch routes, details, vehicles, and ETAs
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
        const matchingRoutes: { route_id: string; route_name: string }[] =
          rbData.routes || [];

        if (matchingRoutes.length === 0) {
          setLoading(false);
          return;
        }

        // For each route, fetch route details + vehicles in parallel
        const allOptions: ShuttleOption[] = await Promise.all(
          matchingRoutes.map(async (r) => {
            const [routeRes, vehiclesRes] = await Promise.all([
              fetch(
                `/api/route?route=${encodeURIComponent(r.route_name || "")}`,
                { signal }
              ),
              fetch(
                `/api/vehicles?route=${encodeURIComponent(r.route_name || "")}`,
                { signal }
              ),
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

            // Extract route polyline from GeoJSON
            let routeCoords: [number, number][] = [];
            try {
              const features = routeData.route_geojson?.features;
              if (features && features.length > 0) {
                routeCoords = features[0].geometry?.coordinates ?? [];
              }
            } catch {
              /* GeoJSON unavailable */
            }

            // Find origin stop in this route's stops
            const oStop = route.stops.find(
              (s) =>
                s.name.toLowerCase().includes(origin.toLowerCase()) ||
                origin.toLowerCase().includes(s.name.toLowerCase())
            );

            // Fetch real ETA if we found the origin stop
            let etaStr: string | null = null;
            let etaMinutes = Infinity;

            if (oStop) {
              if (!originStop) {
                setOriginStop({ id: oStop.id, lat: oStop.lat, lon: oStop.lon });
              }
              try {
                const etaRes = await fetch(`/api/eta?stop_id=${oStop.id}`, {
                  signal,
                });
                if (etaRes.ok) {
                  const etaData = await etaRes.json();
                  if (etaData.etas && etaData.etas.length > 0) {
                    const routeEta = etaData.etas.find(
                      (e: { route_id: string }) =>
                        String(e.route_id) === String(route.route_id)
                    );
                    if (routeEta && routeEta.arrival_time) {
                      const now = Math.floor(Date.now() / 1000);
                      const mins = Math.max(
                        0,
                        Math.round((routeEta.arrival_time - now) / 60)
                      );
                      etaStr = `${mins} min`;
                      etaMinutes = mins;
                    }
                  }
                }
              } catch {
                /* ETA unavailable */
              }
            }

            // Find destination stop
            const dStop = route.stops.find(
              (s) =>
                s.name.toLowerCase().includes(destination.toLowerCase()) ||
                destination.toLowerCase().includes(s.name.toLowerCase())
            );
            if (dStop && !destStop) {
              setDestStop({ id: dStop.id, lat: dStop.lat, lon: dStop.lon });
            }

            const vehicles: Vehicle[] = vehiclesData.vehicles || [];

            // If no real ETA, estimate from nearest vehicle's distance along route
            if (
              etaMinutes === Infinity &&
              oStop &&
              routeCoords.length >= 2 &&
              vehicles.length > 0
            ) {
              const originProj = nearestPointOnLine(routeCoords, [
                oStop.lon,
                oStop.lat,
              ]);
              for (const v of vehicles) {
                const vProj = nearestPointOnLine(routeCoords, [v.lon, v.lat]);
                if (
                  vProj.segIndex < originProj.segIndex ||
                  (vProj.segIndex === originProj.segIndex &&
                    vProj.t <= originProj.t)
                ) {
                  const trail = clipLineSegment(
                    routeCoords,
                    vProj.segIndex,
                    vProj.projPoint,
                    originProj.segIndex,
                    originProj.projPoint
                  );
                  const dist = lineLength(trail);
                  const estMin = Math.max(
                    1,
                    Math.round(dist / AVG_SPEED_MPS / 60)
                  );
                  etaMinutes = Math.min(etaMinutes, estMin);
                }
              }
              if (etaMinutes !== Infinity) {
                etaStr = `~${etaMinutes} min`;
              }
            }

            return {
              route,
              vehicles,
              eta: etaStr,
              etaMinutes,
              routeCoords,
            };
          })
        );

        // Only keep routes with active vehicles, sorted by ETA
        const activeOptions = allOptions
          .filter((opt) => opt.vehicles.length > 0)
          .sort((a, b) => a.etaMinutes - b.etaMinutes);

        if (!signal.aborted) setShuttleOptions(activeOptions);
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

  // Fit map to show origin and destination
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

  // Poll vehicle positions every 5s — use ref to avoid stale closure
  const shuttleOptionsRef = useRef(shuttleOptions);
  shuttleOptionsRef.current = shuttleOptions;

  useEffect(() => {
    if (shuttleOptions.length === 0) return;

    const interval = setInterval(async () => {
      const current = shuttleOptionsRef.current;
      const updated = await Promise.all(
        current.map(async (opt) => {
          try {
            const res = await fetch(
              `/api/vehicles?route=${encodeURIComponent(opt.route.route_name)}`
            );
            if (!res.ok) return opt;
            const data = await res.json();
            return { ...opt, vehicles: data.vehicles || [] };
          } catch {
            return opt;
          }
        })
      );
      setShuttleOptions(updated);
    }, 5000);

    return () => clearInterval(interval);
  }, [shuttleOptions.length]);

  // For each route, find the nearest vehicle approaching the origin stop
  const nearestByRoute = useMemo(() => {
    if (!originStop) return [];

    const results: {
      routeId: string;
      vehicle: Vehicle;
      trail: [number, number][];
      color: string;
      isSelected: boolean;
    }[] = [];

    for (const opt of shuttleOptions) {
      if (opt.routeCoords.length < 2) continue;

      const originProj = nearestPointOnLine(opt.routeCoords, [
        originStop.lon,
        originStop.lat,
      ]);

      let bestDist = Infinity;
      let bestVehicle: Vehicle | null = null;
      let bestTrail: [number, number][] = [];

      for (const v of opt.vehicles) {
        const vProj = nearestPointOnLine(opt.routeCoords, [v.lon, v.lat]);

        // Skip vehicles that have already passed the origin stop
        if (
          vProj.segIndex > originProj.segIndex ||
          (vProj.segIndex === originProj.segIndex && vProj.t > originProj.t)
        ) {
          continue;
        }

        const coords = clipLineSegment(
          opt.routeCoords,
          vProj.segIndex,
          vProj.projPoint,
          originProj.segIndex,
          originProj.projPoint,
        );
        if (coords.length < 2) continue;

        const dist = lineLength(coords);
        if (dist < bestDist) {
          bestDist = dist;
          bestVehicle = v;
          bestTrail = coords;
        }
      }

      if (bestVehicle && bestTrail.length >= 2) {
        results.push({
          routeId: opt.route.route_id,
          vehicle: bestVehicle,
          trail: bestTrail,
          color: opt.route.route_color,
          isSelected:
            selectedShuttle?.route.route_id === opt.route.route_id,
        });
      }
    }

    return results;
  }, [shuttleOptions, originStop, selectedShuttle]);

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

  return (
    <div className="relative mx-auto h-[100dvh] w-full max-w-[430px] overflow-hidden bg-white">
      {/* Map */}
      <Map onMapReady={setMapInstance}>
        {(map) => (
          <>
            {/* Route trail lines (nearest vehicle per route) */}
            {nearestByRoute.map((entry) => (
              <RouteTrail
                key={entry.routeId}
                map={map}
                id={entry.routeId}
                coordinates={entry.trail}
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

            {/* Vehicle markers (nearest per route only) */}
            {(selectedShuttle
              ? nearestByRoute.filter(
                  (e) => e.routeId === selectedShuttle.route.route_id
                )
              : nearestByRoute
            ).map((entry) => (
              <VehicleMarker
                key={entry.vehicle.id}
                map={map}
                lng={entry.vehicle.lon}
                lat={entry.vehicle.lat}
                color={entry.color}
                bearing={entry.vehicle.bearing}
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
          ) : shuttleOptions.length === 0 ? (
            <div className="py-8 text-center text-gray-500">
              <p className="font-medium">No active shuttles</p>
              <p className="mt-1 text-sm">
                No shuttles are currently running between {origin} and{" "}
                {destination}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {shuttleOptions.map((opt, index) => {
                const isSelected =
                  selectedShuttle?.route.route_id === opt.route.route_id;

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
                      borderColor: isSelected
                        ? opt.route.route_color
                        : "#f3f4f6",
                      boxShadow: isSelected
                        ? `0 0 0 2px ${opt.route.route_color}40, 0 8px 16px -4px ${opt.route.route_color}30`
                        : "0 1px 3px 0 rgb(0 0 0 / 0.1)",
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="mb-1 font-medium">
                          {opt.route.route_name}
                        </div>
                        <div className="flex items-center gap-4 text-sm text-gray-600">
                          <div className="flex items-center gap-1">
                            <Clock className="h-4 w-4" />
                            <span>
                              {opt.eta
                                ? `Arrives in ${opt.eta}`
                                : "Active"}
                            </span>
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
                  style={{
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
