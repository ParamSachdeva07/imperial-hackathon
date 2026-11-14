/**
 * TargetResolver (spec §5.3). Turns a Target into global-DIP bounds + drawing shape.
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
import type { BoundsProvider, DisplayInfo, ElementBounds, Rect, Target, TargetShape } from "@pointy/shared/overlay";
import { findDisplay, displayForRect } from "./coords";
import { boundsOfPoints } from "./geometry";

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
  private readonly provider: BoundsProvider;
  private readonly getDisplays: () => DisplayInfo[];

  constructor(opts: TargetResolverOptions) {
    this.provider = opts.boundsProvider;
    this.getDisplays = opts.getDisplays;
  }

  async resolve(target: Target): Promise<ResolveResult> {
    const displays = this.getDisplays();
    let bounds: Rect;
    let shape: TargetShape;
    let elementId: string | undefined;

    if (target.kind === "element") {
      let found: ElementBounds | null;
      try {
        found = await this.provider.getBounds(target.elementId);
      } catch {
        found = null;
      }
      if (!found) return { ok: false, reason: "target_not_found" };
      bounds = found.rect;
      shape = { kind: "rect" };
      elementId = target.elementId;
    } else {
      if (!findDisplay(target.displayId, displays)) return { ok: false, reason: "display_not_found" };
      if (target.kind === "rect") {
        bounds = target.rect;
        shape = { kind: "rect" };
      } else if (target.kind === "point") {
        bounds = { x: target.point.x - 1, y: target.point.y - 1, width: 2, height: 2 };
        shape = { kind: "point", point: target.point };
      } else {
        bounds = boundsOfPoints(target.points);
        shape = { kind: "polygon", points: target.points };
      }
    }

    const display = displayForRect(bounds, displays);
    if (!display) return { ok: false, reason: "target_offscreen" };
    const resolved: ResolvedTarget = { bounds, displayId: display.id, shape };
    if (elementId !== undefined) resolved.elementId = elementId;
    return { ok: true, target: resolved };
  }
}

/** True for rect/point/polygon targets (they expire on context change). */
export function isCoordinateOnly(target: Target): boolean {
  return target.kind !== "element";
}
