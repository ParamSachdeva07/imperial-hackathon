import { describe, expect, it } from "vitest";
import { CompositeAvoidRects } from "./CompositeAvoidRects";

const A = { x: 1, y: 2, width: 3, height: 4 };
const B = { x: 5, y: 6, width: 7, height: 8 };

describe("CompositeAvoidRects", () => {
  it("uses the primary's rects (even empty) while it has live state, else the fallback", () => {
    const primary = { live: false, rects: [A], hasLiveState() { return this.live; }, getAvoidRects() { return this.rects; } };
    const c = new CompositeAvoidRects(primary, { getAvoidRects: () => [B] });
    expect(c.getAvoidRects()).toEqual([B]);
    primary.live = true;
    expect(c.getAvoidRects()).toEqual([A]);
    primary.rects = [];
    expect(c.getAvoidRects()).toEqual([]);
  });
});
