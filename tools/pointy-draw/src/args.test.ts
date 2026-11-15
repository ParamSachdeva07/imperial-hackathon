import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION_DIR, parseCommand, UsageError } from "./args";
import { decodeDataUrl, selectionFiles, snapshotFromFiles } from "./selection";
import { circleEvents, dwellEvents, wakeEvents } from "./gesture";

const ctx = { primaryDisplayId: "1", readJsonFile: () => ({ title: "t", spec: { kind: "sequence", steps: [] } }) };
const p = (s: string[]) => parseCommand(s, ctx);

describe("pointy-draw args (spec §8.1 commands)", () => {
  it("highlight --rect with style and label", () => {
    expect(p(["highlight", "--rect", "100,200,300,80", "--style", "spotlight", "--label", "Your photos"])).toEqual({
      kind: "tool",
      name: "highlight",
      input: { target: { kind: "rect", displayId: "1", rect: { x: 100, y: 200, width: 300, height: 80 } }, style: "spotlight", label: "Your photos" },
    });
  });
  it("highlight --element with tone", () => {
    expect(p(["highlight", "--element", "fixture.sendButton", "--tone", "warning"])).toMatchObject({
      input: { target: { kind: "element", elementId: "fixture.sendButton" }, tone: "warning" },
    });
  });
  it("point with motion and drag target", () => {
    expect(p(["point", "--element", "fixture.attach", "--motion", "double_tap"])).toMatchObject({
      name: "point_at",
      input: { motion: "double_tap" },
    });
    expect(p(["point", "--element", "a", "--drag-to-element", "b"])).toMatchObject({
      input: { motion: "drag_to", dragTo: { kind: "element", elementId: "b" } },
    });
  });
  it("steps id:label pairs (shell already stripped the quotes)", () => {
    expect(p(["steps", "fixture.newEmail:New email", "fixture.to:Who to", "fixture.send:Send"])).toMatchObject({
      name: "show_steps",
      input: { steps: [{ label: "New email" }, { label: "Who to" }, { target: { elementId: "fixture.send" }, label: "Send" }] },
    });
  });
  it("explainer --file, clear, sim, control", () => {
    expect(p(["explainer", "--file", "x.json"])).toMatchObject({ name: "show_explainer", input: { title: "t" } });
    expect(p(["clear", "all"])).toEqual({ kind: "tool", name: "clear", input: { overlayId: "all" } });
    expect(p(["sim", "move", "fixture.sendButton", "40,0"])).toEqual({ kind: "sim", body: { op: "move", elementId: "fixture.sendButton", dx: 40, dy: 0 } });
    expect(p(["select", "fixture.to"])).toEqual({ kind: "control", body: { op: "targetSelected", arg: "fixture.to" } });
    expect(p(["highlight", "--element", "a", "--expires", "5000"])).toMatchObject({ input: { expires: { ms: 5000 } } });
    expect(p(["highlight", "--point", "5,6", "--display", "9"])).toMatchObject({ input: { target: { kind: "point", displayId: "9" } } });
    expect(p(["highlight", "--polygon", "0,0 10,0 5,8"])).toMatchObject({ input: { target: { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }] } } });
  });
  it("move-avatar takes an optional position and avoid target", () => {
    expect(p(["move-avatar"])).toEqual({ kind: "tool", name: "move_avatar", input: {} });
    expect(p(["move-avatar", "bottom-left"])).toEqual({ kind: "tool", name: "move_avatar", input: { position: "bottom_left" } });
    expect(p(["move-avatar", "auto", "--element", "fixture.send"])).toMatchObject({ input: { position: "auto", avoid: { kind: "element", elementId: "fixture.send" } } });
  });
  it("fixture reopens the test app", () => {
    expect(p(["fixture"])).toEqual({ kind: "post", path: "/fixture", body: {} });
  });
  it("rejects bad usage", () => {
    expect(() => p(["highlight"])).toThrow(UsageError);
    expect(() => p(["highlight", "--rect", "1,2,3"])).toThrow(UsageError);
    expect(() => p(["steps", "nolabel"])).toThrow(UsageError);
    expect(() => p(["bogus"])).toThrow(UsageError);
    expect(() => p([])).toThrow(UsageError);
  });

  describe("gesture", () => {
    type Ev = Record<string, unknown>;
    const events = (argv: string[]): Ev[] => ((p(argv) as { body: { events: Ev[] } }).body.events);

    it("circle: ~30fps cursor around the circle, dwell ramp, then region_selected with polygon and bbox", () => {
      const evs = events(["gesture", "circle", "--center", "700,450", "--radius", "150", "--ms", "1500"]);
      expect(evs.length).toBeGreaterThan(40);
      const cursors = evs.filter((e) => e.type === "cursor_moved");
      for (const c of cursors) {
        expect(c.displayId).toBe(1);
        expect(Math.hypot((c.x as number) - 700, (c.y as number) - 450)).toBeCloseTo(150, 0);
      }
      const dwell = evs.filter((e) => e.type === "dwell_progress").map((e) => e.progress as number);
      expect(dwell.at(-1)).toBe(1);
      expect([...dwell].sort((a, b) => a - b)).toEqual(dwell);
      const last = evs.at(-1) as Ev;
      expect(last.type).toBe("region_selected");
      expect((last.polygon as unknown[]).length).toBeGreaterThanOrEqual(3);
      expect(last.bbox).toMatchObject({ width: expect.closeTo(300, -1), height: expect.closeTo(300, -1) });
      const ts = evs.map((e) => e.t as number);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
      expect(ts[1]! - ts[0]!).toBe(33);
    });
    it("dwell: cursor, ramp 0 to 1, point_selected", () => {
      const evs = events(["gesture", "dwell", "500,300"]);
      expect(evs[0]).toMatchObject({ type: "cursor_moved", x: 500, y: 300 });
      expect(evs.find((e) => e.type === "dwell_progress")?.progress).toBe(0);
      expect(evs.at(-1)).toMatchObject({ type: "point_selected", x: 500, y: 300, heldForMs: 800 });
    });
    it("point, lost, display flag and body interval", () => {
      expect(events(["gesture", "point", "10,20", "--display", "7"]).map((e) => e.displayId)).toEqual([7, 7]);
      expect(events(["gesture", "lost"])).toEqual([{ type: "hand_lost", hand: "Right", reason: "absent", t: 0 }]);
      expect(p(["gesture", "point", "1,2"])).toMatchObject({ kind: "post", path: "/gesture", body: { intervalMs: 33 } });
    });
    it("wake: wake_progress ramp 0 to 1 at the palm, then wake_requested", () => {
      const evs = events(["gesture", "wake", "700,450", "--ms", "330"]);
      const prog = evs.filter((e) => e.type === "wake_progress");
      expect(prog).toHaveLength(11);
      expect(prog[0]).toMatchObject({ progress: 0, x: 700, y: 450, displayId: 1, hand: "Right" });
      expect(prog.at(-1)?.progress).toBe(1);
      expect(evs.at(-1)).toMatchObject({ type: "wake_requested", source: "open_palm", heldForMs: 330 });
      expect(events(["gesture", "wake", "1,2"]).at(-1)).toMatchObject({ heldForMs: 700 });
      expect(() => p(["gesture", "wake"])).toThrow(UsageError);
      expect(wakeEvents({ x: 0, y: 0 }, 1)).toEqual(wakeEvents({ x: 0, y: 0 }, 1));
    });
    it("mouse: start, moves at the point, end", () => {
      const evs = events(["gesture", "mouse", "400,300"]);
      expect(evs.map((e) => e.type)).toEqual(["mouse", "mouse", "mouse", "mouse"]);
      expect(evs.map((e) => e.phase)).toEqual(["start", "move", "move", "end"]);
      for (const e of evs) expect(e).toMatchObject({ x: 400, y: 300, displayId: 1, hand: "Right" });
      expect(() => p(["gesture", "mouse"])).toThrow(UsageError);
    });
    it("click: mouse, click_progress ramp 0 to 1, then click at the point", () => {
      const evs = events(["gesture", "click", "10,20", "--ms", "330"]);
      const prog = evs.filter((e) => e.type === "click_progress").map((e) => e.progress as number);
      expect(prog[0]).toBe(0);
      expect(prog.at(-1)).toBe(1);
      expect(evs.at(-1)).toMatchObject({ type: "click", button: "left", x: 10, y: 20, displayId: 1 });
    });
    it("scroll: start, moves summing to dy, end; --dy sign and validation", () => {
      const sum = (evs: Ev[]) => evs.filter((e) => e.type === "scroll" && e.phase === "move").reduce((a, e) => a + (e.dy as number), 0);
      const evs = events(["gesture", "scroll"]);
      expect(evs[0]).toMatchObject({ type: "scroll", phase: "start" });
      expect(evs.at(-1)).toMatchObject({ type: "scroll", phase: "end" });
      expect(sum(evs)).toBeCloseTo(300, 0);
      expect(sum(events(["gesture", "scroll", "--dy", "-250"]))).toBeCloseTo(-250, 0);
      expect(sum(events(["gesture", "scroll", "--dy=-250"]))).toBeCloseTo(-250, 0);
      for (const dy of [200, 400, 600, -600, 137]) expect(sum(events(["gesture", "scroll", "--dy", String(dy)]))).toBeCloseTo(dy, 9);
      expect(() => p(["gesture", "scroll", "--dy", "0"])).toThrow(UsageError);
      expect(() => p(["gesture", "scroll", "--dy", "x"])).toThrow(UsageError);
    });
    it("session on/off", () => {
      expect(p(["gesture", "session", "on"])).toEqual({ kind: "post", path: "/gesture/session", body: { active: true } });
      expect(p(["gesture", "session", "off"])).toMatchObject({ body: { active: false } });
    });
    it("usage errors", () => {
      expect(() => p(["gesture", "circle", "--center", "1,2"])).toThrow(UsageError);
      expect(() => p(["gesture", "circle", "--center", "1,2", "--radius", "0"])).toThrow(UsageError);
      expect(() => p(["gesture", "dwell"])).toThrow(UsageError);
      expect(() => p(["gesture", "session", "maybe"])).toThrow(UsageError);
      expect(() => p(["gesture", "bogus"])).toThrow(UsageError);
      expect(() => p(["gesture", "dwell", "1,2", "--ms=-5"])).toThrow(UsageError);
    });
    it("generators are pure and deterministic", () => {
      expect(circleEvents({ x: 0, y: 0 }, 10, 1)).toEqual(circleEvents({ x: 0, y: 0 }, 10, 1));
      expect(dwellEvents({ x: 0, y: 0 }, 1, 330).filter((e) => e.type === "dwell_progress")).toHaveLength(11);
    });
  });
});

describe("selection", () => {
  it("parses the command with default and custom out dir", () => {
    expect(p(["selection"])).toEqual({ kind: "selection", outDir: DEFAULT_SELECTION_DIR });
    expect(p(["selection", "--out", "tmp/x"])).toEqual({ kind: "selection", outDir: "tmp/x" });
  });
  it("decodes a snapshot response into jpg bytes and meta without data urls", () => {
    const url = (s: string) => `data:image/jpeg;base64,${Buffer.from(s).toString("base64")}`;
    const snapshot = {
      id: "a",
      kind: "point",
      capturedAt: 1,
      displayId: "1",
      regionGlobal: { x: 0, y: 0, width: 1, height: 1 },
      full: { mime: "image/jpeg", dataUrl: url("FULL"), width: 2, height: 2, markedRegion: { x: 0, y: 0, width: 0, height: 0 } },
      focus: { mime: "image/jpeg", dataUrl: url("FOCUS"), width: 1, height: 1 },
    };
    const f = selectionFiles({ snapshot });
    expect(f?.fullJpg.toString()).toBe("FULL");
    expect(f?.focusJpg.toString()).toBe("FOCUS");
    expect(JSON.stringify(f?.meta)).not.toContain("base64");
    expect(f?.meta.focus.bytes).toBe(5);
    expect(selectionFiles({ snapshot: null })).toBeNull();
    expect(() => decodeDataUrl("data:image/png;base64,AA")).toThrow();
    // Round trip keeps the real geometry (kind, display, point) instead of inventing it.
    const back = snapshotFromFiles({ ...f!.meta, kind: "point", displayId: "987", pointGlobal: { x: 5, y: 6 } }, f!.fullJpg, f!.focusJpg);
    expect(back.kind).toBe("point");
    expect(back.displayId).toBe("987");
    expect(back.pointGlobal).toEqual({ x: 5, y: 6 });
    expect(back.full.dataUrl).toBe(snapshot.full.dataUrl);
    expect("bytes" in back.focus).toBe(false);
  });
});
