import { describe, expect, it } from "vitest";
import { parseCommand, UsageError } from "./args";
import { circleEvents, dwellEvents } from "./gesture";

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
