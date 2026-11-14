import { beforeEach, describe, expect, it } from "vitest";
import type { DisplayInfo, OverlayEvent, RenderItem } from "@pointy/shared/overlay";
import { OverlayService } from "./OverlayService";
import type { SceneSink, ScreenSource } from "./ports";
import { FakeBoundsProvider, FakeClock, flushPromises } from "./testing/fakeClock";
import type { ImageSource } from "./explainer/falClient";

const PRIMARY: DisplayInfo = {
  id: "1",
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
  scaleFactor: 2,
};
const LEFT: DisplayInfo = {
  id: "2",
  bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
  workArea: { x: -1920, y: -200, width: 1920, height: 1080 },
  scaleFactor: 1,
};

class FakeSink implements SceneSink {
  items: RenderItem[] = [];
  publishes = 0;
  hiddenCalls = 0;
  private painted = new Set<(ids: string[]) => void>();
  publish(items: RenderItem[]) {
    this.items = items;
    this.publishes += 1;
  }
  onPainted(cb: (ids: string[]) => void) {
    this.painted.add(cb);
    return () => this.painted.delete(cb);
  }
  paint() {
    for (const cb of this.painted) cb(this.items.map((i) => i.id));
  }
  getWindowIds() {
    return [101, 102];
  }
  async withHidden<T>(fn: () => Promise<T>) {
    this.hiddenCalls += 1;
    return fn();
  }
  byId(id: string) {
    return this.items.find((i) => i.id === id);
  }
}

class FakeScreen implements ScreenSource {
  displays = [PRIMARY, LEFT];
  private cbs = new Set<() => void>();
  getDisplays() {
    return this.displays;
  }
  getPrimaryDisplayId() {
    return "1";
  }
  onDisplaysChanged(cb: () => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  change() {
    for (const cb of this.cbs) cb();
  }
}

const el = (elementId: string) => ({ kind: "element" as const, elementId });
const rect = (x: number, y: number, width = 120, height = 40) => ({ x, y, width, height });

describe("OverlayService", () => {
  let clock: FakeClock;
  let bounds: FakeBoundsProvider;
  let sink: FakeSink;
  let screen: FakeScreen;
  let events: OverlayEvent[];
  let images: ImageSource;
  let svc: OverlayService;

  beforeEach(() => {
    clock = new FakeClock();
    bounds = new FakeBoundsProvider();
    sink = new FakeSink();
    screen = new FakeScreen();
    events = [];
    images = {
      getImage: async (prompt) => {
        await new Promise<void>((r) => clock.setTimeout(r, 50)); // images arrive later than the card
        return prompt.includes("fail") ? { ok: false, error: "timeout" } : { ok: true, dataUrl: "data:image/png;base64,AA", source: "asset" };
      },
    };
    bounds.set("send", { rect: rect(600, 400), displayId: "1" });
    bounds.set("attach", { rect: rect(300, 400), displayId: "1" });
    bounds.set("to", { rect: rect(300, 500), displayId: "1" });
    svc = new OverlayService({
      boundsProvider: bounds,
      captureProvider: { captureRegion: async () => Buffer.from([1, 2, 3]) },
      screen,
      sink,
      clock,
      imageSource: images,
      avoidRects: { getAvoidRects: () => [] },
    });
    svc.onEvent((e) => events.push(e));
  });

  const types = () => events.map((e) => e.type);

  it("rejects invalid input", async () => {
    expect(await svc.handleTool("highlight", { target: { kind: "element" } })).toEqual({ ok: false, visible: false, reason: "invalid_input" });
    expect(await svc.handleTool("draw_cat", {})).toMatchObject({ reason: "invalid_input" });
  });

  it("highlights an element: result, render item, overlay.shown after paint", async () => {
    const r = await svc.handleTool("highlight", { target: el("send"), label: "Send it", tone: "warning" });
    expect(r).toMatchObject({ ok: true, visible: true, resolvedBounds: rect(600, 400) });
    const item = sink.byId(r.overlayId!);
    expect(item).toMatchObject({ kind: "highlight", style: "ring", tone: "warning", state: "visible" });
    if (item?.kind !== "highlight") throw new Error();
    expect(item.label?.text).toBe("Send it");
    expect(item.label?.tone).toBe("warning");
    // label never covers the target
    const l = item.label!.rect;
    const t = item.target.bounds;
    expect(l.x >= t.x + t.width || l.x + l.width <= t.x || l.y >= t.y + t.height || l.y + l.height <= t.y).toBe(true);
    sink.paint();
    sink.paint();
    expect(events.filter((e) => e.type === "overlay.shown")).toHaveLength(1);
  });

  it("returns visible:false with a reason when the target is missing or off-screen", async () => {
    expect(await svc.handleTool("highlight", { target: el("ghost") })).toEqual({ ok: true, visible: false, reason: "target_not_found" });
    expect(await svc.handleTool("point_at", { target: { kind: "rect", displayId: "1", rect: rect(5000, 5000) } })).toEqual({
      ok: true,
      visible: false,
      reason: "target_offscreen",
    });
    expect(await svc.handleTool("highlight", { target: { kind: "rect", displayId: "99", rect: rect(0, 0) } })).toMatchObject({
      reason: "display_not_found",
    });
    expect(sink.items).toHaveLength(0);
  });

  it("a new highlight replaces the old one; the old fades then disappears", async () => {
    const a = await svc.handleTool("highlight", { target: el("send") });
    const b = await svc.handleTool("highlight", { target: el("attach") });
    expect(events).toContainEqual({ type: "overlay.dismissed", overlayId: a.overlayId, by: "model", reason: "replaced" });
    expect(sink.byId(a.overlayId!)?.state).toBe("exiting");
    expect(sink.byId(b.overlayId!)?.state).toBe("visible");
    clock.advance(400);
    expect(sink.byId(a.overlayId!)).toBeUndefined();
  });

  it("keeps at most 3 visible, evicting the oldest non-step annotation", async () => {
    const steps = await svc.handleTool("show_steps", { steps: [{ target: el("to"), label: "Who to" }] });
    const p1 = await svc.handleTool("point_at", { target: el("send") });
    const p2 = await svc.handleTool("point_at", { target: el("attach") });
    await svc.handleTool("point_at", { target: el("to") });
    expect(events).toContainEqual({ type: "overlay.dismissed", overlayId: p1.overlayId, by: "model", reason: "evicted" });
    expect(sink.byId(steps.overlayId!)?.state).toBe("visible");
    expect(sink.byId(p2.overlayId!)?.state).toBe("visible");
  });

  it("clear fades out (never abruptly) and reports unknown ids", async () => {
    const a = await svc.handleTool("highlight", { target: el("send") });
    expect(await svc.handleTool("clear", { overlayId: "nope" })).toEqual({ ok: false, visible: false, reason: "unknown_overlay" });
    expect(await svc.handleTool("clear", { overlayId: "all" })).toEqual({ ok: true, visible: false });
    expect(sink.byId(a.overlayId!)?.state).toBe("exiting");
    expect(events).toContainEqual({ type: "overlay.dismissed", overlayId: a.overlayId, by: "model", reason: "cleared" });
    clock.advance(299);
    expect(sink.byId(a.overlayId!)).toBeDefined();
    clock.advance(100);
    expect(sink.items).toHaveLength(0);
  });

  it("expires next_turn annotations on turn start, timers after ms, coordinate targets on context change", async () => {
    const a = await svc.handleTool("highlight", { target: el("send") });
    const b = await svc.handleTool("point_at", { target: el("attach"), expires: { ms: 1000 } });
    const c = await svc.handleTool("point_at", { target: { kind: "rect", displayId: "1", rect: rect(10, 100) }, expires: "manual" });
    svc.onTurnStart("t2");
    expect(events).toContainEqual({ type: "overlay.expired", overlayId: a.overlayId });
    clock.advance(1000);
    expect(events).toContainEqual({ type: "overlay.expired", overlayId: b.overlayId });
    svc.onContextChange();
    expect(events).toContainEqual({ type: "overlay.expired", overlayId: c.overlayId });
  });

  it("on_target_selected: reports the selection and expires", async () => {
    const a = await svc.handleTool("highlight", { target: el("send"), expires: "on_target_selected" });
    svc.onTargetSelected("attach");
    expect(types()).not.toContain("overlay.target_selected");
    svc.onTargetSelected("send");
    expect(events).toContainEqual({ type: "overlay.target_selected", overlayId: a.overlayId });
    expect(events).toContainEqual({ type: "overlay.expired", overlayId: a.overlayId });
  });

  it("follows a moving element and fades with target_lost after two misses", async () => {
    const a = await svc.handleTool("highlight", { target: el("send") });
    bounds.set("send", { rect: rect(640, 400), displayId: "1" });
    bounds.fireChange();
    await flushPromises();
    const item = sink.byId(a.overlayId!);
    expect(item?.kind === "highlight" && item.target.bounds.x).toBe(640);
    bounds.set("send", null);
    clock.advance(300);
    await flushPromises();
    clock.advance(300);
    await flushPromises();
    expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: a.overlayId });
    expect(sink.byId(a.overlayId!)?.state).toBe("exiting");
  });

  it("walks a 3-step guide: advance by selection and by tool, then completes", async () => {
    const r = await svc.handleTool("show_steps", {
      steps: [
        { target: el("attach"), label: "Attach" },
        { target: el("later"), label: "Appears later" },
        { target: el("send"), label: "Send" },
      ],
    });
    expect(r).toMatchObject({ ok: true, visible: true });
    let item = sink.byId(r.overlayId!);
    if (item?.kind !== "steps") throw new Error();
    expect(item.steps.map((s) => s.status)).toEqual(["current", "future", "future"]);
    expect(item.steps[1]!.target).toBeNull();
    expect(item.steps[0]!.labelBox?.text).toBe("Attach");

    svc.onTurnStart("t2"); // step guides survive turns by default
    svc.onTargetSelected("attach");
    expect(events).toContainEqual({ type: "steps.advanced", stepsId: r.overlayId, index: 1 });
    // step 2 appears
    bounds.set("later", { rect: rect(300, 600), displayId: "1" });
    bounds.fireChange();
    await flushPromises();
    item = sink.byId(r.overlayId!);
    if (item?.kind !== "steps") throw new Error();
    expect(item.steps[1]!.target).not.toBeNull();
    expect(item.steps[1]!.badge).not.toBeNull();

    await svc.handleTool("advance_step", { stepsId: r.overlayId });
    await svc.handleTool("advance_step", { stepsId: r.overlayId });
    expect(events).toContainEqual({ type: "steps.completed", stepsId: r.overlayId });
    item = sink.byId(r.overlayId!);
    if (item?.kind !== "steps") throw new Error();
    expect(item.steps.every((s) => s.status === "past")).toBe(true);
    clock.advance(1300);
    expect(sink.byId(r.overlayId!)?.state).toBe("exiting");
    expect(await svc.handleTool("advance_step", { stepsId: "st_missing" })).toMatchObject({ reason: "unknown_overlay" });
  });

  it("shows a template card instantly beside its anchor with a connector", async () => {
    const r = await svc.handleTool("show_explainer", {
      anchor: el("attach"),
      title: "How to attach a photo",
      spec: { kind: "sequence", steps: [{ icon: "attach", caption: "Press Attach" }, { icon: "send", caption: "Press Send" }] },
    });
    const item = sink.byId(r.overlayId!);
    if (item?.kind !== "explainer") throw new Error();
    expect(item.body.kind).toBe("sequence");
    expect(item.connector).not.toBeNull();
    expect(item.card.width).toBeLessThanOrEqual(520);
  });

  it("explainer without anchor is centred-right; missing anchor still shows the card", async () => {
    const r = await svc.handleTool("show_explainer", {
      anchor: el("ghost"),
      title: "Compare",
      spec: { kind: "compare", left: { title: "A", points: ["x"] }, right: { title: "B", points: ["y"] } },
    });
    expect(r).toMatchObject({ ok: true, visible: true, reason: "target_not_found" });
    const item = sink.byId(r.overlayId!);
    if (item?.kind !== "explainer") throw new Error();
    expect(item.connector).toBeNull();
    expect(item.card.x + item.card.width).toBeLessThanOrEqual(PRIMARY.workArea.width);
  });

  it("loads concept images per panel, falling back to an icon on failure", async () => {
    const r = await svc.handleTool("show_explainer", {
      title: "What is the cloud?",
      spec: {
        kind: "concept",
        panels: [
          { caption: "A", imagePrompt: "a cloud" },
          { caption: "B", imagePrompt: "this will fail" },
        ],
      },
    });
    let item = sink.byId(r.overlayId!);
    if (item?.kind !== "explainer" || item.body.kind !== "concept") throw new Error();
    expect(item.body.panels.map((p) => p.image.status)).toEqual(["loading", "loading"]);
    clock.advance(50);
    await flushPromises();
    item = sink.byId(r.overlayId!);
    if (item?.kind !== "explainer" || item.body.kind !== "concept") throw new Error();
    expect(item.body.panels[0]!.image.status).toBe("ready");
    expect(item.body.panels[1]!.image).toMatchObject({ status: "failed" });
    expect(events).toContainEqual({ type: "explainer.image_ready", overlayId: r.overlayId, panel: 0 });
    expect(events).toContainEqual({ type: "explainer.image_failed", overlayId: r.overlayId, panel: 1 });
  });

  it("anatomy: crops the region and maps callouts into it", async () => {
    const r = await svc.handleTool("show_explainer", {
      title: "These buttons",
      spec: {
        kind: "anatomy",
        region: { kind: "rect", displayId: "1", rect: rect(250, 380, 500, 100) },
        callouts: [
          { target: el("attach"), label: "Attach" },
          { target: el("ghost"), label: "Missing" },
        ],
      },
    });
    await flushPromises();
    const item = sink.byId(r.overlayId!);
    if (item?.kind !== "explainer" || item.body.kind !== "anatomy") throw new Error();
    expect(item.body.image).toEqual({ status: "ready", src: "data:image/png;base64,AQID" });
    expect(item.body.callouts[0]).toMatchObject({ n: 1, inside: true });
    expect(item.body.callouts[1]).toMatchObject({ n: 2, inside: false });
    expect(events).toContainEqual({ type: "explainer.image_ready", overlayId: r.overlayId, panel: 0 });
  });

  it("works on a display with a negative origin", async () => {
    const r = await svc.handleTool("point_at", { target: { kind: "rect", displayId: "2", rect: rect(-1700, 300) }, label: "Here" });
    const item = sink.byId(r.overlayId!);
    if (item?.kind !== "pointer") throw new Error();
    expect(item.entry.x).toBeLessThan(-1920); // glides in from the left edge of the left display
    expect(item.label!.rect.x).toBeGreaterThanOrEqual(LEFT.workArea.x);
  });

  it("exposes window ids and hidden capture", async () => {
    expect(svc.getOverlayWindowIds()).toEqual([101, 102]);
    expect(await svc.withOverlayHidden(async () => 7)).toBe(7);
    expect(sink.hiddenCalls).toBe(1);
  });

  describe("review round 1 regressions", () => {
    it("an explainer without an anchor survives context changes", async () => {
      const r = await svc.handleTool("show_explainer", {
        title: "Compare",
        spec: { kind: "compare", left: { title: "A", points: ["x"] }, right: { title: "B", points: ["y"] } },
      });
      svc.onContextChange();
      expect(sink.byId(r.overlayId!)?.state).toBe("visible");
      expect(types()).not.toContain("overlay.expired");
    });

    it("an element moved onto another display is laid out on that display", async () => {
      const r = await svc.handleTool("highlight", { target: el("send"), label: "Here" });
      bounds.set("send", { rect: rect(-1800, 300), displayId: "1" }); // provider reports the wrong display
      bounds.fireChange();
      await flushPromises();
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "highlight") throw new Error();
      expect(item.target.bounds.x).toBe(-1800);
      expect(item.label!.rect.x).toBeLessThan(0); // label stays on the left display
      expect(item.label!.rect.x).toBeGreaterThanOrEqual(LEFT.workArea.x);
    });

    it("an element moved off every display fades out with target_lost", async () => {
      const r = await svc.handleTool("highlight", { target: el("send") });
      bounds.set("send", { rect: rect(9000, 9000), displayId: "1" });
      bounds.fireChange();
      await flushPromises();
      expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
      expect(sink.byId(r.overlayId!)?.state).toBe("exiting");
    });

    it("an anatomy card never covers the region it explains", async () => {
      bounds.set("toolbar", { rect: rect(100, 300, 1200, 60), displayId: "1" });
      const r = await svc.handleTool("show_explainer", {
        anchor: el("attach"),
        title: "These buttons",
        spec: { kind: "anatomy", region: el("toolbar"), callouts: [{ target: el("attach"), label: "Attach" }] },
      });
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "explainer") throw new Error();
      const c = item.card;
      const overlapsToolbar = c.x < 1300 && c.x + c.width > 100 && c.y < 360 && c.y + c.height > 300;
      expect(overlapsToolbar).toBe(false);
    });

    it("spotlights render underneath other annotations", async () => {
      const p = await svc.handleTool("point_at", { target: el("attach") });
      const h = await svc.handleTool("highlight", { target: el("send"), style: "spotlight" });
      expect(sink.items.map((i) => i.id)).toEqual([h.overlayId, p.overlayId]);
    });

    it("clear reports who cleared", async () => {
      const a = await svc.handleTool("highlight", { target: el("send") });
      await svc.handleTool("clear", { overlayId: "all" }, { caller: "controller" });
      expect(events).toContainEqual({ type: "overlay.dismissed", overlayId: a.overlayId, by: "controller", reason: "cleared" });
    });

    it("loads compare images per side", async () => {
      const r = await svc.handleTool("show_explainer", {
        title: "Compare",
        spec: {
          kind: "compare",
          left: { title: "Real", points: ["a"], imagePrompt: "a tidy envelope" },
          right: { title: "Scam", points: ["b"], imagePrompt: "this will fail" },
        },
      });
      clock.advance(50);
      await flushPromises();
      expect(events).toContainEqual({ type: "explainer.image_ready", overlayId: r.overlayId, panel: 0 });
      expect(events).toContainEqual({ type: "explainer.image_failed", overlayId: r.overlayId, panel: 1 });
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "explainer" || item.body.kind !== "compare") throw new Error();
      expect(item.body.left.image?.status).toBe("ready");
      expect(item.body.right.image?.status).toBe("failed");
    });

    it("anatomy capture failure shows a fallback and reports image_failed", async () => {
      const failing = new OverlayService({
        boundsProvider: bounds,
        captureProvider: { captureRegion: async () => Promise.reject(new Error("no permission")) },
        screen,
        sink,
        clock,
      });
      const evs: OverlayEvent[] = [];
      failing.onEvent((e) => evs.push(e));
      const r = await failing.handleTool("show_explainer", {
        title: "Parts",
        spec: { kind: "anatomy", region: { kind: "rect", displayId: "1", rect: rect(250, 380, 500, 100) }, callouts: [{ target: el("attach"), label: "Attach" }] },
      });
      await flushPromises();
      expect(evs).toContainEqual({ type: "explainer.image_failed", overlayId: r.overlayId, panel: 0 });
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "explainer" || item.body.kind !== "anatomy") throw new Error();
      expect(item.body.image.status).toBe("failed");
      failing.dispose();
    });

    it("a removed display fades out annotations whose coordinates are no longer on screen", async () => {
      const r = await svc.handleTool("highlight", { target: { kind: "rect", displayId: "2", rect: rect(-1800, 300) }, expires: "manual" });
      screen.displays = [PRIMARY];
      screen.change();
      await flushPromises();
      expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
    });
  });

  describe("review round 1 (codex) regressions", () => {
    it("drops a tool call that was still resolving when clear('all') arrived", async () => {
      let release: () => void = () => {};
      bounds.gate = new Promise<void>((r) => (release = r));
      const pending = svc.handleTool("highlight", { target: el("send") });
      await svc.handleTool("clear", { overlayId: "all" });
      bounds.gate = null;
      release();
      const r = await pending;
      expect(r).toEqual({ ok: false, visible: false, reason: "replaced" });
      expect(sink.items).toHaveLength(0);
    });

    it("an annotation mixing element and coordinate targets expires on context change", async () => {
      const r = await svc.handleTool("point_at", {
        target: el("attach"),
        motion: "drag_to",
        dragTo: { kind: "rect", displayId: "1", rect: rect(800, 600) },
      });
      svc.onContextChange();
      expect(events).toContainEqual({ type: "overlay.expired", overlayId: r.overlayId });
    });

    it("advancing to a step that never appears reports target_lost after a grace period", async () => {
      const r = await svc.handleTool("show_steps", {
        steps: [
          { target: el("attach"), label: "Attach" },
          { target: el("never"), label: "Never shows" },
        ],
      });
      await svc.handleTool("advance_step", { stepsId: r.overlayId });
      clock.advance(1900);
      expect(types()).not.toContain("overlay.target_lost");
      clock.advance(200);
      expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
    });

    it("a step guide with expires on_target_selected ends when its last step is selected", async () => {
      const r = await svc.handleTool("show_steps", {
        steps: [
          { target: el("attach"), label: "Attach" },
          { target: el("send"), label: "Send" },
        ],
        expires: "on_target_selected",
      });
      svc.onTargetSelected("attach");
      expect(types()).not.toContain("overlay.expired");
      svc.onTargetSelected("send");
      expect(events).toContainEqual({ type: "steps.completed", stepsId: r.overlayId });
      clock.advance(1300); // all ✓ shown briefly, then it ends
      expect(events).toContainEqual({ type: "overlay.expired", overlayId: r.overlayId });
    });

    it("reports the real reason an explainer anchor could not be resolved", async () => {
      const r = await svc.handleTool("show_explainer", {
        anchor: { kind: "rect", displayId: "99", rect: rect(0, 0) },
        title: "T",
        spec: { kind: "sequence", steps: [{ icon: "click", caption: "a" }, { icon: "send", caption: "b" }] },
      });
      expect(r).toMatchObject({ ok: true, visible: true, reason: "display_not_found" });
    });

    it("a lost current step fades out with its ring and badge still drawn", async () => {
      const r = await svc.handleTool("show_steps", { steps: [{ target: el("attach"), label: "Attach" }] });
      bounds.set("attach", null);
      clock.advance(300);
      await flushPromises();
      clock.advance(300);
      await flushPromises();
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "steps") throw new Error();
      expect(item.state).toBe("exiting");
      expect(item.steps[0]!.target).not.toBeNull();
      expect(item.steps[0]!.badge).not.toBeNull();
    });
  });
});
