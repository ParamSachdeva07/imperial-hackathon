/**
 * ExpiryManager (spec §5.5). Decides when annotations expire; does not render or emit events.
 * STUB (Phase 0): implemented by the logic track.
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
import type { Clock } from "./clock";

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

export class ExpiryManager {
  constructor(_opts: ExpiryManagerOptions) {}

  /** Start tracking (replaces an existing entry with the same id, restarting any timer). */
  track(_entry: ExpiryEntry): void {
    throw new Error("not implemented: ExpiryManager.track");
  }

  /** Stop tracking without firing onExpire (used by clear / replacement / eviction). */
  untrack(_id: string): void {
    throw new Error("not implemented: ExpiryManager.untrack");
  }

  has(_id: string): boolean {
    throw new Error("not implemented: ExpiryManager.has");
  }

  onTurnStart(_turnId: string): void {
    throw new Error("not implemented: ExpiryManager.onTurnStart");
  }

  onContextChange(): void {
    throw new Error("not implemented: ExpiryManager.onContextChange");
  }

  onTargetSelected(_elementId: string): void {
    throw new Error("not implemented: ExpiryManager.onTargetSelected");
  }

  /** Cancel all timers and forget all entries. */
  dispose(): void {
    throw new Error("not implemented: ExpiryManager.dispose");
  }
}
