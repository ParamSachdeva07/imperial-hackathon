/**
 * Turns gesture-service events into overlay feedback (pure; no Electron).
 *
 *   GestureEvent (display-relative DIP, numeric displayId)
 *     → GestureFeedback (global DIP)
 *     → batched per microtask → GestureSink.sendGesture
 *
 * Mapping:
 *   cursor_moved            → cursor(draw)
 *   mouse start | move      → cursor(mouse)
 *   mouse end               → lost(mouse)  (only the mouse hand's cursor; the draw hand is independent)
 *   dwell_progress          → progress(dwell)
 *   click_progress          → progress(click)
 *   click                   → click
 *   point_selected          → selected_point
 *   region_selected         → selected_region (polygon + bbox converted)
 *   hand_lost               → lost(draw)
 *   scroll                  → scroll (no coordinates)
 *   wake_requested          → nothing (the session flag comes from setSessionActive)
 * Events for a display that is not (or no longer) attached are dropped.
 *
 * Batching: everything arriving in one microtask is sent as one message. Consecutive cursor (or
 * consecutive same-kind progress) updates collapse to the latest; selections, click, lost, scroll
 * and session changes are never dropped.
 */
import type { GestureEvent } from "@pointy/gestures";
import type { DisplayInfo, Point, Rect } from "@pointy/shared/overlay";
import type { GestureFeedback } from "@pointy/shared/overlay/render";
import { findDisplay, localToGlobal } from "./coords";
import type { GestureSink, ScreenSource } from "./ports";

export interface GestureEventSource {
  onAny(cb: (e: GestureEvent) => void): () => void;
}

export interface GestureFeedbackBridge {
  /** Start feeding from a source (a GestureService). Returns detach. May be called more than once. */
  attach(source: GestureEventSource): () => void;
  /** The controller's session flag; the overlay draws nothing while it is false. */
  setSessionActive(active: boolean): void;
  /** Detach everything and drop pending feedback. */
  dispose(): void;
}

export interface GestureFeedbackBridgeOptions {
  screen: ScreenSource;
  sink: GestureSink;
}

/** Display-relative event → GestureFeedback in global DIP; null = nothing to draw / unknown display. */
export function mapGestureEvent(e: GestureEvent, displays: DisplayInfo[]): GestureFeedback | null {
  const global = (displayId: number, x: number, y: number): Point | null => {
    const d = findDisplay(String(displayId), displays);
    return d ? localToGlobal({ x, y }, d) : null;
  };
  switch (e.type) {
    case "cursor_moved": {
      const at = global(e.displayId, e.x, e.y);
      return at ? { kind: "cursor", at, mode: "draw" } : null;
    }
    case "mouse": {
      if (e.phase === "end") return { kind: "lost", mode: "mouse" };
      const at = global(e.displayId, e.x, e.y);
      return at ? { kind: "cursor", at, mode: "mouse" } : null;
    }
    case "dwell_progress": {
      const at = global(e.displayId, e.x, e.y);
      return at ? { kind: "progress", at, value: clamp01(e.progress), progressKind: "dwell" } : null;
    }
    case "click_progress": {
      const at = global(e.displayId, e.x, e.y);
      return at ? { kind: "progress", at, value: clamp01(e.progress), progressKind: "click" } : null;
    }
    case "click": {
      const at = global(e.displayId, e.x, e.y);
      return at ? { kind: "click", at } : null;
    }
    case "point_selected": {
      const at = global(e.displayId, e.x, e.y);
      return at ? { kind: "selected_point", at } : null;
    }
    case "region_selected": {
      const d = findDisplay(String(e.displayId), displays);
      if (!d) return null;
      const points = e.polygon.map(([x, y]) => localToGlobal({ x, y }, d));
      const bounds: Rect = { ...e.bbox, x: e.bbox.x + d.bounds.x, y: e.bbox.y + d.bounds.y };
      return { kind: "selected_region", points, bounds };
    }
    case "hand_lost":
      return { kind: "lost", mode: "draw" };
    case "scroll":
      return { kind: "scroll", phase: e.phase };
    case "wake_requested":
      return null;
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Append, collapsing a cursor/progress update into an immediately preceding one of the same kind. */
function enqueue(queue: GestureFeedback[], next: GestureFeedback): void {
  const last = queue[queue.length - 1];
  if (last) {
    if (last.kind === "cursor" && next.kind === "cursor" && last.mode === next.mode) {
      queue[queue.length - 1] = next;
      return;
    }
    if (last.kind === "progress" && next.kind === "progress" && last.progressKind === next.progressKind) {
      queue[queue.length - 1] = next;
      return;
    }
  }
  queue.push(next);
}

export function createGestureFeedbackBridge(opts: GestureFeedbackBridgeOptions): GestureFeedbackBridge {
  const { screen, sink } = opts;
  const detachers = new Set<() => void>();
  let queue: GestureFeedback[] = [];
  let scheduled = false;
  let disposed = false;

  const flush = () => {
    scheduled = false;
    if (disposed || queue.length === 0) return;
    const events = queue;
    queue = [];
    sink.sendGesture({ events });
  };
  const push = (fb: GestureFeedback) => {
    if (disposed) return;
    enqueue(queue, fb);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };

  return {
    attach(source) {
      if (disposed) return () => {};
      const off = source.onAny((e) => {
        const fb = mapGestureEvent(e, screen.getDisplays());
        if (fb) push(fb);
      });
      let done = false;
      const detach = () => {
        if (done) return;
        done = true;
        off();
        detachers.delete(detach);
      };
      detachers.add(detach);
      return detach;
    },
    setSessionActive(active) {
      push({ kind: "session", active });
    },
    dispose() {
      if (disposed) return;
      for (const d of [...detachers]) d();
      disposed = true;
      queue = [];
    },
  };
}
