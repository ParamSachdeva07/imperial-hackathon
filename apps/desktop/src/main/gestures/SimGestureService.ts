/**
 * Camera-free stand-in for the part of the GestureService that the feedback window and the session
 * controller use: `onAny`, `onSession`, `setSessionActive`, `sessionActive`, `display`. Pure: no
 * Electron import, timers injectable.
 *
 * Two modes:
 *  - standalone (no `base`): its own session flag; `play()` replays events into its listeners.
 *  - merged (`base` = the real service, POINTY_GESTURES=1): listeners see the real service's events AND
 *    the simulated ones; session state and `setSessionActive` go to the real service. Simulated events
 *    are never given to the real service, so they can not drive the real OS mouse.
 */
import type { GestureEvent } from "@pointy/gestures";
import type { Timers } from "./DevSessionController";
import { SimGestureSource } from "./SimGestureSource";

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The members of GestureService that startGestureFeedback and DevSessionController read. */
export interface FeedbackGestureService {
  onAny(cb: (e: GestureEvent) => void): () => void;
  onSession(cb: (active: boolean) => void): () => void;
  setSessionActive(active: boolean): void;
  readonly sessionActive: boolean;
  readonly display: { id: number; width: number; height: number; bounds: DisplayBounds };
}

export interface SimGestureServiceOptions {
  /** The real service to merge with (events, session, display), or omit for a standalone simulation. */
  base?: FeedbackGestureService;
  /** Display to map to when standalone. */
  display?: () => FeedbackGestureService["display"];
  timers?: Timers;
}

export class SimGestureService implements FeedbackGestureService {
  private readonly source: SimGestureSource;
  private readonly base: FeedbackGestureService | undefined;
  private readonly displayFn: (() => FeedbackGestureService["display"]) | undefined;
  private readonly sessionListeners = new Set<(active: boolean) => void>();
  private active = false;

  constructor(opts: SimGestureServiceOptions) {
    if (!opts.base && !opts.display) throw new Error("SimGestureService needs a base service or a display");
    this.base = opts.base;
    this.displayFn = opts.display;
    this.source = new SimGestureSource(opts.timers ? { timers: opts.timers } : {});
  }

  get sessionActive(): boolean {
    return this.base ? this.base.sessionActive : this.active;
  }

  get display(): FeedbackGestureService["display"] {
    const d = this.base?.display ?? this.displayFn?.();
    if (!d) throw new Error("no display");
    return d;
  }

  onAny(cb: (e: GestureEvent) => void): () => void {
    const offSim = this.source.onAny(cb);
    const offBase = this.base?.onAny(cb);
    return () => {
      offSim();
      offBase?.();
    };
  }

  onSession(cb: (active: boolean) => void): () => void {
    if (this.base) return this.base.onSession(cb);
    this.sessionListeners.add(cb);
    return () => this.sessionListeners.delete(cb);
  }

  setSessionActive(active: boolean): void {
    if (this.base) {
      this.base.setSessionActive(active);
      return;
    }
    this.active = active;
    for (const l of [...this.sessionListeners]) l(active);
  }

  /** Replay `events` one per `intervalMs`; a new call cancels the previous replay. */
  play(events: readonly GestureEvent[], intervalMs?: number): Promise<void> {
    return this.source.play(events, intervalMs);
  }

  dispose(): void {
    this.source.dispose();
    this.sessionListeners.clear();
  }
}
