import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";

interface VehicleMarkerProps {
  map: mapboxgl.Map;
  lng: number;
  lat: number;
  color: string;
  bearing?: number | null;
}

export function VehicleMarker({
  map,
  lng,
  lat,
  color,
  bearing,
}: VehicleMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    const size = 36;
    const arrowSize = 10;
    // Bearing determines arrow direction; default to 0 (north)
    const rotation = bearing ?? 0;

    const el = document.createElement("div");
    el.style.cssText = `width:${size + arrowSize * 2}px;height:${size + arrowSize * 2}px;position:relative;`;

    // SVG with circle + blended arrow + bus icon
    el.innerHTML = `
      <svg width="${size + arrowSize * 2}" height="${size + arrowSize * 2}" viewBox="0 0 ${size + arrowSize * 2} ${size + arrowSize * 2}" style="transform:rotate(${rotation}deg);filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">
        <!-- Arrow pointing in bearing direction -->
        <polygon
          points="${size / 2 + arrowSize},2 ${size / 2 + arrowSize - 7},${arrowSize + 2} ${size / 2 + arrowSize + 7},${arrowSize + 2}"
          fill="${color}"
        />
        <!-- Main circle -->
        <circle
          cx="${size / 2 + arrowSize}"
          cy="${size / 2 + arrowSize}"
          r="${size / 2}"
          fill="${color}"
          stroke="white"
          stroke-width="3"
        />
        <!-- Bus/shuttle icon (counter-rotate so it stays upright) -->
        <g transform="translate(${size / 2 + arrowSize - 8}, ${size / 2 + arrowSize - 8}) rotate(${-rotation}, 8, 8)">
          <rect x="2" y="1" width="12" height="14" rx="2" fill="none" stroke="white" stroke-width="1.5"/>
          <rect x="4" y="3" width="8" height="5" rx="1" fill="white" opacity="0.9"/>
          <circle cx="5" cy="13" r="1.2" fill="white"/>
          <circle cx="11" cy="13" r="1.2" fill="white"/>
        </g>
      </svg>
    `;

    const marker = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);

    markerRef.current = marker;

    return () => {
      marker.remove();
    };
  }, [map, lng, lat, color, bearing]);

  return null;
}
