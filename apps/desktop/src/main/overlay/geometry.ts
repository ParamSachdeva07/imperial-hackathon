/**
 * Pure rect/point math in global DIP. No Electron imports.
 * STUB (Phase 0): implemented by the logic track.
 */
import type { Point, Rect } from "@pointy/shared/overlay";

const todo = (name: string): never => {
  throw new Error(`not implemented: geometry.${name}`);
};

export const rightOf = (r: Rect): number => r.x + r.width;
export const bottomOf = (r: Rect): number => r.y + r.height;

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** True when a and b overlap with positive area (touching edges do not count). */
export function intersects(_a: Rect, _b: Rect): boolean {
  return todo("intersects");
}

/** Overlapping area of a and b, or null when they don't overlap with positive area. */
export function intersection(_a: Rect, _b: Rect): Rect | null {
  return todo("intersection");
}

/** True when `inner` lies entirely inside `outer` (edges may touch). */
export function containsRect(_outer: Rect, _inner: Rect): boolean {
  return todo("containsRect");
}

/** True when p lies inside r (edges inclusive). */
export function containsPoint(_r: Rect, _p: Point): boolean {
  return todo("containsPoint");
}

/** Grow (or shrink, with negative values) a rect on every side. */
export function inflate(_r: Rect, _dx: number, _dy?: number): Rect {
  return todo("inflate");
}

export function union(_a: Rect, _b: Rect): Rect {
  return todo("union");
}

export function translate(_r: Rect, _dx: number, _dy: number): Rect {
  return todo("translate");
}

/** Bounding rect of a set of points; at least 1×1 so it remains a valid Rect. */
export function boundsOfPoints(_points: Point[]): Rect {
  return todo("boundsOfPoints");
}

/** The point on (or inside) r closest to p. Returns p itself when p is inside r. */
export function nearestPointOnRect(_r: Rect, _p: Point): Point {
  return todo("nearestPointOnRect");
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Rects equal within `eps` DIP on every edge. */
export function rectsEqual(_a: Rect, _b: Rect, _eps = 0.5): boolean {
  return todo("rectsEqual");
}
