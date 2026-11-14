/**
 * AnchorTracker (spec §5.4). Keeps element-anchored annotations attached to their elements.
 * STUB (Phase 0): implemented by the logic track.
 *
 *  - Every `intervalMs` (default 300) while at least one anchor is tracked, and immediately when
 *    BoundsProvider.onChange fires, re-resolve every tracked element id (each distinct id once per
 *    check). Checks never overlap: a change arriving mid-check schedules exactly one follow-up check.
 *  - When an element's bounds differ from the last known bounds (rectsEqual eps 0.5) or its
 *    displayId changes → onMoved(overlayId, elementId, bounds). Also fires when an element that was
 *    missing (or never found) is found again.
 *  - When an element is missing for `lostAfterMisses` (default 2) consecutive checks →
 *    onLost(overlayId, elementId), once, until it is found again.
 *  - Never throws from a check: a provider rejection counts as "missing".
 *  - start() subscribes to provider.onChange and starts the timer; stop() undoes both.
 */
import type { BoundsProvider, ElementBounds } from "@pointy/shared/overlay";
import type { Clock, TimerHandle } from "./clock";
import { realClock } from "./clock";
import { rectsEqual } from "./geometry";

export interface AnchorTrackerOptions {
  boundsProvider: BoundsProvider;
  clock?: Clock;
  intervalMs?: number;
  lostAfterMisses?: number;
  onMoved: (overlayId: string, elementId: string, bounds: ElementBounds) => void;
  onLost: (overlayId: string, elementId: string) => void;
}

interface AnchorState {
  bounds: ElementBounds | null;
  misses: number;
  lost: boolean;
}

export class AnchorTracker {
  private readonly provider: BoundsProvider;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly lostAfter: number;
  private readonly onMoved: AnchorTrackerOptions["onMoved"];
  private readonly onLost: AnchorTrackerOptions["onLost"];

  /** overlayId → elementId → state. */
  private readonly overlays = new Map<string, Map<string, AnchorState>>();
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private timer: TimerHandle | undefined;
  private timerActive = false;
  private current: Promise<void> | null = null;
  private followUp = false;

  constructor(opts: AnchorTrackerOptions) {
    this.provider = opts.boundsProvider;
    this.clock = opts.clock ?? realClock;
    this.intervalMs = opts.intervalMs ?? 300;
    this.lostAfter = opts.lostAfterMisses ?? 2;
    this.onMoved = opts.onMoved;
    this.onLost = opts.onLost;
  }

  /**
   * Track the given element ids for an overlay. `initial` holds bounds already resolved at tool
   * time (missing ids are treated as not yet found, with zero misses).
   */
  track(overlayId: string, elementIds: string[], initial: Map<string, ElementBounds>): void {
    const states = new Map<string, AnchorState>();
    for (const id of elementIds) {
      states.set(id, { bounds: initial.get(id) ?? null, misses: 0, lost: false });
    }
    this.overlays.set(overlayId, states);
    this.syncTimer();
  }

  untrack(overlayId: string): void {
    this.overlays.delete(overlayId);
    this.syncTimer();
  }

  isTracking(overlayId: string): boolean {
    return this.overlays.has(overlayId);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.provider.onChange(() => {
      if (this.hasWork()) void this.check();
    });
    this.syncTimer();
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.syncTimer();
  }

  /** Run one check now (also used by tests). Resolves when the check (and any follow-up) finishes. */
  check(): Promise<void> {
    if (this.current) {
      this.followUp = true;
      return this.current;
    }
    this.current = this.runLoop();
    return this.current;
  }

  private hasWork(): boolean {
    for (const states of this.overlays.values()) if (states.size > 0) return true;
    return false;
  }

  private syncTimer(): void {
    const want = this.started && this.hasWork();
    if (want && !this.timerActive) {
      this.timerActive = true;
      this.schedule();
    } else if (!want && this.timerActive) {
      this.timerActive = false;
      if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (!this.timerActive) return;
      this.schedule();
      // A periodic tick while a check is in flight is simply skipped.
      if (!this.current) void this.check();
    }, this.intervalMs);
  }

  private async runLoop(): Promise<void> {
    try {
      do {
        this.followUp = false;
        try {
          await this.runOnce();
        } catch {
          // never throw from a check
        }
      } while (this.followUp);
    } finally {
      this.current = null;
    }
  }

  private async runOnce(): Promise<void> {
    const ids = new Set<string>();
    for (const states of this.overlays.values()) for (const id of states.keys()) ids.add(id);
    if (ids.size === 0) return;

    const results = new Map<string, ElementBounds | null>();
    await Promise.all(
      [...ids].map(async (id) => {
        try {
          results.set(id, (await this.provider.getBounds(id)) ?? null);
        } catch {
          results.set(id, null);
        }
      }),
    );

    for (const [overlayId, states] of [...this.overlays]) {
      for (const [elementId, state] of [...states]) {
        // The overlay may have been untracked / replaced by a callback or while awaiting.
        if (this.overlays.get(overlayId)?.get(elementId) !== state) continue;
        if (!results.has(elementId)) continue;
        const found = results.get(elementId) ?? null;
        if (found) {
          const wasMissing = state.bounds === null || state.misses > 0 || state.lost;
          const changed =
            !state.bounds ||
            state.bounds.displayId !== found.displayId ||
            !rectsEqual(state.bounds.rect, found.rect);
          state.misses = 0;
          state.lost = false;
          state.bounds = found;
          if (changed || wasMissing) this.safely(() => this.onMoved(overlayId, elementId, found));
        } else {
          state.misses += 1;
          if (state.misses >= this.lostAfter && !state.lost) {
            state.lost = true;
            this.safely(() => this.onLost(overlayId, elementId));
          }
        }
      }
    }
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // callbacks must not break tracking
    }
  }
}
