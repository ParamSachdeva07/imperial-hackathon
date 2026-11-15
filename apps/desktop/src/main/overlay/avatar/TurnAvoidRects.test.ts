import { describe, expect, it } from "vitest";
import { TurnAvoidRects } from "./TurnAvoidRects";

describe("TurnAvoidRects", () => {
  it("returns what was set, replaces it, and copies the input", () => {
    const t = new TurnAvoidRects();
    expect(t.getAvoidRects()).toEqual([]);
    const r = { x: 1, y: 2, width: 3, height: 4 };
    t.set([r]);
    r.x = 99;
    expect(t.getAvoidRects()).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
    t.set([]);
    expect(t.getAvoidRects()).toEqual([]);
  });
});
