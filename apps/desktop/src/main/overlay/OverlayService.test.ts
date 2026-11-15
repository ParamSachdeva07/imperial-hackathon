import { beforeEach, describe, expect, it } from "vitest";
import type { AvatarController, DisplayInfo, OverlayEvent, Point, Rect, RenderItem } from "@pointy/shared/overlay";
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
  private imageFailed = new Set<(id: string, panel: number) => void>();
  onImageFailed(cb: (id: string, panel: number) => void) {
    this.imageFailed.add(cb);
    return () => this.imageFailed.delete(cb);
  }
  failImage(id: string, panel: number) {
    for (const cb of this.imageFailed) cb(id, panel);
  }
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

  describe("label_parts", () => {
    const part = (id: string, label: string, tone?: "info" | "warning" | "success") => ({ target: el(id), label, ...(tone ? { tone } : {}) });
    const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    it("draws a ring and a placed label per item as ONE overlay, resolvedBounds = union", async () => {
      const r = await svc.handleTool("label_parts", { items: [part("send", "Odd sender", "warning"), part("attach", "Strange link"), part("to", "Rushing you", "warning")], title: "Warning signs" });
      expect(r).toMatchObject({ ok: true, visible: true });
      expect(r.resolvedBounds).toEqual({ x: 300, y: 400, width: 420, height: 140 });
      expect(sink.items.filter((i) => i.kind === "parts")).toHaveLength(1);
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "parts") throw new Error();
      expect(item.parts.map((p) => p.label?.text)).toEqual(["Odd sender", "Strange link", "Rushing you"]);
      expect(item.parts.map((p) => p.tone)).toEqual(["warning", "info", "warning"]);
      expect(item.parts.every((p) => p.label?.tone === p.tone)).toBe(true); // a glyph per label: never colour alone
      expect(item.title?.text).toBe("Warning signs");
      // No label covers any ring or another label.
      const boxes = [...item.parts.map((p) => p.label!.rect), item.title!.rect];
      const rings = item.parts.map((p) => p.target.bounds);
      for (const [i, bx] of boxes.entries()) {
        for (const ring of rings) expect(overlap(bx, ring)).toBe(false);
        for (const other of boxes.slice(i + 1)) expect(overlap(bx, other)).toBe(false);
      }
    });

    it("places the title chip adjacent to the group's union, above its top edge, clear of every ring", async () => {
      const r = await svc.handleTool("label_parts", { items: [part("send", "Odd sender", "warning"), part("attach", "Strange link"), part("to", "Rushing you", "warning")], title: "Warning signs" });
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "parts") throw new Error();
      const union = r.resolvedBounds!;
      const title = item.title!.rect;
      expect(title.y + title.height).toBeLessThanOrEqual(union.y); // above the union's top edge
      expect(union.y - (title.y + title.height)).toBeLessThanOrEqual(24); // adjacent, not far away
      for (const p of item.parts) expect(overlap(title, p.target.bounds)).toBe(false);
    });

    it("skips items that can't be found; fails (visible:false) only if none can", async () => {
      const r = await svc.handleTool("label_parts", { items: [part("ghost", "Nope"), part("send", "Here")] });
      expect(r).toMatchObject({ ok: true, visible: true, resolvedBounds: rect(600, 400) });
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "parts") throw new Error();
      expect(item.parts.map((p) => p.index)).toEqual([1]);
      expect(await svc.handleTool("label_parts", { items: [part("ghost", "a"), part("ghost2", "b")] })).toEqual({ ok: true, visible: false, reason: "target_not_found" });
    });

    it("does not replace the current highlight, and is evicted like any drawing", async () => {
      const h = await svc.handleTool("highlight", { target: el("send") });
      const p = await svc.handleTool("label_parts", { items: [part("attach", "A"), part("to", "B")] });
      expect(sink.byId(h.overlayId!)?.state).toBe("visible");
      expect(sink.byId(p.overlayId!)?.state).toBe("visible");
      expect(events.some((e) => e.type === "overlay.dismissed")).toBe(false);
    });

    it("follows moving elements, survives losing one part, and fades when all are lost", async () => {
      const r = await svc.handleTool("label_parts", { items: [part("send", "A"), part("attach", "B")], expires: "manual" });
      bounds.set("send", { rect: rect(700, 450), displayId: "1" });
      await clock.advance(1000);
      await flushPromises();
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "parts") throw new Error();
      expect(item.parts[0]!.target.bounds).toEqual(rect(700, 450));
      expect(sink.byId(r.overlayId!)?.state).toBe("visible");
    });

    it("losing one of two parts keeps the drawing; losing both at once fades it with target_lost", async () => {
      const r = await svc.handleTool("label_parts", { items: [part("send", "A"), part("attach", "B")], expires: "manual" });
      bounds.set("send", null);
      clock.advance(300);
      await flushPromises();
      clock.advance(300);
      await flushPromises();
      expect(events).not.toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "parts") throw new Error();
      expect(item.parts.map((p) => p.index)).toEqual([1]);
      bounds.set("attach", null);
      clock.advance(300);
      await flushPromises();
      clock.advance(300);
      await flushPromises();
      expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
    });

    it("losing every part in the same pass fades with target_lost (no frozen ghost)", async () => {
      const r = await svc.handleTool("label_parts", { items: [part("send", "A"), part("attach", "B"), part("to", "C")], expires: "manual" });
      for (const id of ["send", "attach", "to"]) bounds.set(id, { rect: rect(9000, 9000), displayId: "1" }); // all off every display at once
      bounds.fireChange();
      await flushPromises();
      expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
      expect(sink.byId(r.overlayId!)?.state).toBe("exiting");
    });

    it("expires on the next turn", async () => {
      const r = await svc.handleTool("label_parts", { items: [part("send", "A")] });
      svc.onTurnStart("t2");
      expect(sink.byId(r.overlayId!)?.state).toBe("exiting");
    });
  });

  it("shows a verdict card with its tone and reasons", async () => {
    const r = await svc.handleTool("show_explainer", {
      anchor: el("attach"),
      title: "Likely a scam",
      spec: { kind: "verdict", tone: "warning", reasons: ["Fake sender", "Threatens you"] },
    });
    expect(r).toMatchObject({ ok: true, visible: true });
    const item = sink.byId(r.overlayId!);
    if (item?.kind !== "explainer") throw new Error();
    expect(item.body).toEqual({ kind: "verdict", tone: "warning", reasons: ["Fake sender", "Threatens you"] });
    expect(item.designSize.height).toBeGreaterThan(150);
    expect(item.card.width).toBeLessThanOrEqual(520);
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
      expires: "on_target_selected", // multi-turn guide that ends when completed (as the description asks)
    });
    expect(r).toMatchObject({ ok: true, visible: true });
    let item = sink.byId(r.overlayId!);
    if (item?.kind !== "steps") throw new Error();
    expect(item.steps.map((s) => s.status)).toEqual(["current", "future", "future"]);
    expect(item.steps[1]!.target).toBeNull();
    // One step at a time: the number lives in the label; the next step isn't on screen yet → no hint.
    expect(item.steps[0]!.labelBox).toMatchObject({ text: "Step 1 of 3 · Attach", tone: "info" });
    expect(item.steps.map((s) => s.labelBox !== null)).toEqual([true, false, false]);
    expect(item.steps.every((s) => s.hint === null)).toBe(true);

    svc.onTurnStart("t2"); // survives turns
    svc.onTargetSelected("attach");
    expect(events).toContainEqual({ type: "steps.advanced", stepsId: r.overlayId, index: 1 });
    // step 2 appears
    bounds.set("later", { rect: rect(300, 600), displayId: "1" });
    bounds.fireChange();
    await flushPromises();
    item = sink.byId(r.overlayId!);
    if (item?.kind !== "steps") throw new Error();
    expect(item.steps[1]!.target).not.toBeNull();
    // Now on step 2: its label carries the number; only step 3 (the next one) has the faint hint.
    expect(item.steps[1]!.labelBox?.text).toBe("Step 2 of 3 · Appears later");
    expect(item.steps.map((s) => s.labelBox !== null)).toEqual([false, true, false]);
    expect(item.steps.map((s) => s.hint !== null)).toEqual([false, false, true]);

    await svc.handleTool("advance_step", { stepsId: r.overlayId });
    await svc.handleTool("advance_step", { stepsId: r.overlayId });
    expect(events).toContainEqual({ type: "steps.completed", stepsId: r.overlayId });
    item = sink.byId(r.overlayId!);
    if (item?.kind !== "steps") throw new Error();
    expect(item.steps.every((s) => s.status === "past")).toBe(true);
    // Finished: "✓ All done" on the last control, no hint, then it fades after ~1.5 s.
    expect(item.steps[2]!.labelBox).toMatchObject({ text: "All done", tone: "success" });
    expect(item.steps.every((s) => s.hint === null)).toBe(true);
    clock.advance(1400);
    expect(sink.byId(r.overlayId!)?.state).toBe("visible");
    clock.advance(200);
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
      expect(r).toEqual({ ok: false, visible: false, reason: "cancelled" });
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
      clock.advance(1600); // "All done" shown briefly, then it ends
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

    it("a lost current step fades out with its ring and label still drawn", async () => {
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
      expect(item.steps[0]!.labelBox).not.toBeNull();
    });
  });

  describe("review round 2 (codex) regressions", () => {
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    it("an anatomy card without an anchor still avoids its region", async () => {
      const region = rect(700, 300, 700, 300); // under where centred-right would land
      const r = await svc.handleTool("show_explainer", {
        title: "Parts",
        spec: { kind: "anatomy", region: { kind: "rect", displayId: "1", rect: region }, callouts: [{ target: el("attach"), label: "Attach" }] },
      });
      const item = sink.byId(r.overlayId!);
      if (item?.kind !== "explainer") throw new Error();
      expect(overlaps(item.card, region)).toBe(false);
    });

    it("an anatomy card of a coordinate region expires on context change", async () => {
      const r = await svc.handleTool("show_explainer", {
        anchor: el("attach"),
        title: "Parts",
        spec: { kind: "anatomy", region: { kind: "rect", displayId: "1", rect: rect(250, 380, 500, 100) }, callouts: [{ target: el("attach"), label: "Attach" }] },
      });
      svc.onContextChange();
      expect(events).toContainEqual({ type: "overlay.expired", overlayId: r.overlayId });
    });

    it("an element left on a removed display is lost", async () => {
      bounds.set("leftbtn", { rect: rect(-1500, 300), displayId: "2" });
      const r = await svc.handleTool("highlight", { target: el("leftbtn") });
      screen.displays = [PRIMARY];
      screen.change();
      await flushPromises();
      expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
    });

    it("a context change while a coordinate call is resolving drops it", async () => {
      let release: () => void = () => {};
      bounds.gate = new Promise<void>((res) => (release = res));
      const pending = svc.handleTool("point_at", { target: el("attach"), motion: "drag_to", dragTo: { kind: "rect", displayId: "1", rect: rect(800, 600) } });
      svc.onContextChange();
      bounds.gate = null;
      release();
      expect(await pending).toEqual({ ok: false, visible: false, reason: "cancelled" });
    });

    it("a completed step guide with an explicit manual lifetime stays until cleared", async () => {
      const r = await svc.handleTool("show_steps", { steps: [{ target: el("attach"), label: "Attach" }], expires: "manual" });
      await svc.handleTool("advance_step", { stepsId: r.overlayId });
      clock.advance(5000);
      expect(sink.byId(r.overlayId!)?.state).toBe("visible");
    });

    it("later labels avoid an earlier pointer's resting arrow", async () => {
      const p = await svc.handleTool("point_at", { target: el("attach") });
      const h = await svc.handleTool("highlight", { target: el("to"), label: "Who it is for" });
      const ptr = sink.byId(p.overlayId!);
      const hl = sink.byId(h.overlayId!);
      if (ptr?.kind !== "pointer" || hl?.kind !== "highlight") throw new Error();
      const rad = (ptr.angle * Math.PI) / 180;
      const body = { x: ptr.rest.x - Math.cos(rad) * 48 - 48, y: ptr.rest.y - Math.sin(rad) * 48 - 48, width: 96, height: 96 };
      expect(overlaps(hl.label!.rect, body)).toBe(false);
    });
  });

  it("re-lays a tall card out with smaller pictures before shrinking its text", async () => {
    const small: DisplayInfo = { id: "1", bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 25, width: 1280, height: 695 }, scaleFactor: 2 };
    screen.displays = [small];
    const r = await svc.handleTool("show_explainer", {
      title: "What is the cloud?",
      spec: {
        kind: "concept",
        panels: [
          { caption: "Your photos are copied from your computer", imagePrompt: "a" },
          { caption: "to a safe building far away", imagePrompt: "b" },
          { caption: "so you can see them anywhere", imagePrompt: "c" },
        ],
      },
    });
    const item = sink.byId(r.overlayId!);
    if (item?.kind !== "explainer") throw new Error();
    expect(item.imageScale).toBeLessThan(1);
    expect(item.scale).toBe(1); // text stays at full size (fontMin)
    expect(item.card.y + item.card.height).toBeLessThanOrEqual(720);
  });

  it("an explainer shown without its (missing) anchor stays visible — it is not 'lost' later", async () => {
    const r = await svc.handleTool("show_explainer", {
      anchor: el("ghost"),
      title: "T",
      spec: { kind: "sequence", steps: [{ icon: "click", caption: "a" }, { icon: "send", caption: "b" }] },
    });
    for (let k = 0; k < 4; k++) {
      clock.advance(300);
      await flushPromises();
    }
    expect(sink.byId(r.overlayId!)?.state).toBe("visible");
    expect(types()).not.toContain("overlay.target_lost");
  });

  it("dispose cancels a pending step-appear check", async () => {
    const r = await svc.handleTool("show_steps", { steps: [{ target: el("attach"), label: "A" }, { target: el("never"), label: "B" }] });
    await svc.handleTool("advance_step", { stepsId: r.overlayId });
    svc.dispose();
    clock.advance(5000);
    expect(types()).not.toContain("overlay.target_lost");
  });

  describe("review round 3 (codex) regressions", () => {
    it("a drag demo whose destination's display is removed is lost, not silently turned into a tap", async () => {
      const r = await svc.handleTool("point_at", {
        target: el("attach"),
        motion: "drag_to",
        dragTo: { kind: "rect", displayId: "2", rect: rect(-1500, 300) },
        expires: "manual",
      });
      screen.displays = [PRIMARY];
      screen.change();
      await flushPromises();
      expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
    });

    it("an anatomy card with a coordinate callout expires on context change", async () => {
      bounds.set("toolbar", { rect: rect(100, 300, 900, 60), displayId: "1" });
      const r = await svc.handleTool("show_explainer", {
        title: "Parts",
        spec: {
          kind: "anatomy",
          region: el("toolbar"),
          callouts: [{ target: { kind: "point", displayId: "1", point: { x: 150, y: 320 } }, label: "Here" }],
        },
      });
      svc.onContextChange();
      expect(events).toContainEqual({ type: "overlay.expired", overlayId: r.overlayId });
    });

    it("on_target_selected: clicking the LAST step's control early does not end an unfinished guide", async () => {
      const r = await svc.handleTool("show_steps", {
        steps: [
          { target: el("attach"), label: "Attach" },
          { target: el("send"), label: "Send" },
        ],
        expires: "on_target_selected",
      });
      svc.onTargetSelected("send"); // not the current step
      expect(sink.byId(r.overlayId!)?.state).toBe("visible");
      expect(types()).not.toContain("overlay.expired");
    });

    it("a new turn does not cancel an in-flight call that outlives turns", async () => {
      let release: () => void = () => {};
      bounds.gate = new Promise<void>((res) => (release = res));
      const pending = svc.handleTool("highlight", { target: el("send"), expires: "manual" });
      svc.onTurnStart("t2");
      bounds.gate = null;
      release();
      expect(await pending).toMatchObject({ ok: true, visible: true });
    });

    it("a new turn does cancel an in-flight next_turn call", async () => {
      let release: () => void = () => {};
      bounds.gate = new Promise<void>((res) => (release = res));
      const pending = svc.handleTool("highlight", { target: el("send") });
      svc.onTurnStart("t2");
      bounds.gate = null;
      release();
      expect(await pending).toEqual({ ok: false, visible: false, reason: "cancelled" });
    });

    it("step guides default to the contract's next_turn lifetime", async () => {
      const r = await svc.handleTool("show_steps", { steps: [{ target: el("attach"), label: "Attach" }] });
      svc.onTurnStart("t2");
      expect(events).toContainEqual({ type: "overlay.expired", overlayId: r.overlayId });
    });
  });

  describe("simplify pass: unified rules", () => {
    it("a card beside an anchor fades when that anchor disappears (element lost or display removed alike)", async () => {
      const r = await svc.handleTool("show_explainer", {
        anchor: el("attach"),
        title: "T",
        spec: { kind: "sequence", steps: [{ icon: "click", caption: "a" }, { icon: "send", caption: "b" }] },
        expires: "manual",
      });
      bounds.set("attach", null);
      clock.advance(300);
      await flushPromises();
      clock.advance(300);
      await flushPromises();
      expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
    });

    it("an unanchored card reports no resolvedBounds (nothing on screen is 'the target')", async () => {
      const r = await svc.handleTool("show_explainer", {
        title: "T",
        spec: { kind: "sequence", steps: [{ icon: "click", caption: "a" }, { icon: "send", caption: "b" }] },
      });
      expect(r.ok).toBe(true);
      expect(r.resolvedBounds).toBeUndefined();
    });

    it("a context change cancels an in-flight call that would expire on it (expires: context_change)", async () => {
      let release: () => void = () => {};
      bounds.gate = new Promise<void>((res) => (release = res));
      const pending = svc.handleTool("highlight", { target: el("send"), expires: "context_change" });
      svc.onContextChange();
      bounds.gate = null;
      release();
      expect(await pending).toEqual({ ok: false, visible: false, reason: "cancelled" });
    });
  });

  it("a drawing that loses its target on a display change fades exactly where it was", async () => {
    bounds.set("leftbtn2", { rect: rect(-1500, 300), displayId: "2" });
    const h = await svc.handleTool("highlight", { target: el("leftbtn2"), label: "Here", expires: "manual" });
    const before = sink.byId(h.overlayId!);
    if (before?.kind !== "highlight") throw new Error();
    screen.displays = [PRIMARY];
    screen.change();
    await flushPromises();
    const after = sink.byId(h.overlayId!);
    if (after?.kind !== "highlight") throw new Error();
    expect(after.state).toBe("exiting");
    expect(after.label?.rect).toEqual(before.label?.rect); // frozen, not re-placed on the primary display
    expect(after.target.bounds).toEqual(before.target.bounds);
  });

  describe("fixes pass: lifecycle", () => {
    it("rejects a drag lesson without a destination", async () => {
      expect(await svc.handleTool("point_at", { target: el("attach"), motion: "drag_to" })).toEqual({ ok: false, visible: false, reason: "invalid_input" });
    });

    it("an anatomy card needs its region on screen", async () => {
      const r = await svc.handleTool("show_explainer", {
        title: "Parts",
        spec: { kind: "anatomy", region: el("ghost"), callouts: [{ target: el("attach"), label: "Attach" }] },
      });
      expect(r).toEqual({ ok: true, visible: false, reason: "target_not_found" });
    });

    it("an anatomy card fades when the region it explains goes away", async () => {
      bounds.set("toolbar", { rect: rect(100, 300, 900, 60), displayId: "1" });
      const r = await svc.handleTool("show_explainer", {
        title: "Parts",
        spec: { kind: "anatomy", region: el("toolbar"), callouts: [{ target: el("attach"), label: "Attach" }] },
        expires: "manual",
      });
      bounds.set("toolbar", null);
      clock.advance(300);
      await flushPromises();
      clock.advance(300);
      await flushPromises();
      expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
    });

    it("redraws once per anchor check, however many anchors moved", async () => {
      await svc.handleTool("highlight", { target: el("send"), expires: "manual" });
      await svc.handleTool("point_at", { target: el("attach"), expires: "manual" });
      const before = sink.publishes;
      bounds.set("send", { rect: rect(640, 400), displayId: "1" });
      bounds.set("attach", { rect: rect(340, 400), displayId: "1" });
      bounds.fireChange();
      await flushPromises();
      expect(sink.publishes - before).toBe(1);
    });

    it("re-checks a call whose display went away while it was resolving", async () => {
      bounds.set("leftbtn", { rect: rect(-1500, 300), displayId: "2" });
      let release: () => void = () => {};
      bounds.gate = new Promise<void>((res) => (release = res));
      const pending = svc.handleTool("highlight", { target: el("leftbtn"), expires: "manual" });
      screen.displays = [PRIMARY];
      screen.change();
      bounds.gate = null;
      release();
      const r = await pending;
      await flushPromises();
      // Either the lookup already saw the new displays (nothing drawn), or it drew against the old
      // ones and the re-check then fades it — never a drawing left on a display that is gone.
      if (r.visible) expect(events).toContainEqual({ type: "overlay.target_lost", overlayId: r.overlayId });
      else expect(r.reason).toBe("target_offscreen");
      expect(sink.items.filter((i) => i.state === "visible")).toHaveLength(0);
    });
  });

  describe("fixes pass: layout", () => {
    it("a label keeps its side when its target moves a little", async () => {
      const r = await svc.handleTool("highlight", { target: el("send"), label: "Send it", expires: "manual" });
      const before = sink.byId(r.overlayId!);
      if (before?.kind !== "highlight" || !before.label) throw new Error();
      const sideOf = (lab: Rect, t: Rect) => (lab.x >= t.x + t.width ? "right" : lab.x + lab.width <= t.x ? "left" : lab.y >= t.y ? "below" : "above");
      const side = sideOf(before.label.rect, before.target.bounds);
      bounds.set("send", { rect: rect(610, 405), displayId: "1" });
      bounds.fireChange();
      await flushPromises();
      const after = sink.byId(r.overlayId!);
      if (after?.kind !== "highlight" || !after.label) throw new Error();
      expect(sideOf(after.label.rect, after.target.bounds)).toBe(side);
    });

    it("moves an older card off a control that a new highlight points at", async () => {
      const card = await svc.handleTool("show_explainer", {
        anchor: el("attach"),
        title: "How to attach",
        spec: { kind: "sequence", steps: [{ icon: "attach", caption: "Press Attach" }, { icon: "send", caption: "Press Send" }] },
        expires: "manual",
      });
      const c = sink.byId(card.overlayId!);
      if (c?.kind !== "explainer") throw new Error();
      // Put a control right under the card, then highlight it.
      bounds.set("under", { rect: { x: c.card.x + 20, y: c.card.y + 20, width: 80, height: 30 }, displayId: "1" });
      await svc.handleTool("highlight", { target: el("under"), expires: "manual" });
      const moved = sink.byId(card.overlayId!);
      if (moved?.kind !== "explainer") throw new Error();
      const u = { x: c.card.x + 20, y: c.card.y + 20, width: 80, height: 30 };
      const overlaps = moved.card.x < u.x + u.width && u.x < moved.card.x + moved.card.width && moved.card.y < u.y + u.height && u.y < moved.card.y + moved.card.height;
      expect(overlaps).toBe(false);
    });

    it("moves an older label off the control a new explainer card is about", async () => {
      const hl = await svc.handleTool("highlight", { target: el("send"), label: "Send it", expires: "manual" });
      const h = sink.byId(hl.overlayId!);
      if (h?.kind !== "highlight" || !h.label) throw new Error();
      // A control right under the label, then a card explaining it.
      const u = { x: h.label.rect.x + 10, y: h.label.rect.y + 4, width: 60, height: 30 };
      bounds.set("under", { rect: u, displayId: "1" });
      await svc.handleTool("show_explainer", {
        anchor: el("under"),
        title: "What this does",
        spec: { kind: "sequence", steps: [{ icon: "attach", caption: "Press it" }, { icon: "send", caption: "Then Send" }] },
        expires: "manual",
      });
      const moved = sink.byId(hl.overlayId!);
      if (moved?.kind !== "highlight" || !moved.label) throw new Error();
      const l = moved.label.rect;
      expect(l.x < u.x + u.width && u.x < l.x + l.width && l.y < u.y + u.height && u.y < l.y + l.height).toBe(false);
    });
  });

  it("a picture the renderer can't decode falls back to its icon and reports image_failed once", async () => {
    const r = await svc.handleTool("show_explainer", {
      title: "What is the cloud?",
      spec: { kind: "concept", panels: [{ caption: "A", imagePrompt: "a cloud" }] },
    });
    clock.advance(50);
    await flushPromises();
    sink.failImage(r.overlayId!, 0);
    sink.failImage(r.overlayId!, 0); // a second window reporting the same picture
    const item = sink.byId(r.overlayId!);
    if (item?.kind !== "explainer" || item.body.kind !== "concept") throw new Error();
    expect(item.body.panels[0]!.image).toMatchObject({ status: "failed" });
    expect(events.filter((e) => e.type === "explainer.image_failed")).toHaveLength(1);
  });
});

class FakeAvatar implements AvatarController {
  bounds: Rect | null;
  movable = true;
  moves: Point[] = [];
  /** When set, moveTo fails (resolves null). */
  failMoves = false;
  constructor(bounds: Rect) {
    this.bounds = bounds;
  }
  getBounds() {
    return this.bounds;
  }
  isMovable() {
    return this.movable && this.bounds !== null;
  }
  async moveTo(p: Point) {
    this.moves.push(p);
    if (!this.bounds || this.failMoves) return null;
    this.bounds = { ...this.bounds, x: p.x, y: p.y };
    return this.bounds;
  }
  getAvoidRects() {
    return this.bounds && this.movable ? [this.bounds] : [];
  }
}

describe("OverlayService avatar (move_avatar and auto-dodge)", () => {
  // 320x400 avatar in the top-right of PRIMARY's work area, 24 from the edges.
  const TOP_RIGHT: Rect = { x: 1096, y: 49, width: 320, height: 400 };
  let clock: FakeClock;
  let bounds: FakeBoundsProvider;
  let sink: FakeSink;
  let avatar: FakeAvatar;
  let svc: OverlayService;

  const build = (withAvatar = true) => {
    svc = new OverlayService({
      boundsProvider: bounds,
      captureProvider: { captureRegion: async () => Buffer.from([1]) },
      screen: new FakeScreen(),
      sink,
      clock,
      avoidRects: { getAvoidRects: () => avatar.getAvoidRects() },
      ...(withAvatar ? { avatar } : {}),
    });
  };

  beforeEach(() => {
    clock = new FakeClock();
    bounds = new FakeBoundsProvider();
    sink = new FakeSink();
    avatar = new FakeAvatar(TOP_RIGHT);
    bounds.set("under", { rect: rect(1150, 100), displayId: "1" }); // under the avatar
    bounds.set("near", { rect: rect(1096 - 120 - 8, 100), displayId: "1" }); // 8 DIP left of it
    bounds.set("clear", { rect: rect(200, 500), displayId: "1" });
    bounds.set("clear2", { rect: rect(200, 600), displayId: "1" });
    build();
  });

  it("move_avatar moves to a corner and returns the new bounds", async () => {
    const r = await svc.handleTool("move_avatar", { position: "bottom_left" });
    expect(avatar.moves).toEqual([{ x: 24, y: 476 }]);
    expect(r).toEqual({ ok: true, visible: true, resolvedBounds: { ...TOP_RIGHT, x: 24, y: 476 } });
  });

  it("move_avatar auto picks a corner away from what is on screen and re-lays out drawings", async () => {
    const h = await svc.handleTool("highlight", { target: el("clear"), label: "Here" });
    avatar.bounds = { ...TOP_RIGHT, x: 100, y: 450 }; // dropped onto the highlight's neighbourhood
    const before = sink.publishes;
    const r = await svc.handleTool("move_avatar", {});
    expect(r).toMatchObject({ ok: true, visible: true });
    expect(avatar.moves).toHaveLength(1);
    const to = avatar.moves[0]!;
    const moved = { ...TOP_RIGHT, x: to.x, y: to.y };
    const target = rect(200, 500);
    expect(to.x < target.x + target.width && target.x < to.x + moved.width && to.y < target.y + target.height && target.y < to.y + moved.height).toBe(false);
    expect(sink.publishes).toBeGreaterThan(before);
    expect(h.ok).toBe(true);
  });

  it("move_avatar keeps clear of the avoid target", async () => {
    avatar.bounds = { ...TOP_RIGHT, x: 24, y: 476 }; // bottom-left, clear of everything
    bounds.set("spot", { rect: rect(1200, 600), displayId: "1" }); // bottom-right area is where it would go next
    const r = await svc.handleTool("move_avatar", { avoid: el("spot") });
    expect(r.ok).toBe(true);
    expect(avatar.moves).toEqual([]); // already clear of `spot`: stays put
    avatar.bounds = { ...TOP_RIGHT, x: 1096, y: 476 };
    await svc.handleTool("move_avatar", { avoid: el("spot") });
    expect(avatar.moves).toHaveLength(1);
    expect(avatar.moves[0]!.x).toBe(24);
  });

  it("move_avatar ignores an avoid target that does not resolve", async () => {
    const r = await svc.handleTool("move_avatar", { position: "top_left", avoid: el("ghost") });
    expect(r).toMatchObject({ ok: true, visible: true });
    expect(avatar.moves).toEqual([{ x: 24, y: 49 }]);
  });

  it("move_avatar reports display_not_found for an unknown display", async () => {
    expect(await svc.handleTool("move_avatar", { displayId: "99" })).toEqual({ ok: false, visible: false, reason: "display_not_found" });
  });

  it("move_avatar is unavailable when collapsed, grabbed, failing, or with no controller", async () => {
    const unavailable = { ok: false, visible: false, reason: "avatar_unavailable" };
    avatar.bounds = null; // collapsed / unknown
    expect(await svc.handleTool("move_avatar", {})).toEqual(unavailable);
    avatar.bounds = TOP_RIGHT;
    avatar.movable = false; // being dragged
    expect(await svc.handleTool("move_avatar", {})).toEqual(unavailable);
    avatar.movable = true;
    avatar.failMoves = true;
    expect(await svc.handleTool("move_avatar", { position: "top_left" })).toEqual(unavailable);
    build(false);
    expect(await svc.handleTool("move_avatar", {})).toEqual(unavailable);
  });

  it("auto-dodge: a highlight under the avatar moves it away, without changing the tool result", async () => {
    const r = await svc.handleTool("highlight", { target: el("under") });
    expect(r).toMatchObject({ ok: true, visible: true, resolvedBounds: rect(1150, 100) });
    expect(r.reason).toBeUndefined();
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
    expect(avatar.moves[0]).not.toEqual({ x: TOP_RIGHT.x, y: TOP_RIGHT.y });
  });

  it("auto-dodge also fires when the target is within 16 DIP of the avatar", async () => {
    await svc.handleTool("highlight", { target: el("near") });
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
    // ...and it really cleared the inflated target.
    const t = rect(1096 - 120 - 8, 100);
    const a = avatar.bounds!;
    const gap = Math.max(a.x - (t.x + t.width), t.x - (a.x + a.width), a.y - (t.y + t.height), t.y - (a.y + a.height));
    expect(gap).toBeGreaterThanOrEqual(16);
  });

  it("no dodge when the drawing is nowhere near the avatar, or the avatar is not movable", async () => {
    await svc.handleTool("highlight", { target: el("clear") });
    await flushPromises();
    expect(avatar.moves).toEqual([]);
    avatar.movable = false;
    await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    expect(avatar.moves).toEqual([]);
    avatar.bounds = null;
    avatar.movable = true;
    await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    expect(avatar.moves).toEqual([]);
  });

  it("auto-dodge is rate-limited to one move per 1500 ms", async () => {
    await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
    avatar.bounds = TOP_RIGHT; // something put it back under the target
    clock.advance(1000);
    await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    expect(avatar.moves).toHaveLength(1); // too soon
    clock.advance(600);
    await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    expect(avatar.moves).toHaveLength(2);
  });

  it("explicit move_avatar is not rate-limited and does not block on auto-dodge", async () => {
    await svc.handleTool("highlight", { target: el("under") });
    await svc.handleTool("move_avatar", { position: "top_left" });
    await flushPromises();
    expect(avatar.moves.at(-1)).toEqual({ x: 24, y: 49 });
  });

  it("auto-dodge: advance_step onto a covered control moves the avatar", async () => {
    const r = await svc.handleTool("show_steps", { steps: [{ target: el("clear"), label: "A" }, { target: el("under"), label: "B" }] });
    await flushPromises();
    expect(avatar.moves).toEqual([]);
    await svc.handleTool("advance_step", { stepsId: r.overlayId });
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
  });

  it("auto-dodge: selecting the current step's control (advancing the guide) moves the avatar", async () => {
    await svc.handleTool("show_steps", { steps: [{ target: el("clear"), label: "A" }, { target: el("under"), label: "B" }] });
    await flushPromises();
    expect(avatar.moves).toEqual([]);
    svc.onTargetSelected("clear");
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
  });

  it("auto-dodge: a check inside the rate window runs once, trailing, at the window end", async () => {
    await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
    avatar.bounds = TOP_RIGHT;
    clock.advance(500);
    await svc.handleTool("highlight", { target: el("under") }); // second overlapping drawing
    await svc.handleTool("highlight", { target: el("near") });
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
    clock.advance(999);
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
    clock.advance(1);
    await flushPromises();
    expect(avatar.moves).toHaveLength(2); // exactly one trailing move
    clock.advance(5000);
    await flushPromises();
    expect(avatar.moves).toHaveLength(2);
  });

  it("auto-dodge: a failed move does not consume the rate limit", async () => {
    avatar.failMoves = true;
    await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
    avatar.failMoves = false;
    await svc.handleTool("highlight", { target: el("near") });
    await flushPromises();
    expect(avatar.moves).toHaveLength(2); // retried immediately, no wait
  });

  it("auto-dodge: a drawing cleared while the move is queued causes no move", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    avatar.moveTo = async (p) => {
      avatar.moves.push(p);
      await gate; // holds the avatar chain; the avatar itself stays where it is
      return avatar.bounds;
    };
    const pending = svc.handleTool("move_avatar", { position: "bottom_left" });
    await flushPromises();
    const r = await svc.handleTool("highlight", { target: el("under") }); // covered, check queued behind the move
    await svc.handleTool("clear", { overlayId: r.overlayId });
    release();
    await pending;
    await flushPromises();
    expect(avatar.moves).toHaveLength(1); // only the explicit move; the dodge saw no live drawing
  });

  it("dispose stops a pending move and the trailing timer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    avatar.moveTo = async (p) => {
      avatar.moves.push(p);
      await gate;
      return { ...TOP_RIGHT, x: p.x, y: p.y };
    };
    await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
    const published = sink.publishes;
    svc.dispose();
    release();
    await flushPromises();
    expect(sink.publishes).toBe(published);
    // after dispose nothing new is queued
    expect(await svc.handleTool("move_avatar", { position: "top_left" })).toMatchObject({ reason: "avatar_unavailable" });
    expect(avatar.moves).toHaveLength(1);
  });

  it("dispose cancels the trailing check", async () => {
    await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    avatar.bounds = TOP_RIGHT;
    clock.advance(500);
    await svc.handleTool("highlight", { target: el("near") });
    await flushPromises();
    svc.dispose();
    clock.advance(5000);
    await flushPromises();
    expect(avatar.moves).toHaveLength(1);
  });

  it("a failing avatar never breaks drawing", async () => {
    avatar.moveTo = async () => {
      throw new Error("boom");
    };
    const r = await svc.handleTool("highlight", { target: el("under") });
    await flushPromises();
    expect(r).toMatchObject({ ok: true, visible: true });
    expect(await svc.handleTool("move_avatar", { position: "top_left" })).toMatchObject({ reason: "avatar_unavailable" });
  });
});
