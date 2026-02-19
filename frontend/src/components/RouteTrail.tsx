import { useEffect } from "react";
import type { Map as MapboxMap, GeoJSONSource } from "mapbox-gl";

interface RouteTrailProps {
  map: MapboxMap;
  id: string;
  coordinates: [number, number][];
  color: string;
  isSelected: boolean;
}

export function RouteTrail({
  map,
  id,
  coordinates,
  color,
  isSelected,
}: RouteTrailProps) {
  const sourceId = `trail-src-${id}`;
  const layerId = `trail-lyr-${id}`;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      } catch {
        /* map may already be removed */
      }
    };
  }, [map, sourceId, layerId]);

  // Create or update source + layer
  useEffect(() => {
    if (coordinates.length < 2) return;

    const data: GeoJSON.Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates },
    };

    const src = map.getSource(sourceId);
    if (src) {
      (src as GeoJSONSource).setData(data);
    } else {
      map.addSource(sourceId, { type: "geojson", data });
    }

    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, "line-color", color);
      map.setPaintProperty(layerId, "line-width", isSelected ? 5 : 3);
      map.setPaintProperty(layerId, "line-opacity", isSelected ? 0.85 : 0.3);
    } else {
      map.addLayer({
        id: layerId,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": color,
          "line-width": isSelected ? 5 : 3,
          "line-opacity": isSelected ? 0.85 : 0.3,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
    }
  }, [map, coordinates, color, isSelected, sourceId, layerId]);

  return null;
}
