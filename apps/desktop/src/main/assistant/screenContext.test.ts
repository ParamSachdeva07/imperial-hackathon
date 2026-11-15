import { describe, expect, it } from "vitest";
import type { DisplayInfo } from "@pointy/shared/overlay";
import type { ElementInfo, ElementSnapshot } from "../ax/types";
import type { BgraImage, ImageOps } from "../capture/SelectionCapture";
import { captureScreenContext, composeScreenText, pickActiveDisplayId, elementLine, encodeUnderBudget, pickElements, sanitizeLabel, screenItemEvent, screenItemEventWithin, type ScreenContextDeps } from "./screenContext";

const display: DisplayInfo = { id: "1", bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 875 }, scaleFactor: 2 };
const el = (i: number, over: Partial<ElementInfo> = {}): ElementInfo => ({ id: `ax-${i}`, role: "button", label: `Button ${i}`, window: "W", rect: { x: i, y: 2 * i, width: 30, height: 20 }, displayId: "1", ...over });
const snap = (elements: ElementInfo[], truncated = false): ElementSnapshot => ({ app: "Mail", window: "Inbox", elements, truncated, rev: 1 });
const img = (w: number, h: number): BgraImage => ({ data: Buffer.alloc(4), width: w, height: h });

/** ops whose JPEG size shrinks with quality and pixel count. */
const ops: ImageOps = {
  resize: (i, w, h) => ({ ...i, width: w, height: h }),
  crop: (i) => i,
  encodeJpeg: (i, q) => Buffer.alloc(Math.round((i.width * i.height * q) / 1000)),
};

function deps(over: Partial<ScreenContextDeps> = {}): ScreenContextDeps {
  return {
    getDisplays: () => [display],
    primaryDisplayId: () => "1",
    capture: async () => ({ image: img(2880, 1800), display }),
    hiding: { withHidden: (fn) => fn() },
    ops,
    ax: { trusted: true, snapshotNow: async () => snap([el(1), el(2)]) },
    ...over,
  };
}

describe("labels and lines", () => {
  it("sanitises control chars, pipes and length", () => {
    expect(sanitizeLabel("a|b\nc\u0000d")).toBe("a b c d");
    expect(sanitizeLabel("x".repeat(100)).length).toBe(60);
  });
  it("formats id | role | label | rect", () => {
    expect(elementLine(el(3, { focused: true }))).toBe("ax-3 | button | Button 3 (focused) | 3,6,30,20");
    expect(elementLine(el(4, { label: "" }))).toContain("(no label)");
  });
  it("caps elements preferring focused and labelled", () => {
    const els = Array.from({ length: 10 }, (_, i) => el(i, i === 9 ? { focused: true } : i < 4 ? { label: "" } : {}));
    const { picked, dropped } = pickElements(els, 5);
    expect(dropped).toBe(5);
    expect(picked.map((e) => e.id)).toContain("ax-9");
    expect(picked.filter((e) => e.label === "").length).toBe(0);
  });
});

describe("encodeUnderBudget", () => {
  it("fits the byte cap by stepping quality then size, never wider than 1280", () => {
    const out = encodeUnderBudget(img(2880, 1800), ops, 150_000);
    expect(out && out.width <= 1280 && out.jpeg.length <= 150_000).toBe(true);
  });
  it("returns null when nothing fits", () => {
    expect(encodeUnderBudget(img(2880, 1800), ops, 10)).toBeNull();
  });
});

describe("captureScreenContext", () => {
  it("builds screenshot + element text and ids", async () => {
    const ctx = await captureScreenContext(deps());
    expect(ctx.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(ctx.imageBytes).toBeLessThanOrEqual(150_000);
    expect(ctx.elementIds).toEqual(["ax-1", "ax-2"]);
    expect(ctx.text).toContain("BEGIN CONTROLS");
    expect(ctx.text).toContain("ax-2 | button | Button 2 | 2,4,30,20");
    expect(ctx.text).toContain("untrusted");
    expect(ctx.text).toContain("Frontmost app: Mail");
    expect(ctx.notes).toEqual([]);
  });

  it("caps at 150 elements", async () => {
    const many = Array.from({ length: 400 }, (_, i) => el(i));
    const ctx = await captureScreenContext(deps({ ax: { trusted: true, snapshotNow: async () => snap(many) } }));
    expect(ctx.elementIds.length).toBe(150);
    expect(ctx.text).toContain("list truncated");
  });

  it("without AX permission: screenshot only and says so", async () => {
    let called = false;
    const ctx = await captureScreenContext(deps({ ax: { trusted: false, snapshotNow: async () => ((called = true), snap([])) } }));
    expect(called).toBe(false);
    expect(ctx.imageDataUrl).not.toBeNull();
    expect(ctx.elementIds).toEqual([]);
    expect(ctx.notes).toContain("no_ax_permission");
    expect(ctx.text).toContain("No control list is available");
    expect(ctx.text).toContain("region targets");
  });

  it("AX snapshot failure degrades to screenshot only", async () => {
    const ctx = await captureScreenContext(deps({ ax: { trusted: true, snapshotNow: () => Promise.reject(new Error("helper died")) } }));
    expect(ctx.imageDataUrl).not.toBeNull();
    expect(ctx.notes).toContain("no_ax");
  });

  it("without Screen Recording: AX only and says so", async () => {
    const ctx = await captureScreenContext(deps({ capture: () => Promise.reject(new Error("Screen Recording permission denied")) }));
    expect(ctx.imageDataUrl).toBeNull();
    expect(ctx.elementIds.length).toBe(2);
    expect(ctx.notes).toContain("no_screen");
    expect(ctx.text).toContain("No screenshot is available");
    expect(ctx.text).toContain("Screen Recording permission denied");
  });

  it("neither source: says the screen cannot be seen, never throws", async () => {
    const ctx = await captureScreenContext(deps({ ax: null, capture: () => Promise.reject(new Error("nope")) }));
    expect(ctx.imageDataUrl).toBeNull();
    expect(ctx.text).toContain("can't see");
    expect(ctx.text).toContain("No control list");
  });

  it("hides overlays around the capture", async () => {
    const order: string[] = [];
    await captureScreenContext(
      deps({
        hiding: { withHidden: async (fn) => (order.push("hide"), fn().finally(() => order.push("show"))) },
        capture: async () => (order.push("capture"), { image: img(100, 100), display }),
      }),
    );
    expect(order).toEqual(["hide", "capture", "show"]);
  });
});

describe("composeScreenText / screenItemEvent", () => {
  it("includes the pixel-to-point scale", () => {
    const { text } = composeScreenText({ snapshot: null, image: { width: 1280, height: 800 }, display, axUnavailable: "failed", screenError: null });
    expect(text).toContain("1.125");
  });
  it("builds a deletable user item with text and image", () => {
    const ev = screenItemEvent({ text: "t", imageDataUrl: "data:image/jpeg;base64,AA", imageBytes: 1, displayId: "1", elementIds: [], notes: [] }, "scr_1") as { item: { id: string; content: Array<{ type: string }> } };
    expect(ev.item.id).toBe("scr_1");
    expect(ev.item.content.map((c) => c.type)).toEqual(["input_text", "input_image"]);
  });
});

describe("screenItemEventWithin", () => {
  const big = { text: "t", imageDataUrl: `data:image/jpeg;base64,${"A".repeat(5000)}`, imageBytes: 3750, displayId: "1", elementIds: [], notes: [] };
  it("keeps the image when it fits or no limit is known", () => {
    expect(screenItemEventWithin(big, "s", undefined).droppedImage).toBe(false);
    expect(screenItemEventWithin(big, "s", 100_000).droppedImage).toBe(false);
  });
  it("drops the image and says so when over the message budget", () => {
    const r = screenItemEventWithin(big, "s", 2000);
    expect(r.droppedImage).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r.event))).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(r.event)).toContain("too large");
  });
});

describe("active display", () => {
  const d = (id: string) => ({ id, bounds: { x: 0, y: 0, width: 100, height: 100 }, workArea: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 2 });
  const onDisplay = (id: string, over: object = {}) => ({ ...el(1), displayId: id, ...over });
  it("prefers the focused control, then the busiest display ignoring the menu bar, then cursor, then primary", () => {
    const ds = [d("1"), d("2")];
    expect(pickActiveDisplayId(snap([onDisplay("1"), onDisplay("2", { focused: true })]), ds, "1")).toBe("2");
    expect(pickActiveDisplayId(snap([onDisplay("1", { window: "MenuBar" }), onDisplay("2"), onDisplay("2")]), ds, "1")).toBe("2");
    expect(pickActiveDisplayId(null, ds, "1", "2")).toBe("2");
    expect(pickActiveDisplayId(null, ds, "1", "9")).toBe("1");
  });
  it("captures the display the active app is on", async () => {
    const asked: string[] = [];
    await captureScreenContext(
      deps({
        getDisplays: () => [d("1"), d("2")],
        ax: { trusted: true, snapshotNow: async () => snap([{ ...el(1), displayId: "2" }]) },
        capture: async (id) => (asked.push(id), { image: img(2880, 1800), display }),
      }),
    );
    expect(asked).toEqual(["2"]);
  });
});
