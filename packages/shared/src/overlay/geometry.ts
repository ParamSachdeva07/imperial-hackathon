/**
 * Pure rect/point math in global DIP, shared by the main process, the renderer and the tools.
 * One copy, so edge rules can't drift between layout (main) and drawing (renderer).
 */
import type { Point, Rect } from "./schemas";

export const rightOf = (r: Rect): number => r.x + r.width;
export const bottomOf = (r: Rect): number => r.y + r.height;

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** True when a and b overlap with positive area (touching edges do not count). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < rightOf(b) && b.x < rightOf(a) && a.y < bottomOf(b) && b.y < bottomOf(a);
}

/** Overlapping area of a and b, or null when they don't overlap with positive area. */
export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(rightOf(a), rightOf(b));
  const bottom = Math.min(bottomOf(a), bottomOf(b));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** True when `inner` lies entirely inside `outer` (edges may touch). */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    rightOf(inner) <= rightOf(outer) &&
    bottomOf(inner) <= bottomOf(outer)
  );
}

/** True when p lies inside r (edges inclusive). */
export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= rightOf(r) && p.y >= r.y && p.y <= bottomOf(r);
}

/** Grow (or shrink, with negative values) a rect on every side. */
export function inflate(r: Rect, dx: number, dy: number = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, width: r.width + 2 * dx, height: r.height + 2 * dy };
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(rightOf(a), rightOf(b)) - x,
    height: Math.max(bottomOf(a), bottomOf(b)) - y,
  };
}

export function translate(r: Rect, dx: number, dy: number): Rect {
  return { ...r, x: r.x + dx, y: r.y + dy };
}

/** Bounding rect of a set of points; at least 1×1 so it remains a valid Rect. */
export function boundsOfPoints(points: Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(1, Math.max(...xs) - x),
    height: Math.max(1, Math.max(...ys) - y),
  };
}

/** The point on (or inside) r closest to p. Returns p itself when p is inside r. */
export function nearestPointOnRect(r: Rect, p: Point): Point {
  return {
    x: Math.min(Math.max(p.x, r.x), rightOf(r)),
    y: Math.min(Math.max(p.y, r.y), bottomOf(r)),
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Rects equal within `eps` DIP on every edge. */
export function rectsEqual(a: Rect, b: Rect, eps = 0.5): boolean {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(rightOf(a) - rightOf(b)) <= eps &&
    Math.abs(bottomOf(a) - bottomOf(b)) <= eps
  );
}

/** Clamp v into [lo, hi]; when the range is empty (hi < lo) the result is lo. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** p inside r with left/top inclusive and right/bottom exclusive (adjacent displays never both match). */
export function containsPointHalfOpen(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < rightOf(r) && p.y >= r.y && p.y < bottomOf(r);
}

/** Parse "x,y,w,h" (e.g. an env var or CLI flag) into a Rect; null if malformed or empty. */
export function parseRect(text: string): Rect | null {
  const parts = text.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = parts as [number, number, number, number];
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
