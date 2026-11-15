import { describe, expect, it } from "vitest";
import type { DisplayInfo, Target } from "@pointy/shared/overlay";
import { TargetResolver, isCoordinateOnly } from "./TargetResolver";
import { FakeBoundsProvider } from "./testing/fakeClock";

const disp = (id: string, x: number, y: number, w: number, h: number, scale = 1): DisplayInfo => ({
  id,
  bounds: { x, y, width: w, height: h },
  workArea: { x, y, width: w, height: h },
  scaleFactor: scale,
});
const displays = [disp("1", 0, 0, 1440, 900, 2), disp("2", -1920, 0, 1920, 1080, 1)];

function setup() {
  const provider = new FakeBoundsProvider();
  const r = new TargetResolver({ boundsProvider: provider, getDisplays: () => displays });
  return { provider, r };
}

describe("TargetResolver element", () => {
  it("resolves bounds, displayId, rect shape and elementId", async () => {
    const { provider, r } = setup();
    provider.set("e", { rect: { x: 100, y: 100, width: 50, height: 20 }, displayId: "1" });
    const res = await r.resolve({ kind: "element", elementId: "e" });
    expect(res).toEqual({
      ok: true,
      target: {
        bounds: { x: 100, y: 100, width: 50, height: 20 },
        displayId: "1",
        shape: { kind: "rect" },
        elementId: "e",
      },
    });
  });
  it("null → target_not_found", async () => {
    const { r } = setup();
    expect(await r.resolve({ kind: "element", elementId: "missing" })).toEqual({
      ok: false,
      reason: "target_not_found",
    });
  });
  it("provider rejection → target_not_found", async () => {
    const { provider, r } = setup();
    provider.set("e", new Error("ax down"));
    expect(await r.resolve({ kind: "element", elementId: "e" })).toEqual({
      ok: false,
      reason: "target_not_found",
    });
  });
  it("off-screen element → target_offscreen", async () => {
    const { provider, r } = setup();
    provider.set("e", { rect: { x: 5000, y: 5000, width: 10, height: 10 }, displayId: "1" });
    expect(await r.resolve({ kind: "element", elementId: "e" })).toEqual({
      ok: false,
      reason: "target_offscreen",
    });
  });
  it("element on a negative-origin display resolves to that display, ignoring the reported id", async () => {
    const { provider, r } = setup();
    provider.set("e", { rect: { x: -500, y: 100, width: 100, height: 50 }, displayId: "1" });
    const res = await r.resolve({ kind: "element", elementId: "e" });
    expect(res.ok && res.target.displayId).toBe("2");
  });
  it("element straddling displays picks the display containing the centre", async () => {
    const { provider, r } = setup();
    provider.set("e", { rect: { x: -100, y: 100, width: 300, height: 50 }, displayId: "2" });
    const res = await r.resolve({ kind: "element", elementId: "e" });
    expect(res.ok && res.target.displayId).toBe("1"); // centre x = 50
    provider.set("e", { rect: { x: -300, y: 100, width: 300, height: 50 }, displayId: "1" });
    const res2 = await r.resolve({ kind: "element", elementId: "e" });
    expect(res2.ok && res2.target.displayId).toBe("2"); // centre x = -150
  });
});

describe("TargetResolver rect", () => {
  it("passes the rect through", async () => {
    const { r } = setup();
    const res = await r.resolve({ kind: "rect", displayId: "1", rect: { x: 10, y: 20, width: 30, height: 40 } });
    expect(res).toEqual({
      ok: true,
      target: { bounds: { x: 10, y: 20, width: 30, height: 40 }, displayId: "1", shape: { kind: "rect" } },
    });
  });
  it("unknown displayId → display_not_found", async () => {
    const { r } = setup();
    expect(await r.resolve({ kind: "rect", displayId: "99", rect: { x: 0, y: 0, width: 5, height: 5 } })).toEqual({
      ok: false,
      reason: "display_not_found",
    });
  });
  it("display_not_found takes precedence over off-screen", async () => {
    const { r } = setup();
    const res = await r.resolve({ kind: "rect", displayId: "99", rect: { x: 9999, y: 0, width: 5, height: 5 } });
    expect(res).toEqual({ ok: false, reason: "display_not_found" });
  });
  it("off every display → target_offscreen", async () => {
    const { r } = setup();
    const res = await r.resolve({ kind: "rect", displayId: "1", rect: { x: 3000, y: 3000, width: 5, height: 5 } });
    expect(res).toEqual({ ok: false, reason: "target_offscreen" });
  });
  it("resolved displayId follows the coordinates, not the given id", async () => {
    const { r } = setup();
    const res = await r.resolve({ kind: "rect", displayId: "1", rect: { x: -800, y: 200, width: 100, height: 100 } });
    expect(res.ok && res.target.displayId).toBe("2");
  });
  it("has no elementId", async () => {
    const { r } = setup();
    const res = await r.resolve({ kind: "rect", displayId: "1", rect: { x: 0, y: 0, width: 5, height: 5 } });
    expect(res.ok && "elementId" in res.target).toBe(false);
  });
});

describe("TargetResolver point", () => {
  it("is a 2x2 rect centred on the point with point shape", async () => {
    const { r } = setup();
    const res = await r.resolve({ kind: "point", displayId: "1", point: { x: 100, y: 200 } });
    expect(res).toEqual({
      ok: true,
      target: {
        bounds: { x: 99, y: 199, width: 2, height: 2 },
        displayId: "1",
        shape: { kind: "point", point: { x: 100, y: 200 } },
      },
    });
  });
  it("point on a negative-origin display", async () => {
    const { r } = setup();
    const res = await r.resolve({ kind: "point", displayId: "2", point: { x: -960, y: 540 } });
    expect(res.ok && res.target.displayId).toBe("2");
  });
  it("point off-screen → target_offscreen", async () => {
    const { r } = setup();
    expect(await r.resolve({ kind: "point", displayId: "1", point: { x: -5000, y: 0 } })).toEqual({
      ok: false,
      reason: "target_offscreen",
    });
  });
  it("unknown display → display_not_found", async () => {
    const { r } = setup();
    expect(await r.resolve({ kind: "point", displayId: "x", point: { x: 1, y: 1 } })).toEqual({
      ok: false,
      reason: "display_not_found",
    });
  });
});

describe("TargetResolver polygon", () => {
  const points = [
    { x: 100, y: 100 },
    { x: 300, y: 150 },
    { x: 200, y: 400 },
  ];
  it("bounds is the bounding rect and shape keeps the true path", async () => {
    const { r } = setup();
    const res = await r.resolve({ kind: "polygon", displayId: "1", points });
    expect(res).toEqual({
      ok: true,
      target: {
        bounds: { x: 100, y: 100, width: 200, height: 300 },
        displayId: "1",
        shape: { kind: "polygon", points },
      },
    });
  });
  it("display containing the centre of the bounding rect", async () => {
    const { r } = setup();
    const pts = [
      { x: -400, y: 100 },
      { x: -200, y: 100 },
      { x: -300, y: 300 },
    ];
    const res = await r.resolve({ kind: "polygon", displayId: "1", points: pts });
    expect(res.ok && res.target.displayId).toBe("2");
  });
  it("off-screen polygon → target_offscreen; unknown display → display_not_found", async () => {
    const { r } = setup();
    const far = points.map((p) => ({ x: p.x + 10000, y: p.y }));
    expect(await r.resolve({ kind: "polygon", displayId: "1", points: far })).toEqual({
      ok: false,
      reason: "target_offscreen",
    });
    expect(await r.resolve({ kind: "polygon", displayId: "7", points })).toEqual({
      ok: false,
      reason: "display_not_found",
    });
  });
});

describe("TargetResolver displays", () => {
  it("reads displays fresh on every resolve", async () => {
    const provider = new FakeBoundsProvider();
    let list = [disp("1", 0, 0, 100, 100)];
    const r = new TargetResolver({ boundsProvider: provider, getDisplays: () => list });
    const t: Target = { kind: "rect", displayId: "2", rect: { x: 500, y: 0, width: 10, height: 10 } };
    expect((await r.resolve(t)).ok).toBe(false);
    list = [disp("1", 0, 0, 100, 100), disp("2", 400, 0, 400, 400)];
    expect((await r.resolve(t)).ok).toBe(true);
  });
});

describe("isCoordinateOnly", () => {
  it("is false for element, true for rect/point/polygon", () => {
    expect(isCoordinateOnly({ kind: "element", elementId: "e" })).toBe(false);
    expect(isCoordinateOnly({ kind: "rect", displayId: "1", rect: { x: 0, y: 0, width: 1, height: 1 } })).toBe(true);
    expect(isCoordinateOnly({ kind: "point", displayId: "1", point: { x: 0, y: 0 } })).toBe(true);
    expect(isCoordinateOnly({ kind: "polygon", displayId: "1", points: [] as never })).toBe(true);
  });
});
