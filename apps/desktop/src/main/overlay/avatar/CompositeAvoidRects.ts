import type { AvoidRectsProvider, Rect } from "@pointy/shared/overlay";

/**
 * Avoid rects from the real Anam avatar while it is reachable (empty when it is collapsed);
 * otherwise from the fallback (the dev mock), so Pointy works whichever app starts first.
 */
export class CompositeAvoidRects implements AvoidRectsProvider {
  constructor(
    private readonly primary: AvoidRectsProvider & { hasLiveState(): boolean },
    private readonly fallback: AvoidRectsProvider,
  ) {}

  getAvoidRects(): Rect[] {
    return this.primary.hasLiveState() ? this.primary.getAvoidRects() : this.fallback.getAvoidRects();
  }
}
