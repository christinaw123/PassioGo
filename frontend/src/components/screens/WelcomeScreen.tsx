import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router";
import { Map } from "../Map";
import { StopMarker } from "../StopMarker";
import { Navigation, MapPin, Locate, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import mapboxgl from "mapbox-gl";

// ─── Layout knobs — tweak these to adjust card appearance ───────────────────
/** Horizontal padding from phone edges to each card, in px */
const CARD_SIDE_PADDING = 16;       // try: 32  48  64  80  96  128
/** Bottom padding so cards clear the home indicator, in px */
const CARD_BOTTOM_PADDING = 24;     // try: 40  56  64  80  96
/** Vertical gap between the two cards, in px */
const CARD_GAP = 6;                 // try: 4   8   12  16  24
/** Internal padding inside each card, in px (all sides) */
const CARD_PADDING = 16;            // try: 12  16  20  24
/** Card corner radius, in px */
const CARD_RADIUS = 16;             // try: 12  16  20  24

/** "Tap a stop on the map" pill — horizontal padding, in px */
const PILL_PADDING_X = 12;          // try: 8   10  12  16
/** "Tap a stop on the map" pill — vertical padding, in px */
const PILL_PADDING_Y = 4;           // try: 2   4   6   8
/** "Tap a stop on the map" pill corner radius, in px */
const PILL_RADIUS = 32;            // try: 4   8   12  16  999 (full pill)
// ─────────────────────────────────────────────────────────────────────────────

interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export function WelcomeScreen() {
  const navigate = useNavigate();
  const location = useLocation();

  const {
    origin: stateOrigin,
    destination: stateDestination,
    returningFrom,
  } = location.state || {};

  const [stops, setStops] = useState<Stop[]>([]);
  const [origin, setOrigin] = useState<string>(stateOrigin || "");
  const [destination, setDestination] = useState<string>(stateDestination || "");
  const [selectionMode, setSelectionMode] = useState<"origin" | "destination">(
    () => {
      if (returningFrom === "shuttle-selection") {
        if (stateOrigin && !stateDestination) return "destination";
        if (stateDestination && !stateOrigin) return "origin";
      }
      return "origin";
    }
  );
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);
  const [userLocation, setUserLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const hasAutoZoomedRef = useRef(false);
  const [showUnreachablePopup, setShowUnreachablePopup] = useState(false);
  const [unreachableStopName, setUnreachableStopName] = useState("");
  const [reachableStopIds, setReachableStopIds] = useState<Set<string>>(
    new Set()
  );

  // Clear any stale sessionStorage values left by old code
  useEffect(() => {
    sessionStorage.removeItem("shuttle_origin");
    sessionStorage.removeItem("shuttle_destination");
  }, []);

  // Watch user location continuously — cleans up on unmount so re-mounts start fresh
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        setUserLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        }),
      () => { /* permission denied or unavailable */ },
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Fly to user location once — fires as soon as both map and location are ready
  useEffect(() => {
    if (!mapInstance || !userLocation || hasAutoZoomedRef.current) return;
    hasAutoZoomedRef.current = true;
    mapInstance.flyTo({
      center: [userLocation.lng, userLocation.lat],
      zoom: 15.5,
    });
  }, [mapInstance, userLocation]);

  // Fetch all stops from backend
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/all-stops", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => setStops(data.stops || []))
      .catch((e) => {
        if (e.name !== "AbortError") console.error("Failed to load stops:", e);
      });
    return () => controller.abort();
  }, []);

  // When origin is selected, fetch which destinations are reachable
  useEffect(() => {
    if (!origin || selectionMode !== "destination") {
      setReachableStopIds(new Set());
      return;
    }

    const controller = new AbortController();

    const checkReachability = async () => {
      const reachable = new Set<string>();
      const promises = stops
        .filter((s) => s.name !== origin)
        .map(async (stop) => {
          try {
            const res = await fetch(
              `/api/routes-between?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(stop.name)}`,
              { signal: controller.signal }
            );
            if (!res.ok) return;
            const data = await res.json();
            if (data.routes && data.routes.length > 0) {
              reachable.add(stop.id);
            }
          } catch {
            // skip unreachable or aborted
          }
        });
      await Promise.all(promises);
      if (!controller.signal.aborted) {
        setReachableStopIds(reachable);
      }
    };

    checkReachability();
    return () => controller.abort();
  }, [origin, selectionMode, stops]);

  const handleStopClick = useCallback(
    (stop: Stop) => {
      if (selectionMode === "origin") {
        setOrigin(stop.name);
        setSelectionMode("destination");
        // Zoom out to fit all stops so the user can pick a destination
        if (mapInstance && stops.length > 0) {
          const lngs = stops.map((s) => s.lon);
          const lats = stops.map((s) => s.lat);
          mapInstance.fitBounds(
            [
              [Math.min(...lngs), Math.min(...lats)],
              [Math.max(...lngs), Math.max(...lats)],
            ],
            { padding: { top: 60, bottom: 220, left: 40, right: 40 }, maxZoom: 14 }
          );
        }
      } else {
        if (stop.name === origin) return;

        if (reachableStopIds.size > 0 && !reachableStopIds.has(stop.id)) {
          setUnreachableStopName(stop.name);
          setShowUnreachablePopup(true);
          return;
        }

        setDestination(stop.name);
      }
    },
    [selectionMode, origin, reachableStopIds, mapInstance, stops]
  );

  // Locate button: fly to the position already tracked by watchPosition
  const handleCurrentLocationClick = () => {
    if (mapInstance && userLocation) {
      mapInstance.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: 15.5 });
    }
  };

  const handleOriginCardClick = () => {
    setSelectionMode("origin");
    if (origin) {
      setOrigin("");
      setDestination("");
    }
    // Zoom out to show all stops so the user can pick one
    if (mapInstance && stops.length > 0) {
      const lngs = stops.map((s) => s.lon);
      const lats = stops.map((s) => s.lat);
      mapInstance.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: { top: 60, bottom: 220, left: 40, right: 40 }, maxZoom: 14 }
      );
    }
  };

  const handleDestinationCardClick = () => {
    if (!origin) return;
    setSelectionMode("destination");
    if (destination) {
      setDestination("");
    }
  };

  const handleContinue = () => {
    if (origin && destination) {
      navigate("/shuttle-selection", { state: { origin, destination } });
    }
  };

  return (
    <div className="relative mx-auto h-full w-full max-w-107.5 overflow-hidden bg-white">
      {/* Full-screen Mapbox map */}
      <Map onMapReady={setMapInstance}>
        {(map) => (
          <>
            {/* User location blue dot — distinct from stop markers */}
            {userLocation && (
              <UserLocationDot
                map={map}
                lat={userLocation.lat}
                lng={userLocation.lng}
              />
            )}

            {/* Stop markers */}
            {stops.map((stop) => {
              const isOrigin = stop.name === origin;
              const isDestination = stop.name === destination;

              if (isOrigin) {
                return (
                  <StopMarker
                    key={stop.id}
                    map={map}
                    lng={stop.lon}
                    lat={stop.lat}
                    type="origin"
                    name={stop.name}
                  />
                );
              }

              if (isDestination) {
                return (
                  <StopMarker
                    key={stop.id}
                    map={map}
                    lng={stop.lon}
                    lat={stop.lat}
                    type="destination"
                    name={stop.name}
                  />
                );
              }

              const isReachable =
                selectionMode === "origin" ||
                reachableStopIds.size === 0 ||
                reachableStopIds.has(stop.id);

              return (
                <StopMarker
                  key={stop.id}
                  map={map}
                  lng={stop.lon}
                  lat={stop.lat}
                  interactive={isReachable}
                  onClick={() => handleStopClick(stop)}
                  name={stop.name}
                />
              );
            })}
          </>
        )}
      </Map>

      {/* Bottom section: locate button + input cards */}
      <div
        className="pointer-events-none absolute bottom-0 left-0 right-0"
        style={{ paddingLeft: CARD_SIDE_PADDING, paddingRight: CARD_SIDE_PADDING, paddingBottom: CARD_BOTTOM_PADDING }}
      >
        {/* Floating locate button — above the cards, right-aligned */}
        <div className="mb-3 flex justify-end">
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, type: "spring" }}
            onClick={handleCurrentLocationClick}
            className="pointer-events-auto flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-blue-500 shadow-lg transition-colors hover:bg-blue-600"
          >
            <Locate className="h-5 w-5 text-white" />
          </motion.button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: CARD_GAP }}>
          {/* Origin card */}
          <motion.button
            initial={{ y: 20, opacity: 0 }}
            animate={{
              y: 0,
              opacity: 1,
              scale: selectionMode === "origin" ? 1.02 : 1,
            }}
            transition={{ delay: 0.2 }}
            onClick={handleOriginCardClick}
            className="pointer-events-auto relative w-full cursor-pointer bg-white text-left shadow-lg transition-shadow hover:shadow-xl"
            style={{
              borderRadius: CARD_RADIUS,
              marginTop: selectionMode === "origin" && !origin ? 14 : 0,
              border: selectionMode === "origin" ? "2px solid #3b82f6" : "1px solid #f3f4f6",
            }}
          >
            {selectionMode === "origin" && !origin && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute -top-[14px] left-3 bg-blue-500 text-xs font-semibold text-white"
                style={{ borderRadius: PILL_RADIUS, paddingLeft: PILL_PADDING_X, paddingRight: PILL_PADDING_X, paddingTop: PILL_PADDING_Y, paddingBottom: PILL_PADDING_Y }}
              >
                Tap a stop on the map
              </motion.div>
            )}
            <div style={{ padding: CARD_PADDING }} className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-50">
                <Navigation className="h-5 w-5 text-blue-500" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] leading-tight text-gray-400">
                  Where do you want to get on?
                </div>
                <div className="mt-1 truncate text-[17px] font-semibold text-gray-900">
                  {origin || "Select your location"}
                </div>
              </div>
            </div>
          </motion.button>

          {/* Destination card */}
          <motion.button
            initial={{ y: 20, opacity: 0 }}
            animate={{
              y: 0,
              opacity: 1,
              scale: selectionMode === "destination" ? 1.02 : 1,
            }}
            transition={{ delay: 0.3 }}
            onClick={handleDestinationCardClick}
            className={`pointer-events-auto relative w-full bg-white text-left shadow-md transition-all ${
              origin ? "cursor-pointer hover:shadow-lg" : "cursor-not-allowed opacity-50"
            }`}
            style={{
              borderRadius: CARD_RADIUS,
              marginTop: selectionMode === "destination" && origin && !destination ? 14 : 0,
              border: selectionMode === "destination" ? "2px solid #22c55e" : "1px solid #f3f4f6",
            }}
            disabled={!origin}
          >
            {selectionMode === "destination" && origin && !destination && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute -top-[14px] left-3 bg-green-500 text-xs font-semibold text-white"
                style={{ borderRadius: PILL_RADIUS, paddingLeft: PILL_PADDING_X, paddingRight: PILL_PADDING_X, paddingTop: PILL_PADDING_Y, paddingBottom: PILL_PADDING_Y }}
              >
                Tap a stop on the map
              </motion.div>
            )}
            <div style={{ padding: CARD_PADDING }} className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-50">
                <MapPin className="h-5 w-5 text-green-500" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] leading-tight text-gray-400">
                  Where are you going?
                </div>
                <div className="mt-1 truncate text-[17px] font-semibold text-gray-900">
                  {destination || "Select your destination"}
                </div>
              </div>
            </div>
          </motion.button>

          {/* Continue button */}
          {origin && destination && (
            <motion.button
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              onClick={handleContinue}
              className="pointer-events-auto w-full rounded-2xl bg-blue-600 py-4 text-[16px] font-semibold text-white shadow-lg transition-colors hover:bg-blue-700"
            >
              Find Shuttles
            </motion.button>
          )}
        </div>
      </div>

      {/* Unreachable stop popup */}
      <AnimatePresence>
        {showUnreachablePopup && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
            onClick={() => setShowUnreachablePopup(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl"
            >
              <div className="mb-4 flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="mb-2 text-xl font-medium">No direct route</h3>
                  <p className="text-sm text-gray-600">
                    There's no shuttle running directly from{" "}
                    <span className="font-medium">{origin}</span> to{" "}
                    <span className="font-medium">{unreachableStopName}</span>.
                  </p>
                  <p className="mt-2 text-sm text-gray-600">
                    Please select a different destination or change your
                    starting point.
                  </p>
                </div>
                <button
                  onClick={() => setShowUnreachablePopup(false)}
                  className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-gray-100 transition-colors hover:bg-gray-200"
                >
                  <X className="h-5 w-5 text-gray-600" />
                </button>
              </div>
              <button
                onClick={() => setShowUnreachablePopup(false)}
                className="w-full cursor-pointer rounded-xl bg-blue-600 py-3 font-medium text-white transition-colors hover:bg-blue-700"
              >
                Got it
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// User location marker — navigation arrow icon with pulsing ring, distinct from stop dots
function UserLocationDot({
  map,
  lat,
  lng,
}: {
  map: mapboxgl.Map;
  lat: number;
  lng: number;
}) {
  useEffect(() => {
    const el = document.createElement("div");
    // Use flexbox centering so the pulse scale doesn't shift position
    el.style.cssText = `
      width:60px;height:60px;
      display:flex;align-items:center;justify-content:center;
    `;
    el.innerHTML = `
      <div style="
        position:absolute;
        width:56px;height:56px;
        background:rgba(66,133,244,0.12);
        border:2px solid rgba(66,133,244,0.25);
        border-radius:50%;
        animation:userlocpulse 2s ease-out infinite;
      "></div>
      <div style="
        position:relative;z-index:1;
        width:28px;height:28px;
        background:#4285F4;
        border-radius:50%;
        border:3px solid white;
        box-shadow:0 2px 8px rgba(66,133,244,0.5);
        display:flex;align-items:center;justify-content:center;
      ">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
        </svg>
      </div>
    `;

    const marker = new mapboxgl.Marker({ element: el })
      .setLngLat([lng, lat])
      .addTo(map);

    return () => {
      marker.remove();
    };
  }, [map, lat, lng]);

  return null;
}
