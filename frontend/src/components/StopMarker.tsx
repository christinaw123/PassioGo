import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";

interface StopMarkerProps {
  map: mapboxgl.Map;
  lng: number;
  lat: number;
  type?: "default" | "origin" | "destination";
  interactive?: boolean;
  onClick?: () => void;
  name?: string;
}

export function StopMarker({
  map,
  lng,
  lat,
  type = "default",
  interactive = true,
  onClick,
  name,
}: StopMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    // Outer wrapper — Mapbox controls its `transform` for positioning.
    // Never override transform on this element.
    const el = document.createElement("div");
    el.className = "stop-marker";

    if (type === "origin") {
      el.style.cssText = "width:28px;height:28px;";
      el.innerHTML = `<div style="
        width:100%;height:100%;
        background:#2196F3;border:3px solid white;
        border-radius:50%;cursor:pointer;
        box-shadow:0 2px 8px rgba(33,150,243,0.4);
      "></div>`;
    } else if (type === "destination") {
      el.style.cssText = "width:28px;height:28px;";
      el.innerHTML = `<div style="
        width:100%;height:100%;
        background:#4CAF50;border:3px solid white;
        border-radius:50%;cursor:pointer;
        box-shadow:0 2px 8px rgba(76,175,80,0.4);
      "></div>`;
    } else {
      el.style.cssText = "width:20px;height:20px;display:flex;align-items:center;justify-content:center;";
      const dot = document.createElement("div");
      dot.style.cssText = `
        width:12px;height:12px;
        background:${interactive ? "#2196F3" : "#CCCCCC"};
        border:2px solid white;
        border-radius:50%;
        cursor:${interactive ? "pointer" : "default"};
        box-shadow:0 1px 4px rgba(0,0,0,0.2);
        transition:transform 0.15s ease;
      `;
      if (interactive) {
        dot.addEventListener("mouseenter", () => {
          dot.style.transform = "scale(1.5)";
        });
        dot.addEventListener("mouseleave", () => {
          dot.style.transform = "scale(1)";
        });
      }
      el.appendChild(dot);
    }

    if (interactive && onClick) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
    }

    const marker = new mapboxgl.Marker({ element: el })
      .setLngLat([lng, lat])
      .addTo(map);

    if ((type === "origin" || type === "destination") && name) {
      const popup = new mapboxgl.Popup({
        offset: 20,
        closeButton: false,
        closeOnClick: false,
        className: "stop-label-popup",
      }).setText(name);
      marker.setPopup(popup).togglePopup();
    }

    markerRef.current = marker;

    return () => {
      marker.remove();
    };
  }, [map, lng, lat, type, interactive, onClick, name]);

  return null;
}
