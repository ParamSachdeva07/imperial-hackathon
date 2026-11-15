import { describe, expect, it, vi } from "vitest";
import type { GestureEvent } from "@pointy/gestures";
import type { DisplayInfo } from "@pointy/shared/overlay";
import { dataUrlBytes, type SelectionSnapshot } from "@pointy/shared/context/selection";
import { attachSelectionCapture, DEFAULT_BUDGET_BYTES, type BgraImage, type ImageOps, type SelectionCaptureDeps } from "./SelectionCapture";
import { ScreenPermissionError } from "./errors";

const display: DisplayInfo = { id: "1", bounds: { x: 0, y: 0, width: 400, height: 200 }, workArea: { x: 0, y: 0, width: 400, height: 200 }, scaleFactor: 2 };

const solid = (w: number, h: number): BgraImage => ({ data: Buffer.alloc(w * h * 4, 255), width: w, height: h });

function setup(over: Partial<SelectionCaptureDeps> & { active?: boolean; jpegSize?: (w: number, h: number, q: number) => number } = {}) {
  let listener: (e: GestureEvent) => void = () => {};
  let sessionCb: (a: boolean) => void = () => {};
  const source = { sessionActive: over.active ?? true, onAny: (cb: (e: GestureEvent) => void) => ((listener = cb), () => {}), onSession: (cb: (a: boolean) => void) => ((sessionCb = cb), () => {}) };
  const order: string[] = [];
  const stored: SelectionSnapshot[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const encodes: Array<[number, number, number]> = [];
  const ops: ImageOps = {
    resize: (_i, w, h) => solid(w, h),
    crop: (_i, r) => solid(r.width, r.height),
    encodeJpeg: (i, q) => {
      encodes.push([i.width, i.height, q]);
      return Buffer.alloc(over.jpegSize ? over.jpegSize(i.width, i.height, q) : 1000);
    },
  };
  const deps: SelectionCaptureDeps = {
    screen: { getDisplays: () => [display] },
    capture: async () => {
      order.push("capture");
      return { image: solid(800, 400), display };
    },
    hiding: {
      withHidden: async (fn) => {
        order.push("hide");
        try {
          return await fn();
        } finally {
          order.push("show");
        }
      },
    },
    ops,
    now: () => 1234,
    log,
    store: { set: (s) => void stored.push(s) },
    ...over,
  };
  const handle = attachSelectionCapture(source, deps);
  return { emit: listener, fire: (e: GestureEvent) => listener(e), source, sessionCb: (a: boolean) => sessionCb(a), order, stored, log, encodes, handle };
}

const region = (x = 50, y = 40, w = 100, h = 60): GestureEvent =>
  ({ type: "region_selected", hand: "Right", polygon: [[x, y], [x + w, y], [x + w, y + h]], bbox: { x, y, width: w, height: h }, displayId: 1, t: 0 }) as GestureEvent;
const point = (x = 200, y = 100): GestureEvent => ({ type: "point_selected", hand: "Right", x, y, displayId: 1, heldForMs: 500, t: 0 }) as GestureEvent;

describe("SelectionCapture", () => {
  it("captures a region inside withHidden and stores a snapshot", async () => {
    const t = setup();
    t.fire(region());
    await t.handle.idle();
    expect(t.order).toEqual(["hide", "capture", "show"]);
    const s = t.stored[0]!;
    expect(s.kind).toBe("region");
    expect(s.capturedAt).toBe(1234);
    expect(s.displayId).toBe("1");
    expect(s.polygonGlobal).toHaveLength(3);
    expect(s.pointGlobal).toBeUndefined();
    expect(s.full.width).toBe(800); // display px 800 <= 1280, no upscale
    expect(s.full.markedRegion.width).toBeCloseTo(100 / 400);
    expect(s.full.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(dataUrlBytes(s.focus.dataUrl)).toBe(1000);
    expect(t.encodes[0]![2]).toBe(70);
    expect(t.encodes[1]![2]).toBe(80);
  });

  it("captures a point with a focus box and pointGlobal", async () => {
    const t = setup();
    t.fire(point());
    await t.handle.idle();
    const s = t.stored[0]!;
    expect(s.kind).toBe("point");
    expect(s.pointGlobal).toEqual({ x: 200, y: 100 });
    expect(s.polygonGlobal).toBeUndefined();
    expect(s.regionGlobal.width).toBe(400); // 480 clamped to the 400 wide display
  });

  it("does nothing while the session is inactive, and ignores other events", async () => {
    const t = setup({ active: false });
    t.fire(region());
    t.fire({ type: "scroll", hand: "Right", phase: "move", dx: 0, dy: 1, t: 0 } as GestureEvent);
    await t.handle.idle();
    expect(t.order).toEqual([]);
    expect(t.stored).toEqual([]);
  });

  it("drops a capture still in flight when the session closes (even if it reopens)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({
      capture: async () => {
        await gate;
        return { image: solid(800, 400), display };
      },
    });
    t.fire(region());
    t.sessionCb(false);
    release();
    await t.handle.idle();
    expect(t.stored).toHaveLength(0);
  });

  it("lets the newer selection win", async () => {
    let release: () => void = () => {};
    let calls = 0;
    const t = setup({
      capture: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return { image: solid(800, 400), display };
      },
      newId: (() => {
        let n = 0;
        return () => `id${++n}`;
      })(),
    });
    t.fire(region());
    t.fire(point());
    release();
    await t.handle.idle();
    expect(t.stored).toHaveLength(1);
    expect(t.stored[0]!.kind).toBe("point");
  });

  it("steps quality then size to meet the budget", async () => {
    const t = setup({ jpegSize: (w, _h, q) => Math.round(w * q * 5) });
    t.fire(region());
    await t.handle.idle();
    const qs = t.encodes.map((e) => e[2]);
    expect(qs.slice(0, 4)).toEqual([70, 80, 55, 65]);
    expect(t.stored).toHaveLength(1);
    expect(dataUrlBytes(t.stored[0]!.full.dataUrl) + dataUrlBytes(t.stored[0]!.focus.dataUrl)).toBeLessThanOrEqual(DEFAULT_BUDGET_BYTES);
  });

  it("scales down when quality alone is not enough, and warns when nothing fits", async () => {
    const t = setup({ jpegSize: () => 500_000 });
    t.fire(region());
    await t.handle.idle();
    expect(t.stored).toHaveLength(1);
    expect(t.log.warn).toHaveBeenCalledOnce();
    expect(t.stored[0]!.full.width).toBe(400); // 800 * 0.5
  });

  it("ignores off-display selections", async () => {
    const t = setup();
    t.fire(region(5000, 5000));
    t.fire({ type: "point_selected", hand: "Right", x: 9999, y: 1, displayId: 1, heldForMs: 1, t: 0 } as GestureEvent);
    await t.handle.idle();
    expect(t.order).toEqual([]);
    expect(t.stored).toEqual([]);
  });

  it("logs capture errors instead of throwing, permission error loudly once per session", async () => {
    const t = setup({
      capture: async () => {
        throw new ScreenPermissionError("denied");
      },
    });
    t.fire(region());
    t.fire(region());
    await t.handle.idle();
    expect(t.stored).toEqual([]);
    expect(t.log.error).toHaveBeenCalledOnce();
    expect(String(t.log.error.mock.calls[0]![0])).toContain("Screen Recording");
    t.sessionCb(false);
    t.fire(region());
    await t.handle.idle();
    expect(t.log.error).toHaveBeenCalledTimes(2);
  });

  it("logs generic failures as warnings", async () => {
    const t = setup({
      capture: async () => {
        throw new Error("boom");
      },
    });
    t.fire(point());
    await t.handle.idle();
    expect(t.log.warn).toHaveBeenCalled();
    expect(t.stored).toEqual([]);
    expect(t.order.at(-1)).toBe("show");
  });
});
