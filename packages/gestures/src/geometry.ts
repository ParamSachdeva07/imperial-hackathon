import type { Bbox } from "./events";
import { at } from "./util";

export type Vec2 = [number, number];

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Absolute polygon area (shoelace formula). */
export function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = at(poly, i);
    const [x2, y2] = at(poly, (i + 1) % poly.length);
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function bbox(poly: Vec2[]): Bbox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function pointSegmentDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

/** Ramer-Douglas-Peucker polyline simplification (iterative). */
export function simplify(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSegmentDist(at(points, i), at(points, s), at(points, e));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, no repeated end point. */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(at(lower, lower.length - 2), at(lower, lower.length - 1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = at(pts, i);
    while (upper.length >= 2 && cross(at(upper, upper.length - 2), at(upper, upper.length - 1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export interface LoopParams {
  minLoopLength: number;
  closeFrac: number;
  closeMinDist: number;
  minLoopArea: number;
  minCompactness: number;
}

/**
 * Looks for a closed loop ending at the last point of `path`.
 * Returns the loop's points (earliest closing start), or null.
 */
export function findClosedLoop(path: Vec2[], p: LoopParams): Vec2[] | null {
  const n = path.length;
  if (n < 8) return null;

  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = at(cum, i - 1) + dist(at(path, i - 1), at(path, i));

  const end = at(path, n - 1);
  for (let k = 0; k < n - 7; k++) {
    const arc = at(cum, n - 1) - at(cum, k);
    if (arc < p.minLoopLength) break; // arc only shrinks as k grows
    const closeTol = Math.max(p.closeMinDist, p.closeFrac * arc);
    if (dist(end, at(path, k)) > closeTol) continue;

    const loop = path.slice(k);
    const area = polygonArea(loop);
    if (area < p.minLoopArea) continue;
    const compactness = (4 * Math.PI * area) / (arc * arc);
    if (compactness < p.minCompactness) continue;
    return loop;
  }
  return null;
}
