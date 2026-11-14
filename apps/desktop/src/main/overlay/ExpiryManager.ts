/**
 * ExpiryManager (spec §5.5). Decides when annotations expire; does not render or emit events.
 *
 * Rules:
 *  - "next_turn" (the default when `expires` is undefined): expires on onTurnStart().
 *  - "on_target_selected": expires on onTargetSelected(elementId) when elementId is one of the
 *    entry's elementIds.
 *  - "context_change": expires on onContextChange().
 *  - { ms }: expires after ms (timer started at track()).
 *  - "manual": only an explicit untrack() (i.e. `clear`).
 *  - Additionally, entries with `coordinateOnly: true` (rect/point/polygon targets) ALWAYS expire on
 *    onContextChange(), whatever their expiry (spec §5.4: their coordinates are stale after a
 *    context change).
 *  An expired entry is untracked automatically (onExpire fires once per entry).
 */
import type { Expiry } from "@pointy/shared/overlay";
import type { Clock, TimerHandle } from "./clock";
import { realClock } from "./clock";

export type ExpireCause = "next_turn" | "target_selected" | "context_change" | "timer";

export interface ExpiryEntry {
  id: string;
  /** undefined → "next_turn". */
  expires: Expiry | undefined;
  /** Element ids this annotation is attached to (for on_target_selected). */
  elementIds: string[];
  /** True when the annotation's targets are rect/point/polygon only. */
  coordinateOnly: boolean;
}

export interface ExpiryManagerOptions {
  clock?: Clock;
  onExpire: (id: string, cause: ExpireCause) => void;
}

interface Tracked {
  entry: ExpiryEntry;
  timer: TimerHandle | undefined;
}

export class ExpiryManager {
  private readonly clock: Clock;
  private readonly onExpire: (id: string, cause: ExpireCause) => void;
  private readonly entries = new Map<string, Tracked>();

  constructor(opts: ExpiryManagerOptions) {
    this.clock = opts.clock ?? realClock;
    this.onExpire = opts.onExpire;
  }

  /** Start tracking (replaces an existing entry with the same id, restarting any timer). */
  track(entry: ExpiryEntry): void {
    this.untrack(entry.id);
    const tracked: Tracked = { entry: { ...entry, elementIds: [...entry.elementIds] }, timer: undefined };
    const e = entry.expires;
    if (typeof e === "object" && e !== null) {
      tracked.timer = this.clock.setTimeout(() => this.expire(entry.id, "timer"), e.ms);
    }
    this.entries.set(entry.id, tracked);
  }

  /** Stop tracking without firing onExpire (used by clear / replacement / eviction). */
  untrack(id: string): void {
    const t = this.entries.get(id);
    if (!t) return;
    if (t.timer !== undefined) this.clock.clearTimeout(t.timer);
    this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  onTurnStart(_turnId: string): void {
    this.expireWhere((e) => e.expires === undefined || e.expires === "next_turn", "next_turn");
  }

  onContextChange(): void {
    this.expireWhere((e) => e.coordinateOnly || e.expires === "context_change", "context_change");
  }

  onTargetSelected(elementId: string): void {
    this.expireWhere((e) => e.expires === "on_target_selected" && e.elementIds.includes(elementId), "target_selected");
  }

  /** Cancel all timers and forget all entries. */
  dispose(): void {
    for (const t of this.entries.values()) {
      if (t.timer !== undefined) this.clock.clearTimeout(t.timer);
    }
    this.entries.clear();
  }

  private expireWhere(pred: (e: ExpiryEntry) => boolean, cause: ExpireCause): void {
    const ids = [...this.entries.values()].filter((t) => pred(t.entry)).map((t) => t.entry.id);
    for (const id of ids) this.expire(id, cause);
  }

  private expire(id: string, cause: ExpireCause): void {
    if (!this.entries.has(id)) return;
    this.untrack(id);
    this.onExpire(id, cause);
  }
}
