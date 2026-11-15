/** Remembers the last `mouse` start/move position (global DIP) so the assistant knows the user has been pointing. Pure, injected clock. */
import type { GestureEvent } from "@pointy/gestures";

export interface PointerSample {
  x: number;
  y: number;
  displayId: number;
  at: number;
}

export class PointerTracker {
  private sample: PointerSample | null = null;
  private readonly now: () => number;
  private readonly getBounds: () => { x: number; y: number };

  constructor(opts: {
    getBounds: () => { x: number; y: number };
    now?: () => number;
  }) {
    this.getBounds = opts.getBounds;
    this.now = opts.now ?? Date.now;
  }

  observe(e: GestureEvent): void {
    if (e.type !== "mouse" || e.phase === "end") return;
    const b = this.getBounds();
    this.sample = {
      x: b.x + e.x,
      y: b.y + e.y,
      displayId: e.displayId,
      at: this.now(),
    };
  }

  last(): PointerSample | null {
    return this.sample;
  }

  activeRecently(ms: number): boolean {
    return !!this.sample && this.now() - this.sample.at <= ms;
  }
}
