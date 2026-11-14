import { describe, expect, it } from "vitest";
import type { DisplayInfo } from "@pointy/shared/overlay";
import {
  dipToPx,
  displayContaining,
  displayForRect,
  findDisplay,
  globalDipToDisplayPx,
  globalToLocal,
  isOnAnyDisplay,
  localToGlobal,
  rectGlobalToLocal,
  rectLocalToGlobal,
  toDisplayInfo,
} from "./coords";

const primary: DisplayInfo = {
  id: "1",
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
  scaleFactor: 2,
};
// External monitor to the left and above: negative origin.
const left: DisplayInfo = {
  id: "2",
  bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
  workArea: { x: -1920, y: -200, width: 1920, height: 1080 },
  scaleFactor: 1,
};
const displays = [primary, left];

describe("toDisplayInfo", () => {
  it("stringifies numeric ids", () => {
    const info = toDisplayInfo({ id: 42, bounds: primary.bounds, workArea: primary.workArea, scaleFactor: 2 });
    expect(info).toEqual({ ...primary, id: "42" });
  });
  it("keeps string ids", () => {
    expect(toDisplayInfo({ ...primary, id: "x" }).id).toBe("x");
  });
});

describe("global/local", () => {
  it("round-trips points on a negative-origin display", () => {
    const g = { x: -1000, y: 50 };
    const l = globalToLocal(g, left);
    expect(l).toEqual({ x: 920, y: 250 });
    expect(localToGlobal(l, left)).toEqual(g);
  });
  it("round-trips rects and preserves size", () => {
    const g = { x: -1900, y: -100, width: 30, height: 40 };
    const l = rectGlobalToLocal(g, left);
    expect(l).toEqual({ x: 20, y: 100, width: 30, height: 40 });
    expect(rectLocalToGlobal(l, left)).toEqual(g);
  });
  it("is identity on the primary display", () => {
    expect(globalToLocal({ x: 5, y: 6 }, primary)).toEqual({ x: 5, y: 6 });
  });
});

describe("dipToPx", () => {
  it("scales by 1 and 2", () => {
    expect(dipToPx({ x: 10, y: 20, width: 30, height: 40 }, 1)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(dipToPx({ x: 10, y: 20, width: 30, height: 40 }, 2)).toEqual({ x: 20, y: 40, width: 60, height: 80 });
  });
  it("rounds outward", () => {
    // x 10.3..20.6 at 2x → 20.6..41.2 → 20..42
    expect(dipToPx({ x: 10.3, y: 0.2, width: 10.3, height: 0.1 }, 2)).toEqual({ x: 20, y: 0, width: 22, height: 1 });
  });
  it("rounds outward for negative coordinates", () => {
    expect(dipToPx({ x: -1.2, y: -1.2, width: 1, height: 1 }, 1)).toEqual({ x: -2, y: -2, width: 2, height: 2 });
  });
  it("handles 1.5x scale", () => {
    expect(dipToPx({ x: 1, y: 1, width: 1, height: 1 }, 1.5)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });
});

describe("globalDipToDisplayPx", () => {
  it("converts relative to the display on scale 2", () => {
    expect(globalDipToDisplayPx({ x: 100, y: 50, width: 200, height: 100 }, primary)).toEqual({
      x: 200,
      y: 100,
      width: 400,
      height: 200,
    });
  });
  it("is relative to a negative origin on scale 1", () => {
    expect(globalDipToDisplayPx({ x: -1900, y: -190, width: 100, height: 50 }, left)).toEqual({
      x: 20,
      y: 10,
      width: 100,
      height: 50,
    });
  });
  it("clamps to the display", () => {
    expect(globalDipToDisplayPx({ x: -50, y: -50, width: 100, height: 100 }, primary)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(globalDipToDisplayPx({ x: 1400, y: 880, width: 100, height: 100 }, primary)).toEqual({
      x: 2800,
      y: 1760,
      width: 80,
      height: 40,
    });
  });
  it("returns null when not overlapping", () => {
    expect(globalDipToDisplayPx({ x: 2000, y: 0, width: 10, height: 10 }, primary)).toBeNull();
    expect(globalDipToDisplayPx({ x: 1440, y: 0, width: 10, height: 10 }, primary)).toBeNull();
  });
  it("rounds outward but stays within pixel bounds", () => {
    const px = globalDipToDisplayPx({ x: 0.25, y: 0.25, width: 1439.6, height: 899.6 }, primary);
    expect(px).toEqual({ x: 0, y: 0, width: 2880, height: 1800 });
  });
});

describe("findDisplay", () => {
  it("finds by id or null", () => {
    expect(findDisplay("2", displays)).toBe(left);
    expect(findDisplay("9", displays)).toBeNull();
  });
});

describe("displayContaining edges", () => {
  it("left/top inclusive, right/bottom exclusive", () => {
    expect(displayContaining({ x: 0, y: 0 }, displays)).toBe(primary);
    expect(displayContaining({ x: 1440, y: 10 }, displays)).toBeNull();
    expect(displayContaining({ x: 10, y: 900 }, displays)).toBeNull();
    expect(displayContaining({ x: -1920, y: -200 }, displays)).toBe(left);
  });
  it("boundary between adjacent displays goes to the right one", () => {
    expect(displayContaining({ x: 0, y: 0 }, displays)).toBe(primary);
    expect(displayContaining({ x: -0.01, y: 0 }, displays)).toBe(left);
  });
  it("null when off all displays", () => {
    expect(displayContaining({ x: 5000, y: 5000 }, displays)).toBeNull();
  });
});

describe("displayForRect", () => {
  it("uses the centre display", () => {
    // spans the boundary but centre is on the left display
    expect(displayForRect({ x: -100, y: 0, width: 150, height: 50 }, displays)).toBe(left);
    expect(displayForRect({ x: -50, y: 0, width: 150, height: 50 }, displays)).toBe(primary);
  });
  it("falls back to largest overlap when the centre is off-screen", () => {
    expect(displayForRect({ x: 1400, y: 10, width: 200, height: 50 }, displays)).toBe(primary);
    // centre y=-250 is above both displays; overlaps the left display (y >= -200)
    expect(displayForRect({ x: -500, y: -400, width: 100, height: 300 }, displays)).toBe(left);
  });
  it("picks the larger overlap among several", () => {
    const a: DisplayInfo = { ...primary, id: "a", bounds: { x: 0, y: 0, width: 100, height: 100 } };
    const b: DisplayInfo = { ...primary, id: "b", bounds: { x: 200, y: 0, width: 100, height: 100 } };
    // centre lies in the gap (100..200)
    expect(displayForRect({ x: 70, y: 0, width: 150, height: 10 }, [a, b])).toBe(a); // 30 vs 20
    expect(displayForRect({ x: 80, y: 0, width: 150, height: 10 }, [a, b])).toBe(b); // 20 vs 30
  });
  it("null when no overlap", () => {
    expect(displayForRect({ x: 9000, y: 9000, width: 10, height: 10 }, displays)).toBeNull();
    expect(displayForRect({ x: 0, y: 0, width: 10, height: 10 }, [])).toBeNull();
  });
});

describe("isOnAnyDisplay", () => {
  it("true on overlap, false on touching or away", () => {
    expect(isOnAnyDisplay({ x: 1430, y: 0, width: 50, height: 10 }, displays)).toBe(true);
    expect(isOnAnyDisplay({ x: 1440, y: 0, width: 50, height: 10 }, displays)).toBe(false);
    expect(isOnAnyDisplay({ x: -1930, y: 0, width: 20, height: 10 }, displays)).toBe(true);
  });
});
