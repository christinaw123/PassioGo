import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";

interface VehicleMarkerProps {
  map: mapboxgl.Map;
  lng: number;
  lat: number;
  color: string;
  bearing?: number | null;
  pulsing?: boolean;
}

export function VehicleMarker({
  map,
  lng,
  lat,
  color,
  bearing,
  pulsing,
}: VehicleMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  // Track the position the animation is currently at (for lerp start point).
  const animPosRef = useRef<[number, number]>([lng, lat]);
  const animFrameRef = useRef<number | null>(null);

  // ── Effect 1: create marker once, recreate only if color or pulsing changes ──
  useEffect(() => {
    const size = 36;
    const arrowSize = 10;
    const rotation = bearing ?? 0;

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "position:relative;display:flex;align-items:center;justify-content:center;";

    if (pulsing) {
      const styleId = "vehicle-pulse-keyframes";
      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          @keyframes vehicle-pulse {
            0%   { transform: scale(1);   opacity: 0.7; }
            100% { transform: scale(2.4); opacity: 0; }
          }
        `;
        document.head.appendChild(style);
      }
      const ring = document.createElement("div");
      ring.style.cssText = `
        position:absolute;
        width:${size + arrowSize * 2}px;height:${size + arrowSize * 2}px;
        border-radius:50%;border:3px solid ${color};
        animation:vehicle-pulse 1.4s ease-out infinite;pointer-events:none;
      `;
      wrapper.appendChild(ring);
    }

    const el = document.createElement("div");
    el.dataset.vehicleIcon = "true";
    el.style.cssText = `width:${size + arrowSize * 2}px;height:${size + arrowSize * 2}px;position:relative;`;
    el.innerHTML = `
      <svg width="${size + arrowSize * 2}" height="${size + arrowSize * 2}" viewBox="0 0 ${size + arrowSize * 2} ${size + arrowSize * 2}" style="transform:rotate(${rotation}deg);filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">
        <polygon points="${size / 2 + arrowSize},2 ${size / 2 + arrowSize - 7},${arrowSize + 2} ${size / 2 + arrowSize + 7},${arrowSize + 2}" fill="${color}"/>
        <circle cx="${size / 2 + arrowSize}" cy="${size / 2 + arrowSize}" r="${size / 2}" fill="${color}" stroke="white" stroke-width="3"/>
        <g transform="translate(${size / 2 + arrowSize - 8}, ${size / 2 + arrowSize - 8}) rotate(${-rotation}, 8, 8)">
          <rect x="2" y="1" width="12" height="14" rx="2" fill="none" stroke="white" stroke-width="1.5"/>
          <rect x="4" y="3" width="8" height="5" rx="1" fill="white" opacity="0.9"/>
          <circle cx="5" cy="13" r="1.2" fill="white"/>
          <circle cx="11" cy="13" r="1.2" fill="white"/>
        </g>
      </svg>
    `;
    wrapper.appendChild(el);

    const marker = new mapboxgl.Marker({ element: wrapper, anchor: "center" })
      .setLngLat(animPosRef.current)
      .addTo(map);

    markerRef.current = marker;

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      marker.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, color, pulsing]);

  // ── Effect 2: smoothly animate to new GPS position ──
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;

    const [fromLng, fromLat] = animPosRef.current;
    const toLng = lng;
    const toLat = lat;

    // Skip animation for sub-metre jitter
    const dx = (toLng - fromLng) * 111320 * Math.cos(fromLat * Math.PI / 180);
    const dy = (toLat - fromLat) * 110540;
    if (dx * dx + dy * dy < 1) {
      animPosRef.current = [toLng, toLat];
      return;
    }

    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    const startTime = performance.now();
    // Animate over 4 s to bridge the 5-second polling gap smoothly.
    const DURATION = 4000;

    function step(now: number) {
      const t = Math.min((now - startTime) / DURATION, 1);
      // Ease-out cubic so movement decelerates into the new position.
      const eased = 1 - Math.pow(1 - t, 3);
      const curLng = fromLng + (toLng - fromLng) * eased;
      const curLat = fromLat + (toLat - fromLat) * eased;
      animPosRef.current = [curLng, curLat];
      marker.setLngLat([curLng, curLat]);
      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        animFrameRef.current = null;
      }
    }

    animFrameRef.current = requestAnimationFrame(step);
  }, [lng, lat]);

  // ── Effect 3: update bearing without rebuilding the marker ──
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const el = marker.getElement();
    const iconDiv = el.querySelector<HTMLElement>("[data-vehicle-icon]");
    if (!iconDiv) return;
    const svg = iconDiv.querySelector("svg");
    if (!svg) return;
    const rotation = bearing ?? 0;
    svg.style.transform = `rotate(${rotation}deg)`;
    const g = svg.querySelector("g");
    if (g) {
      const size = 36, arrowSize = 10;
      g.setAttribute(
        "transform",
        `translate(${size / 2 + arrowSize - 8}, ${size / 2 + arrowSize - 8}) rotate(${-rotation}, 8, 8)`
      );
    }
  }, [bearing]);

  return null;
}
