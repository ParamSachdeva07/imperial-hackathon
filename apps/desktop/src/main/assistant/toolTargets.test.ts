import { describe, expect, it } from "vitest";
import { usesCoordinateTargets } from "./toolTargets";

describe("usesCoordinateTargets", () => {
  it("is false for element targets and plain args", () => {
    expect(usesCoordinateTargets({ target: { kind: "element", elementId: "ax-1" }, tone: "info" })).toBe(false);
    expect(usesCoordinateTargets({ overlayId: "all" })).toBe(false);
    expect(usesCoordinateTargets(null)).toBe(false);
  });
  it("detects rect/point/polygon at any depth", () => {
    expect(usesCoordinateTargets({ target: { kind: "rect", displayId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } } })).toBe(true);
    expect(usesCoordinateTargets({ items: [{ target: { kind: "element", elementId: "a" } }, { target: { kind: "point", displayId: "1", point: { x: 1, y: 1 } } }] })).toBe(true);
    expect(usesCoordinateTargets({ steps: [{ target: { kind: "polygon", displayId: "1", points: [] } }] })).toBe(true);
  });
});
