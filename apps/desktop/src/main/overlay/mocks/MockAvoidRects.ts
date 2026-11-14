/**
 * Stand-in for the avatar window's bounds (an "avoid" rect for the LayoutEngine, spec §5.1).
 * POINTY_AVATAR_RECT="x,y,w,h" overrides; "none" disables; default is a 320×360 block in the
 * bottom-right of the primary work area, where the avatar window usually sits.
 */
import type { AvoidRectsProvider, DisplayInfo, Rect } from "@pointy/shared/overlay";

export class MockAvoidRects implements AvoidRectsProvider {
  constructor(
    private readonly primary: () => DisplayInfo | undefined,
    private readonly spec: string | undefined = process.env.POINTY_AVATAR_RECT,
  ) {}

  getAvoidRects(): Rect[] {
    if (this.spec === "none") return [];
    if (this.spec) {
      const [x, y, width, height] = this.spec.split(",").map(Number);
      if ([x, y, width, height].every((n) => Number.isFinite(n)) && width! > 0 && height! > 0) {
        return [{ x: x!, y: y!, width: width!, height: height! }];
      }
    }
    const d = this.primary();
    if (!d) return [];
    const w = 320;
    const h = 360;
    const wa = d.workArea;
    return [{ x: wa.x + wa.width - w - 24, y: wa.y + wa.height - h - 24, width: w, height: h }];
  }
}
