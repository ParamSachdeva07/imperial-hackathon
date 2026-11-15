/**
 * Lets simulated 'mouse' / 'click' / 'scroll' events reach attachSystemMouse WITHOUT ever going through the
 * real service. Pure (no Electron import). The only producer is SimGestureService, and only when
 * POINTY_GESTURES_MOUSE=1 and the session is open; attachSystemMouse is itself attached only while the session is open.
 */
import type { GestureEvent } from "@pointy/gestures";
import type { GestureService } from "@pointy/gestures/electron";

export type MouseEventType = "mouse" | "click" | "scroll";
export type GestureMouseEvent = Extract<GestureEvent, { type: MouseEventType }>;

export const isMouseEvent = (e: GestureEvent): e is GestureMouseEvent => e.type === "mouse" || e.type === "click" || e.type === "scroll";

/** The part of GestureService that attachSystemMouse uses. */
export type MouseSource = Pick<GestureService, "on" | "display">;

export class MouseEventSink {
  private readonly listeners = new Map<MouseEventType, Set<(e: never) => void>>();

  on<T extends MouseEventType>(type: T, cb: (e: Extract<GestureEvent, { type: T }>) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    set.add(cb as (e: never) => void);
    return () => set.delete(cb as (e: never) => void);
  }

  emit(e: GestureMouseEvent): void {
    for (const cb of [...(this.listeners.get(e.type) ?? [])]) (cb as (e: GestureMouseEvent) => void)(e);
  }
}

/** One source for attachSystemMouse that sees the real service's events and the sink's. Display comes from the real service. */
export function mergeMouseSources(real: MouseSource, sink: MouseEventSink): MouseSource {
  return {
    get display() {
      return real.display;
    },
    on(type, cb) {
      const offReal = real.on(type, cb);
      const offSink = type === "mouse" || type === "click" || type === "scroll" ? sink.on(type, cb as never) : () => {};
      return () => {
        offReal();
        offSink();
      };
    },
  };
}
