import { describe, expect, it } from "vitest";
import type { DisplayInfo } from "@pointy/shared/overlay";
import { planSelection } from "./selectionGeometry";

const mk = (id: string, x: number, y: number, w: number, h: number, sf: number): DisplayInfo => ({
  id,
  bounds: { x, y, width: w, height: h },
  workArea: { x, y, width: w, height: h },
  scaleFactor: sf,
});
const primary = mk("1", 0, 0, 1440, 900, 2);
const left = mk("2", -1920, -100, 1920, 1080, 1);

const region = (displayId: number, bbox: { x: number; y: number; width: number; height: number }) => ({
  type: "region_selected" as const,
  polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height]] as [number, number][],
  bbox,
  displayId,
});

describe("planSelection", () => {
  it("plans a region on a retina display", () => {
    const r = planSelection(region(1, { x: 100, y: 100, width: 200, height: 100 }), [primary]);
    if (!r.ok) throw new Error(r.reason);
    const p = r.plan;
    expect(p.regionGlobal).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(p.focusBoxGlobal).toEqual({ x: 70, y: 85, width: 260, height: 130 });
    expect(p.focusCropPx).toEqual({ x: 140, y: 170, width: 520, height: 260 });
    expect(p.displayPx).toEqual({ width: 2880, height: 1800 });
    expect(p.fullSize).toEqual({ width: 1280, height: 800 });
    expect(p.focusSize).toEqual({ width: 520, height: 260 });
    expect(p.markedRegion.x).toBeCloseTo(100 / 1440);
    expect(p.markedRegion.width).toBeCloseTo(200 / 1440);
    expect(p.polygonNorm?.[0]).toEqual({ x: 100 / 1440, y: 100 / 900 });
  });

  it("caps the focus at 768 on the longest side", () => {
    const r = planSelection(region(1, { x: 0, y: 0, width: 1000, height: 500 }), [primary]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.focusSize.width).toBe(768);
    expect(r.plan.focusSize.height).toBe(Math.round(768 * (r.plan.focusCropPx.height / r.plan.focusCropPx.width)));
  });

  it("clamps the focus box to the display and grows tiny regions", () => {
    const r = planSelection(region(1, { x: 0, y: 0, width: 10, height: 10 }), [primary]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.focusBoxGlobal.x).toBe(0);
    expect(r.plan.focusBoxGlobal.y).toBe(0);
    expect(r.plan.focusBoxGlobal.width).toBeGreaterThanOrEqual(120);
  });

  it("handles negative-origin displays", () => {
    const r = planSelection(region(2, { x: 10, y: 20, width: 100, height: 100 }), [primary, left]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.regionGlobal).toEqual({ x: -1910, y: -80, width: 100, height: 100 });
    expect(r.plan.polygonGlobal?.[0]).toEqual({ x: -1910, y: -80 });
    expect(r.plan.fullSize).toEqual({ width: 1280, height: 720 });
    expect(r.plan.focusCropPx.x).toBe(0); // 10 - 15 clamped
  });

  it("plans a point with a 480x320 box centred, clamped", () => {
    const mid = planSelection({ type: "point_selected", x: 700, y: 400, displayId: 1 }, [primary]);
    if (!mid.ok) throw new Error(mid.reason);
    expect(mid.plan.pointGlobal).toEqual({ x: 700, y: 400 });
    expect(mid.plan.focusBoxGlobal).toEqual({ x: 460, y: 240, width: 480, height: 320 });
    expect(mid.plan.pointNorm).toEqual({ x: 700 / 1440, y: 400 / 900 });
    const edge = planSelection({ type: "point_selected", x: 5, y: 895, displayId: 1 }, [primary]);
    if (!edge.ok) throw new Error(edge.reason);
    expect(edge.plan.focusBoxGlobal).toEqual({ x: 0, y: 580, width: 480, height: 320 });
  });

  it("rejects unknown display, off-display region and point, bad polygons", () => {
    expect(planSelection({ type: "point_selected", x: 1, y: 1, displayId: 9 }, [primary]).ok).toBe(false);
    expect(planSelection({ type: "point_selected", x: 1500, y: 1, displayId: 1 }, [primary]).ok).toBe(false);
    expect(planSelection({ type: "point_selected", x: -1, y: 1, displayId: 1 }, [primary]).ok).toBe(false);
    const off = planSelection(region(1, { x: 2000, y: 2000, width: 50, height: 50 }), [primary]);
    expect(off).toEqual({ ok: false, reason: "region is not on the display" });
    expect(planSelection({ ...region(1, { x: 1, y: 1, width: 5, height: 5 }), polygon: [[1, 1]] }, [primary]).ok).toBe(false);
    expect(planSelection({ type: "point_selected", x: NaN, y: 1, displayId: 1 }, [primary]).ok).toBe(false);
  });
});
