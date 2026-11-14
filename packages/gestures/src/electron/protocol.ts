/**
 * IPC contract between the hidden vision window (renderer) and the gesture service (main).
 * The renderer runs camera → MediaPipe → GestureInterpreter and sends GestureEvents up;
 * main sends commands down (session state, display, config).
 */
import type { GestureConfig } from "../config";
import type { DisplayInfo, GestureEvent, GestureEventType } from "../events";

export const GESTURE_IPC = {
  /** renderer → main: GestureEvent[] produced by one camera frame */
  events: "pointy-gestures:events",
  /** renderer → main: VisionStatus */
  status: "pointy-gestures:status",
  /** renderer → main: page loaded, ready for commands */
  ready: "pointy-gestures:ready",
  /** main → renderer: GestureCommand */
  command: "pointy-gestures:command",
  /** main → feedback overlay: FeedbackMessage */
  feedback: "pointy-gestures:feedback",
} as const;

/** Messages to the on-screen feedback overlay (cursor, trail, rings, selections). */
export type FeedbackMessage =
  | { type: "events"; events: GestureEvent[] }
  | { type: "session"; active: boolean }
  | { type: "clear" };

export type GestureCommand =
  | { type: "session"; active: boolean }
  | { type: "display"; display: DisplayInfo }
  | { type: "config"; config: Partial<GestureConfig> };

export type VisionStatus =
  | { type: "starting" }
  | { type: "running"; fps: number; hands: number }
  | { type: "error"; message: string };

// Record<…, true> makes the compiler flag any event type missing from this list.
const EVENT_TYPES: Record<GestureEventType, true> = {
  wake_requested: true,
  cursor_moved: true,
  dwell_progress: true,
  point_selected: true,
  region_selected: true,
  mouse: true,
  click_progress: true,
  click: true,
  scroll: true,
  hand_lost: true,
};

/** Shallow runtime check of a message coming from the renderer (untrusted process boundary). */
export function isGestureEvent(v: unknown): v is GestureEvent {
  if (typeof v !== "object" || v === null) return false;
  const type = (v as { type?: unknown }).type;
  const t = (v as { t?: unknown }).t;
  return typeof type === "string" && Object.hasOwn(EVENT_TYPES, type) && typeof t === "number";
}

export function isVisionStatus(v: unknown): v is VisionStatus {
  if (typeof v !== "object" || v === null) return false;
  const type = (v as { type?: unknown }).type;
  return type === "starting" || type === "running" || type === "error";
}
