/**
 * Pure state for the gesture feedback layer: no React, no timers, no globals. `now` is passed in
 * (the layer stamps it with performance.now() when a batch arrives).
 *
 * Rules:
 *  - Nothing is recorded while the session is inactive; closing the session clears everything
 *    except flashes already in flight (they finish their short fade).
 *  - The draw hand and the mouse hand are independent (two hands can be active at once): each has
 *    its own cursor. The trail only grows with draw cursor updates; a draw loss, a selection or
 *    session-off clear it. Mouse cursor updates never touch the trail.
 *  - Trail points expire after `trailMs`, flashes after `flashMs`.
 */
import type { GestureFeedback } from "@pointy/shared/overlay/render";
import type { Point, Rect } from "@pointy/shared/overlay/schemas";
import { theme } from "@pointy/shared/overlay/theme";

export interface GestureConfig {
  trailMs: number;
  trailMaxPoints: number;
  flashMs: number;
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  trailMs: theme.gesture.trailMs,
  trailMaxPoints: theme.gesture.trailMaxPoints,
  flashMs: theme.gesture.flashMs,
};

export interface TrailPoint extends Point {
  /** Arrival time (ms, performance.now clock). */
  t: number;
}

export type Flash =
  | { id: number; kind: "click"; at: Point; born: number }
  | { id: number; kind: "point"; at: Point; born: number }
  | { id: number; kind: "region"; points: Point[]; bounds: Rect; born: number };

export interface ProgressState {
  at: Point;
  value: number;
  progressKind: "dwell" | "click";
}

export interface GestureState {
  session: boolean;
  /** Draw/pointing hand cursor. */
  cursor: { at: Point; mode: "draw" } | null;
  /** System-mouse hand cursor. */
  mouseCursor: { at: Point } | null;
  /** Draw-hand dwell ring. */
  drawProgress: ProgressState | null;
  /** Mouse-hand dwell-click ring. Independent of the draw ring. */
  mouseProgress: ProgressState | null;
  /** True while a draw stroke is in progress (trail accumulates). */
  stroke: boolean;
  trail: TrailPoint[];
  flashes: Flash[];
  scrolling: boolean;
  nextFlashId: number;
}

export const initialGestureState: GestureState = {
  session: false,
  cursor: null,
  mouseCursor: null,
  drawProgress: null,
  mouseProgress: null,
  stroke: false,
  trail: [],
  flashes: [],
  scrolling: false,
  nextFlashId: 1,
};

export function applyGestureEvents(
  state: GestureState,
  events: readonly GestureFeedback[],
  now: number,
  cfg: GestureConfig = DEFAULT_GESTURE_CONFIG,
): GestureState {
  let s = state;
  for (const e of events) s = applyOne(s, e, now, cfg);
  return s;
}

function applyOne(s: GestureState, e: GestureFeedback, now: number, cfg: GestureConfig): GestureState {
  if (e.kind === "session") {
    if (e.active) return s.session ? s : { ...s, session: true };
    return { ...s, session: false, cursor: null, mouseCursor: null, drawProgress: null, mouseProgress: null, stroke: false, trail: [], scrolling: false };
  }
  if (!s.session) return s;
  switch (e.kind) {
    case "cursor": {
      if (e.mode === "mouse") return { ...s, mouseCursor: { at: e.at } };
      const last = s.trail[s.trail.length - 1];
      const same = last !== undefined && last.x === e.at.x && last.y === e.at.y;
      const trail = same ? s.trail : [...s.trail, { x: e.at.x, y: e.at.y, t: now }].slice(-cfg.trailMaxPoints);
      return { ...s, cursor: { at: e.at, mode: "draw" }, stroke: true, trail };
    }
    case "progress": {
      const p = e.value > 0 ? { at: e.at, value: Math.min(1, e.value), progressKind: e.progressKind } : null;
      // dwell belongs to the draw hand, click to the mouse hand.
      return e.progressKind === "click" ? { ...s, mouseProgress: p } : { ...s, drawProgress: p };
    }
    case "lost":
      if (e.mode === "mouse") return { ...s, mouseCursor: null, mouseProgress: null };
      if (e.mode === "draw") return { ...s, cursor: null, drawProgress: null, stroke: false, trail: [] };
      return { ...s, cursor: null, mouseCursor: null, drawProgress: null, mouseProgress: null, stroke: false, trail: [] };
    case "click":
      return { ...s, mouseProgress: null, ...addFlash(s, { kind: "click", at: e.at, born: now }) };
    case "selected_point":
      return { ...s, drawProgress: null, stroke: false, trail: [], ...addFlash(s, { kind: "point", at: e.at, born: now }) };
    case "selected_region":
      return { ...s, drawProgress: null, stroke: false, trail: [], ...addFlash(s, { kind: "region", points: e.points, bounds: e.bounds, born: now }) };
    case "scroll":
      return { ...s, scrolling: e.phase !== "end" };
  }
}

type FlashInput = { kind: "click" | "point"; at: Point; born: number } | { kind: "region"; points: Point[]; bounds: Rect; born: number };

function addFlash(s: GestureState, f: FlashInput): Pick<GestureState, "flashes" | "nextFlashId"> {
  const flash = { ...f, id: s.nextFlashId } as Flash;
  return { flashes: [...s.flashes, flash], nextFlashId: s.nextFlashId + 1 };
}

/** Drops expired trail points and flashes. Returns the same object when nothing expired. */
export function pruneGesture(state: GestureState, now: number, cfg: GestureConfig = DEFAULT_GESTURE_CONFIG): GestureState {
  const trail = state.trail.filter((p) => now - p.t < cfg.trailMs);
  const flashes = state.flashes.filter((f) => now - f.born < cfg.flashMs);
  if (trail.length === state.trail.length && flashes.length === state.flashes.length) return state;
  return { ...state, trail, flashes };
}

/** True while something time-based is on screen (the layer runs its rAF loop only then). */
export function isGestureAnimating(state: GestureState): boolean {
  return state.trail.length > 0 || state.flashes.length > 0;
}
