/**
 * TargetResolver (spec §5.3). Turns a Target into global-DIP bounds + drawing shape.
 * STUB (Phase 0): implemented by the logic track.
 *
 *  - element → BoundsProvider.getBounds(elementId). null (or a rejected promise) →
 *    { ok:false, reason:"target_not_found" }.
 *  - rect / point / polygon → as given. The given displayId must exist, else "display_not_found".
 *    point → bounds is a 2×2 rect centred on the point, shape {kind:"point"}.
 *    polygon → bounds is the bounding rect of its points, shape {kind:"polygon", points}.
 *  - If the bounds overlap no display → "target_offscreen".
 *  - The resolved displayId is the display containing the bounds' centre (displayForRect), which
 *    may differ from the one given/reported when coordinates sit on another display.
 */
import type { BoundsProvider, DisplayInfo, Rect, Target, TargetShape } from "@pointy/shared/overlay";

export interface ResolvedTarget {
  bounds: Rect;
  displayId: string;
  shape: TargetShape;
  /** Set for element targets. */
  elementId?: string;
}

export type ResolveResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; reason: "target_not_found" | "target_offscreen" | "display_not_found" };

export interface TargetResolverOptions {
  boundsProvider: BoundsProvider;
  getDisplays: () => DisplayInfo[];
}

export class TargetResolver {
  constructor(_opts: TargetResolverOptions) {}

  resolve(_target: Target): Promise<ResolveResult> {
    throw new Error("not implemented: TargetResolver.resolve");
  }
}

/** True for rect/point/polygon targets (they expire on context change). */
export function isCoordinateOnly(target: Target): boolean {
  return target.kind !== "element";
}
