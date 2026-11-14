/**
 * Camera-free gesture source (dev only). Same `{ onAny }` shape as the real GestureService, so it can
 * be attached to the overlay's gesture feedback bridge. `play()` replays a list of events one per
 * `intervalMs` (default 33 ms, about 30 fps). Pure: no Electron import, timers injectable.
 */
import type { GestureEvent } from "@pointy/gestures";
import type { Timers } from "./DevSessionController";

export const DEFAULT_SIM_INTERVAL_MS = 33;

export interface SimGestureSourceOptions {
  timers?: Timers;
}

export class SimGestureSource {
  private readonly listeners = new Set<(e: GestureEvent) => void>();
  private readonly timers: Timers;
  private handle: unknown = null;
  private resolveRun: (() => void) | null = null;

  constructor(opts: SimGestureSourceOptions = {}) {
    this.timers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
  }

  onAny(cb: (e: GestureEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  isPlaying(): boolean {
    return this.resolveRun !== null;
  }

  /** Replay `events`; the first is emitted immediately. A new `play` cancels the previous one. Resolves when done or cancelled. */
  play(events: readonly GestureEvent[], intervalMs = DEFAULT_SIM_INTERVAL_MS): Promise<void> {
    this.cancel();
    if (events.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolveRun = resolve;
      let i = 0;
      const step = (): void => {
        const e = events[i++];
        if (e) this.emit(e);
        if (i >= events.length || this.resolveRun !== resolve) {
          if (this.resolveRun === resolve) this.finish();
          return;
        }
        this.handle = this.timers.setTimeout(step, Math.max(0, intervalMs));
      };
      step();
    });
  }

  cancel(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.finish();
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }

  private finish(): void {
    this.handle = null;
    const r = this.resolveRun;
    this.resolveRun = null;
    r?.();
  }

  private emit(e: GestureEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}
