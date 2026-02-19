import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router";
import { Map } from "../Map";
import { StopMarker } from "../StopMarker";
import { VehicleMarker } from "../VehicleMarker";
import { RouteTrail } from "../RouteTrail";
import { BottomSheet } from "../BottomSheet";
import { Bus, ChevronLeft, Clock, List } from "lucide-react";
import { motion } from "motion/react";
import mapboxgl from "mapbox-gl";
import {
  nearestPointOnLine,
  clipLineSegment,
  lineLength,
} from "../../utils/geo";

interface Vehicle {
  id: string;
  trip_id: string;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  current_stop_sequence: number | null;
}

interface TimelineStop {
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
  stop_sequence: number;
  scheduled_arrival: string | null;
  predicted_arrival: number | null;
  arrival_delay: number | null;
}

const AVG_SPEED_MPS = 5.4;

export function TrackingPreBoardScreen() {
  const navigate = useNavigate();
  const location = useLocation();

  const stateData = location.state || {};
  const origin =
    stateData.origin || sessionStorage.getItem("shuttle_origin") || "";
  const destination =
    stateData.destination || sessionStorage.getItem("shuttle_destination") || "";
  const shuttle = stateData.shuttle || {
    name: "",
    color: "#1E90FF",
    route_id: "",
  };

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [routeCoords, setRouteCoords] = useState<[number, number][]>([]);
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
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<TimelineStop[]>([]);
  const [showTimeline, setShowTimeline] = useState(false);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);
  const [loading, setLoading] = useState(true);

  // Redirect if no data
  useEffect(() => {
    if (!origin || !destination || !shuttle.route_id) {
      navigate("/", { replace: true });
    }
  }, []);

  // Load route data, find nearest vehicle, get ETA + timeline
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
        } catch {
          /* no geojson */
        }
        setRouteCoords(coords);

        // Find origin and destination stops
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

        // Find nearest vehicle approaching origin
        const vehicles: Vehicle[] = vehiclesData.vehicles || [];
        let bestVehicle: Vehicle | null = null;
        let bestDist = Infinity;

        if (oStop && coords.length >= 2) {
          const originProj = nearestPointOnLine(coords, [oStop.lon, oStop.lat]);
          for (const v of vehicles) {
            const vProj = nearestPointOnLine(coords, [v.lon, v.lat]);
            if (
              vProj.segIndex < originProj.segIndex ||
              (vProj.segIndex === originProj.segIndex &&
                vProj.t <= originProj.t)
            ) {
              const trail = clipLineSegment(
                coords,
                vProj.segIndex,
                vProj.projPoint,
                originProj.segIndex,
                originProj.projPoint
              );
              const dist = lineLength(trail);
              if (dist < bestDist) {
                bestDist = dist;
                bestVehicle = v;
              }
            }
          }
        }

        // Fallback: use first vehicle if none found approaching
        if (!bestVehicle && vehicles.length > 0) {
          bestVehicle = vehicles[0];
        }
        setVehicle(bestVehicle);

        // Get ETA
        if (oStop) {
          try {
            const etaRes = await fetch(`/api/eta?stop_id=${oStop.id}`, { signal });
            if (!etaRes.ok) throw new Error(`ETA HTTP ${etaRes.status}`);
            const etaData = await etaRes.json();
            const routeEta = etaData.etas?.find(
              (e: { route_id: string }) =>
                String(e.route_id) === String(shuttle.route_id)
            );
            if (routeEta?.arrival_time) {
              const now = Math.floor(Date.now() / 1000);
              setEtaMinutes(
                Math.max(0, Math.round((routeEta.arrival_time - now) / 60))
              );
            } else if (bestDist < Infinity) {
              setEtaMinutes(
                Math.max(1, Math.round(bestDist / AVG_SPEED_MPS / 60))
              );
            }
          } catch {
            if (bestDist < Infinity) {
              setEtaMinutes(
                Math.max(1, Math.round(bestDist / AVG_SPEED_MPS / 60))
              );
            }
          }
        }

        // Get trip timeline
        if (bestVehicle?.trip_id) {
          try {
            const tlRes = await fetch(
              `/api/trip-timeline?trip_id=${encodeURIComponent(bestVehicle.trip_id)}`,
              { signal }
            );
            if (tlRes.ok) {
              const tlData = await tlRes.json();
              setTimeline(tlData.stops || []);
            }
          } catch {
            /* timeline unavailable */
          }
        }
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
    if (vehicle) bounds.extend([vehicle.lon, vehicle.lat]);
    mapInstance.fitBounds(bounds, {
      padding: { top: 80, bottom: 420, left: 60, right: 60 },
      maxZoom: 16,
    });
  }, [mapInstance, originStop, destStop, vehicle]);

  // Keep routeCoords in a ref so polling doesn't restart when coords load
  const routeCoordsRef = useRef(routeCoords);
  routeCoordsRef.current = routeCoords;

  // Poll vehicle + ETA every 5s
  useEffect(() => {
    if (!vehicle || !originStop) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/vehicles?route=${encodeURIComponent(shuttle.name)}`
        );
        if (!res.ok) return;
        const data = await res.json();
        const vehicles: Vehicle[] = data.vehicles || [];
        const coords = routeCoordsRef.current;

        // Try to find the same vehicle by id
        const same = vehicles.find((v) => v.id === vehicle.id);
        if (same) {
          setVehicle(same);
        } else if (vehicles.length > 0 && coords.length >= 2) {
          // Find nearest approaching vehicle
          const originProj = nearestPointOnLine(coords, [
            originStop.lon,
            originStop.lat,
          ]);
          let best: Vehicle | null = null;
          let bestD = Infinity;
          for (const v of vehicles) {
            const vProj = nearestPointOnLine(coords, [v.lon, v.lat]);
            if (
              vProj.segIndex < originProj.segIndex ||
              (vProj.segIndex === originProj.segIndex &&
                vProj.t <= originProj.t)
            ) {
              const t = clipLineSegment(
                coords,
                vProj.segIndex,
                vProj.projPoint,
                originProj.segIndex,
                originProj.projPoint
              );
              const d = lineLength(t);
              if (d < bestD) {
                bestD = d;
                best = v;
              }
            }
          }
          if (best) setVehicle(best);
        }

        // Refresh ETA
        const etaRes = await fetch(`/api/eta?stop_id=${originStop.id}`);
        if (etaRes.ok) {
          const etaData = await etaRes.json();
          const routeEta = etaData.etas?.find(
            (e: { route_id: string }) =>
              String(e.route_id) === String(shuttle.route_id)
          );
          if (routeEta?.arrival_time) {
            const now = Math.floor(Date.now() / 1000);
            setEtaMinutes(
              Math.max(0, Math.round((routeEta.arrival_time - now) / 60))
            );
          }
        }
      } catch {
        /* poll failed, keep current state */
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [vehicle?.id, originStop, shuttle.name, shuttle.route_id]);

  // Compute trail from vehicle to origin
  const trail = useMemo(() => {
    if (!vehicle || !originStop || routeCoords.length < 2) return null;

    const originProj = nearestPointOnLine(routeCoords, [
      originStop.lon,
      originStop.lat,
    ]);
    const vProj = nearestPointOnLine(routeCoords, [vehicle.lon, vehicle.lat]);

    if (
      vProj.segIndex > originProj.segIndex ||
      (vProj.segIndex === originProj.segIndex && vProj.t > originProj.t)
    ) {
      return null;
    }

    const coords = clipLineSegment(
      routeCoords,
      vProj.segIndex,
      vProj.projPoint,
      originProj.segIndex,
      originProj.projPoint
    );
    return coords.length >= 2 ? coords : null;
  }, [vehicle, originStop, routeCoords]);

  // Filter timeline: from vehicle's current stop onward
  const visibleTimeline = useMemo(() => {
    if (timeline.length === 0 || !vehicle) return timeline;
    const vehicleSeq = vehicle.current_stop_sequence;
    if (vehicleSeq == null) return timeline;
    return timeline.filter((s) => s.stop_sequence >= vehicleSeq);
  }, [timeline, vehicle]);

  const handleBoardShuttle = () => {
    navigate("/tracking-on-board", {
      state: { origin, destination, shuttle },
    });
  };

  const formatTime = (unixTime: number | null): string => {
    if (!unixTime) return "";
    const d = new Date(unixTime * 1000);
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  if (loading) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-white">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
      </div>
    );
  }

  return (
    <div className="relative mx-auto h-[100dvh] w-full max-w-[430px] overflow-hidden bg-white">
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
            {vehicle && (
              <VehicleMarker
                map={map}
                lng={vehicle.lon}
                lat={vehicle.lat}
                color={shuttle.color}
                bearing={vehicle.bearing}
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

          {/* Arriving card */}
          <motion.div
            initial={{ scale: 0.95 }}
            animate={{ scale: 1 }}
            transition={{
              repeat: Infinity,
              repeatType: "reverse",
              duration: 1.5,
            }}
            className="mb-6 rounded-2xl bg-blue-50 p-4 text-center"
          >
            <div className="mb-1 text-3xl">🚌</div>
            <div className="text-lg font-medium">
              {etaMinutes != null
                ? `Arriving in ${etaMinutes} min`
                : "Shuttle approaching"}
            </div>
            <div className="mt-1 text-sm text-gray-600">At {origin}</div>
          </motion.div>

          {/* Timeline toggle */}
          {!showTimeline && visibleTimeline.length > 0 && (
            <button
              onClick={() => setShowTimeline(true)}
              className="mb-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-gray-50 py-3 font-medium text-gray-700 transition-all hover:bg-gray-100"
            >
              <List className="h-5 w-5" />
              See route timeline
            </button>
          )}

          {/* Timeline */}
          {showTimeline && visibleTimeline.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="mb-6"
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-medium text-gray-500">
                  Route timeline
                </div>
                <button
                  onClick={() => setShowTimeline(false)}
                  className="cursor-pointer text-sm text-gray-500 hover:text-gray-700"
                >
                  Hide
                </button>
              </div>

              <div className="relative">
                {/* Vertical line */}
                <div
                  className="absolute bottom-0 left-[11px] top-0 w-0.5"
                  style={{ backgroundColor: `${shuttle.color}30` }}
                />

                <div className="space-y-0">
                  {visibleTimeline.map((stop, index) => {
                    const isOrigin =
                      stop.stop_name
                        .toLowerCase()
                        .includes(origin.toLowerCase()) ||
                      origin
                        .toLowerCase()
                        .includes(stop.stop_name.toLowerCase());
                    const isFirst = index === 0;
                    const isDelayed =
                      stop.arrival_delay != null && stop.arrival_delay > 60;

                    return (
                      <motion.div
                        key={stop.stop_id}
                        initial={{ x: -20, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        transition={{ delay: index * 0.1 }}
                        className="relative pb-6 last:pb-0"
                      >
                        <div
                          className={`-ml-3 flex items-start gap-4 rounded-xl p-3 transition-colors ${
                            isOrigin ? "border-2" : ""
                          }`}
                          style={
                            isOrigin
                              ? {
                                  borderColor: shuttle.color,
                                  backgroundColor: `${shuttle.color}10`,
                                }
                              : {}
                          }
                        >
                          {/* Stop indicator */}
                          <div className="relative z-10 shrink-0">
                            {isFirst ? (
                              <div
                                className="flex h-6 w-6 items-center justify-center rounded-lg"
                                style={{ backgroundColor: shuttle.color }}
                              >
                                <Bus className="h-4 w-4 text-white" />
                              </div>
                            ) : (
                              <div
                                className="flex h-6 w-6 items-center justify-center rounded-full border-2 bg-white"
                                style={{ borderColor: shuttle.color }}
                              >
                                {isOrigin && (
                                  <div
                                    className="h-2 w-2 rounded-full"
                                    style={{ backgroundColor: shuttle.color }}
                                  />
                                )}
                              </div>
                            )}
                          </div>

                          {/* Stop info */}
                          <div className="flex-1 pt-0.5">
                            <div className="font-medium text-gray-900">
                              {stop.stop_name}
                            </div>
                            {isFirst && (
                              <div className="text-sm text-gray-500">
                                Shuttle is here now
                              </div>
                            )}
                            {isOrigin && !isFirst && (
                              <div
                                className="text-sm"
                                style={{ color: shuttle.color }}
                              >
                                Your location
                              </div>
                            )}
                          </div>

                          {/* Time */}
                          <div className="pt-0.5 text-right">
                            {stop.predicted_arrival ? (
                              isDelayed ? (
                                <div className="flex flex-col items-end gap-0.5">
                                  {stop.scheduled_arrival && (
                                    <div className="text-xs text-gray-400 line-through">
                                      {stop.scheduled_arrival.slice(0, 5)}
                                    </div>
                                  )}
                                  <div className="flex items-center gap-1 text-sm font-medium text-red-600">
                                    <Clock className="h-4 w-4" />
                                    <span>
                                      {formatTime(stop.predicted_arrival)}
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <div
                                  className="flex items-center gap-1 text-sm font-medium"
                                  style={{
                                    color: isFirst ? shuttle.color : "#6B7280",
                                  }}
                                >
                                  <Clock className="h-4 w-4" />
                                  <span>
                                    {formatTime(stop.predicted_arrival)}
                                  </span>
                                </div>
                              )
                            ) : stop.scheduled_arrival ? (
                              <div className="flex items-center gap-1 text-sm font-medium text-gray-500">
                                <Clock className="h-4 w-4" />
                                <span>{stop.scheduled_arrival.slice(0, 5)}</span>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}

          {/* Board button */}
          <button
            onClick={handleBoardShuttle}
            className="w-full cursor-pointer rounded-2xl py-4 font-medium text-white shadow-lg transition-all hover:shadow-xl"
            style={{ backgroundColor: shuttle.color }}
          >
            I'm on this shuttle
          </button>

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
