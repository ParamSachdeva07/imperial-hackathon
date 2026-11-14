import { describe, expect, it } from "vitest";
import type { DisplayInfo } from "@pointy/shared/overlay";
import { fitSize, normaliseInCrop, planCrop } from "./anatomyCrop";

const disp = (id: string, x: number, y: number, w: number, h: number, scale: number): DisplayInfo => ({
  id,
  bounds: { x, y, width: w, height: h },
  workArea: { x, y, width: w, height: h },
  scaleFactor: scale,
});
const d1 = disp("1", 0, 0, 1000, 800, 1);
const d2 = disp("2", 0, 0, 1000, 800, 2);
const dNeg = disp("3", -1000, -100, 1000, 800, 2);

describe("planCrop", () => {
  it("pads by 15% each side", () => {
    const p = planCrop({ x: 400, y: 300, width: 200, height: 100 }, d1);
    expect(p.region).toEqual({ x: 370, y: 285, width: 260, height: 130 });
    expect(p.px).toEqual({ x: 370, y: 285, width: 260, height: 130 });
    expect(p.displayId).toBe("1");
    expect(p.scaleFactor).toBe(1);
  });
  it("honours a custom pad fraction (0 = no padding)", () => {
    const p = planCrop({ x: 100, y: 100, width: 100, height: 50 }, d1, 0);
    expect(p.region).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });
  it("clamps padding at the top-left display edge", () => {
    const p = planCrop({ x: 10, y: 5, width: 100, height: 100 }, d1);
    expect(p.region).toEqual({ x: 0, y: 0, width: 125, height: 120 });
    expect(p.px).toEqual({ x: 0, y: 0, width: 125, height: 120 });
  });
  it("clamps padding at the bottom-right display edge", () => {
    const p = planCrop({ x: 900, y: 700, width: 100, height: 100 }, d1);
    expect(p.region).toEqual({ x: 885, y: 685, width: 115, height: 115 });
  });
  it("clamps when the region itself extends past the display", () => {
    const p = planCrop({ x: 950, y: 750, width: 200, height: 200 }, d1);
    expect(p.region.x + p.region.width).toBe(1000);
    expect(p.region.y + p.region.height).toBe(800);
  });
  it("produces Retina pixel rects (scale 2)", () => {
    const p = planCrop({ x: 400, y: 300, width: 200, height: 100 }, d2);
    expect(p.region).toEqual({ x: 370, y: 285, width: 260, height: 130 });
    expect(p.px).toEqual({ x: 740, y: 570, width: 520, height: 260 });
    expect(p.scaleFactor).toBe(2);
  });
  it("rounds pixel rects outward for fractional DIPs", () => {
    const p = planCrop({ x: 100.3, y: 100.3, width: 10, height: 10 }, d2, 0);
    expect(p.px.x).toBe(200);
    expect(p.px.y).toBe(200);
    expect(p.px.x + p.px.width).toBe(Math.ceil(110.3 * 2));
  });
  it("clamps pixel rect to the display pixel size at scale 2", () => {
    const p = planCrop({ x: 900, y: 700, width: 100, height: 100 }, d2);
    expect(p.px.x + p.px.width).toBeLessThanOrEqual(2000);
    expect(p.px.y + p.px.height).toBeLessThanOrEqual(1600);
    expect(p.px.x + p.px.width).toBe(2000);
  });
  it("pixel rect is relative to the display origin (negative-origin display)", () => {
    const p = planCrop({ x: -600, y: 100, width: 200, height: 100 }, dNeg);
    // region x: -630..-370 → local 370..630 → px 740..1260
    expect(p.region).toEqual({ x: -630, y: 85, width: 260, height: 130 });
    expect(p.px).toEqual({ x: 740, y: 370, width: 520, height: 260 });
  });
  it("clamps at the edges of a negative-origin display", () => {
    const p = planCrop({ x: -1000, y: -100, width: 100, height: 100 }, dNeg);
    expect(p.region.x).toBe(-1000);
    expect(p.region.y).toBe(-100);
    expect(p.px.x).toBe(0);
    expect(p.px.y).toBe(0);
  });
  it("falls back to the whole display when the region is off-display", () => {
    const p = planCrop({ x: 5000, y: 5000, width: 10, height: 10 }, d1);
    expect(p.region).toEqual(d1.bounds);
  });
});

describe("fitSize", () => {
  it("scales down preserving aspect ratio", () => {
    const f = fitSize({ width: 400, height: 200 }, { width: 200, height: 200 });
    expect(f).toEqual({ width: 200, height: 100, scale: 0.5 });
  });
  it("scales up (upscaling allowed)", () => {
    const f = fitSize({ width: 100, height: 50 }, { width: 400, height: 400 });
    expect(f).toEqual({ width: 400, height: 200, scale: 4 });
  });
  it("is limited by the tighter dimension", () => {
    const f = fitSize({ width: 100, height: 400 }, { width: 300, height: 200 });
    expect(f.scale).toBeCloseTo(0.5);
    expect(f.width).toBeCloseTo(50);
    expect(f.height).toBeCloseTo(200);
  });
  it("exact fit gives scale 1", () => {
    expect(fitSize({ width: 10, height: 10 }, { width: 10, height: 10 }).scale).toBe(1);
  });
  it("degenerate sizes yield zero", () => {
    expect(fitSize({ width: 0, height: 10 }, { width: 10, height: 10 })).toEqual({ width: 0, height: 0, scale: 0 });
    expect(fitSize({ width: 10, height: 10 }, { width: 0, height: 10 })).toEqual({ width: 0, height: 0, scale: 0 });
  });
});

describe("normaliseInCrop", () => {
  const plan = planCrop({ x: 400, y: 300, width: 200, height: 100 }, d1, 0); // region 400,300 200x100
  it("maps a rect inside the crop to fractions", () => {
    const n = normaliseInCrop({ x: 450, y: 325, width: 100, height: 50 }, plan);
    expect(n).toEqual({ nx: 0.25, ny: 0.25, nw: 0.5, nh: 0.5, inside: true });
  });
  it("the full region maps to 0,0,1,1", () => {
    expect(normaliseInCrop(plan.region, plan)).toEqual({ nx: 0, ny: 0, nw: 1, nh: 1, inside: true });
  });
  it("clips a partly outside callout to the crop", () => {
    const n = normaliseInCrop({ x: 350, y: 300, width: 100, height: 50 }, plan);
    expect(n.inside).toBe(true);
    expect(n.nx).toBe(0);
    expect(n.nw).toBeCloseTo(0.25);
    expect(n.nh).toBeCloseTo(0.5);
  });
  it("a callout fully outside is not inside", () => {
    const n = normaliseInCrop({ x: 0, y: 0, width: 50, height: 50 }, plan);
    expect(n.inside).toBe(false);
    expect(n.nw).toBe(0);
  });
  it("a callout merely touching the crop edge is not inside", () => {
    expect(normaliseInCrop({ x: 600, y: 300, width: 50, height: 50 }, plan).inside).toBe(false);
  });
  it("works with padded, clamped plans and negative origins", () => {
    const p = planCrop({ x: -600, y: 100, width: 200, height: 100 }, dNeg);
    const n = normaliseInCrop({ x: -600, y: 100, width: 200, height: 100 }, p);
    expect(n.inside).toBe(true);
    expect(n.nx).toBeCloseTo(30 / 260);
    expect(n.nw).toBeCloseTo(200 / 260);
    expect(n.ny).toBeCloseTo(15 / 130);
  });
  it("is independent of scale factor", () => {
    const a = planCrop({ x: 400, y: 300, width: 200, height: 100 }, d1);
    const b = planCrop({ x: 400, y: 300, width: 200, height: 100 }, d2);
    const t = { x: 450, y: 320, width: 40, height: 30 };
    expect(normaliseInCrop(t, a)).toEqual(normaliseInCrop(t, b));
  });
});
