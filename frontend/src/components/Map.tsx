import { useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

// Harvard campus center
const HARVARD_CENTER: [number, number] = [-71.1167, 42.377];
const DEFAULT_ZOOM = 14.5;

interface MapProps {
  children?: (map: mapboxgl.Map) => React.ReactNode;
  onMapReady?: (map: mapboxgl.Map) => void;
  className?: string;
}

export function Map({ children, onMapReady, className = "" }: MapProps) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [map, setMap] = useState<mapboxgl.Map | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Store onMapReady in a ref so the callback ref doesn't need to depend on it
  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;

  const containerCallbackRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || mapRef.current) return;

      // Check WebGL support before trying to create the map
      const canvas = document.createElement("canvas");
      const gl =
        canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) {
        setError(
          "WebGL is not enabled. Please enable hardware acceleration in your browser settings and restart."
        );
        return;
      }

      try {
        const m = new mapboxgl.Map({
          container: node,
          style: "mapbox://styles/mapbox/light-v11",
          center: HARVARD_CENTER,
          zoom: DEFAULT_ZOOM,
          attributionControl: false,
        });

        mapRef.current = m;

        m.on("load", () => {
          setMap(m);
          onMapReadyRef.current?.(m);
        });
      } catch (e) {
        setError(
          `Map failed to load: ${e instanceof Error ? e.message : "Unknown error"}`
        );
      }
    },
    []
  );

  if (error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-gray-100 p-8 text-center">
        <div className="mb-4 text-4xl">🗺️</div>
        <h2 className="mb-2 text-lg font-semibold text-gray-800">
          Map Unavailable
        </h2>
        <p className="max-w-sm text-sm text-gray-600">{error}</p>
        <p className="mt-3 text-xs text-gray-400">
          Chrome: chrome://settings/system → enable hardware acceleration
        </p>
      </div>
    );
  }

  return (
    <div ref={containerCallbackRef} className={`w-full h-full ${className}`}>
      {map && children?.(map)}
    </div>
  );
}
