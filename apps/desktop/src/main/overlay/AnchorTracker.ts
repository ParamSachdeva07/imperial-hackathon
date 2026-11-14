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
import type { Clock } from "./clock";

export interface AnchorTrackerOptions {
  boundsProvider: BoundsProvider;
  clock?: Clock;
  intervalMs?: number;
  lostAfterMisses?: number;
  onMoved: (overlayId: string, elementId: string, bounds: ElementBounds) => void;
  onLost: (overlayId: string, elementId: string) => void;
}

export class AnchorTracker {
  constructor(_opts: AnchorTrackerOptions) {}

  /**
   * Track the given element ids for an overlay. `initial` holds bounds already resolved at tool
   * time (missing ids are treated as not yet found, with zero misses).
   */
  track(_overlayId: string, _elementIds: string[], _initial: Map<string, ElementBounds>): void {
    throw new Error("not implemented: AnchorTracker.track");
  }

  untrack(_overlayId: string): void {
    throw new Error("not implemented: AnchorTracker.untrack");
  }

  isTracking(_overlayId: string): boolean {
    throw new Error("not implemented: AnchorTracker.isTracking");
  }

  start(): void {
    throw new Error("not implemented: AnchorTracker.start");
  }

  stop(): void {
    throw new Error("not implemented: AnchorTracker.stop");
  }

  /** Run one check now (also used by tests). Resolves when the check (and any follow-up) finishes. */
  check(): Promise<void> {
    throw new Error("not implemented: AnchorTracker.check");
  }
}
