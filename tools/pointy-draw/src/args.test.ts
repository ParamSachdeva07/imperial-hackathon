import { describe, expect, it } from "vitest";
import { parseCommand, UsageError } from "./args";

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
});
