/**
 * Pure generators for `pointy-draw gesture ...`: real GestureEvent shapes (display-relative DIP,
 * numeric displayId; see packages/gestures/src/events.ts) at about 30 fps. No imports from the
 * gestures package on purpose, so the CLI stays dependency-light; the dev server validates them.
 */
export const FRAME_MS = 33;

export interface Pt {
  x: number;
  y: number;
}

export type SimGestureEvent = Record<string, unknown> & { type: string };

const HAND = "Right";
const round = (n: number) => Math.round(n * 10) / 10;

const cursor = (p: Pt, displayId: number, t: number): SimGestureEvent => ({ type: "cursor_moved", hand: HAND, x: round(p.x), y: round(p.y), displayId, t });
const dwell = (p: Pt, displayId: number, t: number, progress: number): SimGestureEvent => ({
  type: "dwell_progress",
  hand: HAND,
  progress: Math.min(1, Math.max(0, round(progress * 1000) / 1000)),
  x: round(p.x),
  y: round(p.y),
  displayId,
  t,
});

const frames = (ms: number) => Math.max(2, Math.round(ms / FRAME_MS));

/** Cursor around a circle (one revolution over ~70% of `ms`), then a dwell ramp, then region_selected. */
export function circleEvents(center: Pt, radius: number, displayId: number, ms = 1500): SimGestureEvent[] {
  const total = frames(ms);
  const nCircle = Math.max(8, Math.round(total * 0.7));
  const nDwell = Math.max(3, total - nCircle);
  const at = (a: number): Pt => ({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  const out: SimGestureEvent[] = [];
  let t = 0;
  const polygon: [number, number][] = [];
  for (let i = 0; i <= nCircle; i++) {
    const p = at(-Math.PI / 2 + (2 * Math.PI * i) / nCircle);
    out.push(cursor(p, displayId, t));
    t += FRAME_MS;
    if (i < nCircle && i % Math.max(1, Math.floor(nCircle / 24)) === 0) polygon.push([round(p.x), round(p.y)]);
  }
  const end = at(-Math.PI / 2);
  for (let i = 1; i <= nDwell; i++) {
    out.push(dwell(end, displayId, t, i / nDwell));
    t += FRAME_MS;
  }
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  out.push({ type: "region_selected", hand: HAND, polygon, bbox: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, displayId, t });
  return out;
}

/** Cursor, a dwell_progress ramp 0 to 1, then point_selected. */
export function dwellEvents(p: Pt, displayId: number, ms = 800): SimGestureEvent[] {
  const n = frames(ms);
  const out: SimGestureEvent[] = [];
  let t = 0;
  for (let i = 0; i < 3; i++, t += FRAME_MS) out.push(cursor(p, displayId, t));
  for (let i = 0; i <= n; i++, t += FRAME_MS) out.push(dwell(p, displayId, t, i / n));
  out.push({ type: "point_selected", hand: HAND, x: round(p.x), y: round(p.y), displayId, heldForMs: ms, t });
  return out;
}

/** Cursor plus an immediate point_selected. */
export function pointEvents(p: Pt, displayId: number): SimGestureEvent[] {
  return [cursor(p, displayId, 0), { type: "point_selected", hand: HAND, x: round(p.x), y: round(p.y), displayId, heldForMs: 0, t: FRAME_MS }];
}

export function lostEvents(): SimGestureEvent[] {
  return [{ type: "hand_lost", hand: HAND, reason: "absent", t: 0 }];
}
