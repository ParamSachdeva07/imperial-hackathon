import { describe, expect, it } from "vitest";
import { combineCaptureHiding, createCaptureHiding, createCaptureHidingRegistry, hideFeedbackDuringCapture, type HideableWindow } from "./captureHiding";

function fakeWin(visible = true, id = "window:42:0") {
  const log: string[] = [];
  let vis = visible;
  let destroyed = false;
  const w: HideableWindow & { log: string[]; destroy(): void } = {
    log,
    isDestroyed: () => destroyed,
    isVisible: () => vis,
    getMediaSourceId: () => id,
    hide: () => ((vis = false), log.push("hide")),
    showInactive: () => ((vis = true), log.push("show")),
    destroy: () => (destroyed = true),
  };
  return w;
}
const noDelay = () => Promise.resolve();

describe("createCaptureHiding", () => {
  it("reports the media source id and none without a window", () => {
    const w = fakeWin();
    expect(createCaptureHiding(() => w).getWindowIds()).toEqual([42]);
    expect(createCaptureHiding(() => null).getWindowIds()).toEqual([]);
    w.destroy();
    expect(createCaptureHiding(() => w).getWindowIds()).toEqual([]);
  });

  it("hides during fn, restores after (also on throw), nested calls restore once", async () => {
    const w = fakeWin();
    const h = createCaptureHiding(() => w, noDelay);
    const seen: boolean[] = [];
    await h.withHidden(async () => {
      await h.withHidden(async () => void seen.push(w.isVisible()));
      seen.push(w.isVisible());
    });
    expect(seen).toEqual([false, false]);
    expect(w.log).toEqual(["hide", "show"]);
    await expect(h.withHidden(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(w.isVisible()).toBe(true);
  });

  it("does not show a window that was already hidden", async () => {
    const w = fakeWin(false);
    await createCaptureHiding(() => w, noDelay).withHidden(async () => 1);
    expect(w.log).toEqual([]);
  });
});

describe("combineCaptureHiding", () => {
  it("unions ids and nests hiding around fn", async () => {
    const order: string[] = [];
    const part = (name: string, ids: number[]) => ({
      getWindowIds: () => ids,
      withHidden: async <T,>(fn: () => Promise<T>) => (order.push(`${name}+`), fn().finally(() => order.push(`${name}-`))),
    });
    const c = combineCaptureHiding(part("a", [1]), part("b", [2, 3]));
    expect(c.getWindowIds()).toEqual([1, 2, 3]);
    expect(await c.withHidden(async () => (order.push("fn"), 7))).toBe(7);
    expect(order).toEqual(["a+", "b+", "fn", "b-", "a-"]);
  });
});

describe("createCaptureHidingRegistry", () => {
  it("covers windows registered later and forgets unregistered ones", async () => {
    const reg = createCaptureHidingRegistry(noDelay);
    const a = fakeWin(true, "window:1:0");
    const b = fakeWin(true, "window:2:0");
    const offA = reg.register(() => a);
    reg.register(() => b);
    expect(reg.getWindowIds()).toEqual([1, 2]);
    await reg.withHidden(async () => {
      expect(a.log).toEqual(["hide"]);
      expect(b.log).toEqual(["hide"]);
    });
    expect(a.log).toEqual(["hide", "show"]);
    offA();
    expect(reg.getWindowIds()).toEqual([2]);
  });
  it("runs fn directly with nothing registered", async () => {
    expect(await createCaptureHidingRegistry(noDelay).withHidden(async () => 7)).toBe(7);
  });
});

describe("hideFeedbackDuringCapture", () => {
  it("captures with the feedback window hidden", async () => {
    const w = fakeWin();
    const reg = createCaptureHidingRegistry(noDelay);
    reg.register(() => w);
    let hiddenDuring = false;
    const inner = { captureRegion: async () => ((hiddenDuring = !w.isVisible()), Buffer.from("png")) };
    const png = await hideFeedbackDuringCapture(inner, reg).captureRegion("1", { x: 0, y: 0, width: 1, height: 1 });
    expect(hiddenDuring).toBe(true);
    expect(w.isVisible()).toBe(true);
    expect(png.toString()).toBe("png");
  });
});
