/**
 * Stand-in gesture session controller (dev only). No electron import; clock/timers are injectable.
 *
 * REPLACEABLE SEAM: the real brain/controller (voice session, TurnContext, avatar...) will replace
 * this. It only needs the same two calls on the gesture service: `onAny` (listen) and
 * `setSessionActive` (open/close the gesture session). Behaviour here: `wake_requested` opens the
 * session; any later event while open resets an idle timer; when it fires the session closes.
 * Modelled on packages/gestures/electron/dev/mockController.ts.
 */
import type { GestureEvent } from "@pointy/gestures";

export interface SessionServiceLike {
  onAny(cb: (e: GestureEvent) => void): () => void;
  setSessionActive(active: boolean): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DevSessionControllerOptions {
  service: SessionServiceLike;
  /** Close the session after this long without any gesture event. */
  idleMs: number;
  log?: (msg: string) => void;
  timers?: Timers;
}

export class DevSessionController {
  private active = false;
  private disposed = false;
  private idleTimer: unknown = null;
  private readonly listeners = new Set<(active: boolean) => void>();
  private readonly off: () => void;
  private readonly timers: Timers;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: DevSessionControllerOptions) {
    this.timers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
    this.log = opts.log ?? (() => {});
    this.off = opts.service.onAny((e) => this.onEvent(e));
  }

  isActive(): boolean {
    return this.active;
  }

  onChange(cb: (active: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  open(): void {
    if (this.disposed) return;
    this.armIdle();
    if (this.active) return;
    this.active = true;
    this.opts.service.setSessionActive(true);
    this.log("session open");
    this.emit();
  }

  close(): void {
    this.clearIdle();
    if (!this.active) return;
    this.active = false;
    this.opts.service.setSessionActive(false);
    this.log("session closed");
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.clearIdle();
    this.listeners.clear();
    this.active = false;
  }

  private onEvent(e: GestureEvent): void {
    if (this.disposed) return;
    if (e.type === "wake_requested") this.open();
    else if (this.active) this.armIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      this.log(`idle for ${this.opts.idleMs} ms`);
      this.close();
    }, this.opts.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private emit(): void {
    for (const l of [...this.listeners]) l(this.active);
  }
}
