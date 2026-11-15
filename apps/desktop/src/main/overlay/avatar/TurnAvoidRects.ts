import type { AvoidRectsProvider, Rect } from "@pointy/shared/overlay";

/** A mutable avoid-rect source the assistant sets per turn (the user's selection, the pointer close-up). */
export class TurnAvoidRects implements AvoidRectsProvider {
  private rects: Rect[] = [];

  set(rects: Rect[]): void {
    this.rects = rects.map((r) => ({ ...r }));
  }

  getAvoidRects(): Rect[] {
    return this.rects;
  }
}
