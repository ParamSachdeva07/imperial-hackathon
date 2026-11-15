/**
 * Hand-down guard (pure, injected clock). After an accepted selection the user lowers their hand, which the
 * interpreter reads as new gestures (fist -> wheel scroll, finger -> real mouse running to the edge, two fingers
 * pinned at the edge -> a new point_selected). Until the selection is answered/dismissed/timed out the real
 * mouse, click and scroll are frozen, and edge (clamped) selections are dropped.
 *
 * Decisions are per stroke and memoized per event object, so every listener (mouse sink, feedback view, scroll
 * invalidator) sees the same verdict, and a stroke started while blocked is dropped whole including its end.
 */
import type { GestureEvent } from "@pointy/gestures";
import type { FeedbackGestureService } from "./SimGestureService";
import type { MouseSource } from "./SimMouseSink";

export interface SelectionGuardOptions {
  now?: () => number;
  /** Minimum time mouse/scroll stay frozen after a selection, even if cleared sooner. Default 1500. */
  cooldownMs?: number;
  /** Safety unblock if clear() never arrives (dev has no controller; set to the selection outline TTL). Default 4000. */
  maxHoldMs?: number;
  /** A point_selected this close to a display edge (pt) is a clamped finger. Default 6. */
  edgeMarginPt?: number;
  /** Display size in points, for the edge check. */
  getDisplay?: () => { width: number; height: number };
}

export class SelectionGuard {
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly maxHoldMs: number;
  private readonly edge: number;
  private readonly getDisplay:
    (() => { width: number; height: number }) | undefined;
  private readonly verdicts = new WeakMap<object, boolean>();

  private acceptedAt = -Infinity;
  private blocked = false;
  /** Set by clear(): unblock once the cooldown is over. */
  private cleared = false;
  private clearedAt = -Infinity;
  /** null = no stroke in progress; true = the stroke in progress is dropped. */
  private mouseDrop: boolean | null = null;
  private scrollDrop: boolean | null = null;

  constructor(opts: SelectionGuardOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.cooldownMs = opts.cooldownMs ?? 1500;
    this.maxHoldMs = Math.max(opts.maxHoldMs ?? 4000, this.cooldownMs);
    this.edge = opts.edgeMarginPt ?? 6;
    this.getDisplay = opts.getDisplay;
  }

  /** True while real mouse/click/scroll strokes starting now would be dropped. */
  get isBlocked(): boolean {
    if (!this.blocked) return false;
    const t = this.now();
    const sinceAccept = t - this.acceptedAt;
    if (
      (this.cleared && sinceAccept >= this.cooldownMs) ||
      sinceAccept >= this.maxHoldMs
    ) {
      this.blocked = false;
      this.cleared = false;
    }
    return this.blocked;
  }

  /** The selection was answered/dismissed/timed out. Mouse stays frozen until the cooldown is over. */
  clear(): void {
    this.cleared = true;
    this.clearedAt = this.now();
  }

  /** Session closed: forget everything. */
  reset(): void {
    this.blocked = false;
    this.cleared = false;
    this.acceptedAt = -Infinity;
    this.clearedAt = -Infinity;
    this.mouseDrop = null;
    this.scrollDrop = null;
  }

  /** Whether the event should reach its listeners. Memoized per event object; safe to call from every listener. */
  allow(e: GestureEvent): boolean {
    const known = this.verdicts.get(e);
    if (known !== undefined) return known;
    const v = this.decide(e);
    this.verdicts.set(e, v);
    return v;
  }

  private nearEdge(e: { x: number; y: number }): boolean {
    const d = this.getDisplay?.();
    if (!d) return false;
    return (
      e.x < this.edge ||
      e.y < this.edge ||
      e.x > d.width - this.edge ||
      e.y > d.height - this.edge
    );
  }

  private decide(e: GestureEvent): boolean {
    switch (e.type) {
      case "point_selected":
      case "region_selected": {
        const recentlyCleared =
          this.cleared && this.now() - this.clearedAt < this.cooldownMs;
        if (
          e.type === "point_selected" &&
          (this.isBlocked || recentlyCleared) &&
          this.nearEdge(e)
        )
          return false;
        this.acceptedAt = this.now();
        this.blocked = true;
        this.cleared = false;
        // A stroke already running is the hand coming down: drop it from now on.
        if (this.mouseDrop !== null) this.mouseDrop = true;
        if (this.scrollDrop !== null) this.scrollDrop = true;
        return true;
      }
      case "mouse": {
        if (e.phase === "start" || this.mouseDrop === null)
          this.mouseDrop = this.isBlocked;
        const keep = !this.mouseDrop;
        if (e.phase === "end") this.mouseDrop = null;
        return keep;
      }
      case "click":
      case "click_progress":
        return this.mouseDrop === null ? !this.isBlocked : !this.mouseDrop;
      case "scroll": {
        if (e.phase === "start" || this.scrollDrop === null)
          this.scrollDrop = this.isBlocked;
        const keep = !this.scrollDrop;
        if (e.phase === "end") this.scrollDrop = null;
        return keep;
      }
      case "hand_lost":
        // Strokes end without an "end" event; the verdict was already taken for this event's listeners.
        this.mouseDrop = null;
        this.scrollDrop = null;
        return true;
      default:
        return true;
    }
  }
}

/** Wrap the source given to attachSystemMouse so frozen strokes never reach the real mouse. */
export function guardMouseSource(
  src: MouseSource,
  guard: SelectionGuard,
): MouseSource {
  return {
    get display() {
      return src.display;
    },
    on(type, cb) {
      return src.on(type, ((e: GestureEvent) => {
        if (guard.allow(e)) (cb as (e: GestureEvent) => void)(e);
      }) as never);
    },
  };
}

/** A FeedbackGestureService whose onAny drops what the guard rejects; everything else delegates. */
export function guardedEvents(
  sim: FeedbackGestureService,
  guard: SelectionGuard,
): FeedbackGestureService {
  return {
    onAny: (cb) => sim.onAny((e) => guard.allow(e) && cb(e)),
    onSession: (cb) => sim.onSession(cb),
    setSessionActive: (a) => sim.setSessionActive(a),
    get sessionActive() {
      return sim.sessionActive;
    },
    get display() {
      return sim.display;
    },
  };
}
