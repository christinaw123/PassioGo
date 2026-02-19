/** Haversine distance between two [lng, lat] points in meters */
export function haversineDistance(
  a: [number, number],
  b: [number, number]
): number {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  return (
    2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2))
  );
}

/** Project point P onto segment A–B, clamp parameter t to [0,1] */
function projectOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): { point: [number, number]; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return { point: [a[0], a[1]], t: 0 };
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))
  );
  return { point: [a[0] + t * dx, a[1] + t * dy], t };
}

/** Find the nearest point on a polyline to a given point */
export function nearestPointOnLine(
  line: [number, number][],
  point: [number, number]
): { segIndex: number; projPoint: [number, number]; dist: number; t: number } {
  let bestDist = Infinity;
  let bestSeg = 0;
  let bestPoint: [number, number] = line[0];
  let bestT = 0;

  for (let i = 0; i < line.length - 1; i++) {
    const { point: proj, t } = projectOnSegment(point, line[i], line[i + 1]);
    const d = haversineDistance(point, proj);
    if (d < bestDist) {
      bestDist = d;
      bestSeg = i;
      bestPoint = proj;
      bestT = t;
    }
  }

  return { segIndex: bestSeg, projPoint: bestPoint, dist: bestDist, t: bestT };
}

/** Extract sub-polyline between two projected points on a polyline */
export function clipLineSegment(
  line: [number, number][],
  fromIdx: number,
  fromPoint: [number, number],
  toIdx: number,
  toPoint: [number, number]
): [number, number][] {
  if (fromIdx > toIdx) return [];
  const result: [number, number][] = [fromPoint];
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    result.push(line[i]);
  }
  result.push(toPoint);
  return result;
}

/** Total length of a polyline in meters */
export function lineLength(coords: [number, number][]): number {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    total += haversineDistance(coords[i], coords[i + 1]);
  }
  return total;
}
