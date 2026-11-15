import { describe, expect, it } from "vitest";
import {
  AdvanceStepInput,
  ClearInput,
  Expiry,
  HighlightInput,
  LabelPartsInput,
  MagnifyInput,
  MoveAvatarInput,
  OverlayEvent,
  PointAtInput,
  PreviewActionInput,
  Rect,
  ShowExplainerInput,
  ShowStepsInput,
  Target,
  ToolResult,
  ToolResultReason,
} from "./schemas";

const el = (elementId: string) => ({ kind: "element" as const, elementId });
const rect = { kind: "rect" as const, displayId: "1", rect: { x: 10, y: 20, width: 100, height: 40 } };

describe("Geometry", () => {
  it("accepts negative origins (displays left of / above the primary)", () => {
    expect(Rect.parse({ x: -1440, y: -200, width: 10, height: 10 })).toBeTruthy();
  });
  it("rejects zero or negative size", () => {
    expect(Rect.safeParse({ x: 0, y: 0, width: 0, height: 10 }).success).toBe(false);
    expect(Rect.safeParse({ x: 0, y: 0, width: 10, height: -1 }).success).toBe(false);
  });
});

describe("Target", () => {
  it("accepts every kind", () => {
    expect(Target.safeParse(el("a")).success).toBe(true);
    expect(Target.safeParse(rect).success).toBe(true);
    expect(Target.safeParse({ kind: "point", displayId: "1", point: { x: 1, y: 2 } }).success).toBe(true);
    expect(
      Target.safeParse({
        kind: "polygon",
        displayId: "1",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 5, y: 8 },
        ],
      }).success,
    ).toBe(true);
  });
  it("rejects bad targets", () => {
    expect(Target.safeParse({ kind: "element" }).success).toBe(false);
    expect(Target.safeParse({ kind: "rect", rect: rect.rect }).success).toBe(false); // missing displayId
    expect(Target.safeParse({ kind: "circle", displayId: "1" }).success).toBe(false);
    expect(
      Target.safeParse({
        kind: "polygon",
        displayId: "1",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }).success,
    ).toBe(false); // < 3 points
    expect(Target.safeParse({ kind: "point", displayId: "1", point: { x: "1", y: 2 } }).success).toBe(false);
  });
});

describe("Expiry", () => {
  it("accepts named expiries and ms within bounds", () => {
    for (const e of ["next_turn", "on_target_selected", "context_change", "manual"]) {
      expect(Expiry.safeParse(e).success).toBe(true);
    }
    expect(Expiry.safeParse({ ms: 500 }).success).toBe(true);
    expect(Expiry.safeParse({ ms: 120_000 }).success).toBe(true);
  });
  it("rejects out-of-range or fractional ms and unknown names", () => {
    expect(Expiry.safeParse({ ms: 499 }).success).toBe(false);
    expect(Expiry.safeParse({ ms: 120_001 }).success).toBe(false);
    expect(Expiry.safeParse({ ms: 1000.5 }).success).toBe(false);
    expect(Expiry.safeParse("forever").success).toBe(false);
  });
});

describe("Tool inputs", () => {
  it("applies defaults", () => {
    expect(PointAtInput.parse({ target: el("x") }).motion).toBe("tap");
    const h = HighlightInput.parse({ target: el("x") });
    expect(h.style).toBe("ring");
    expect(h.tone).toBe("info");
    expect(ShowStepsInput.parse({ steps: [{ target: el("a"), label: "A" }] }).startAt).toBe(0);
    expect(MagnifyInput.parse({ target: el("x") }).zoom).toBe(2.5);
  });

  it("rejects oversize labels", () => {
    expect(HighlightInput.safeParse({ target: el("x"), label: "x".repeat(60) }).success).toBe(true);
    expect(HighlightInput.safeParse({ target: el("x"), label: "x".repeat(61) }).success).toBe(false);
    expect(PointAtInput.safeParse({ target: el("x"), label: "x".repeat(61) }).success).toBe(false);
    expect(ShowStepsInput.safeParse({ steps: [{ target: el("a"), label: "x".repeat(41) }] }).success).toBe(false);
    expect(PreviewActionInput.safeParse({ target: el("x"), actionLabel: "x".repeat(31) }).success).toBe(false);
  });

  it("enforces step count 1..5 and non-negative startAt", () => {
    const step = { target: el("a"), label: "A" };
    expect(ShowStepsInput.safeParse({ steps: [] }).success).toBe(false);
    expect(ShowStepsInput.safeParse({ steps: Array(5).fill(step) }).success).toBe(true);
    expect(ShowStepsInput.safeParse({ steps: Array(6).fill(step) }).success).toBe(false);
    expect(ShowStepsInput.safeParse({ steps: [step], startAt: -1 }).success).toBe(false);
  });

  it("rejects unknown enum values", () => {
    expect(HighlightInput.safeParse({ target: el("x"), style: "glow" }).success).toBe(false);
    expect(HighlightInput.safeParse({ target: el("x"), tone: "danger" }).success).toBe(false);
    expect(PointAtInput.safeParse({ target: el("x"), motion: "swipe" }).success).toBe(false);
  });

  it("bounds magnify zoom", () => {
    expect(MagnifyInput.safeParse({ target: el("x"), zoom: 1.5 }).success).toBe(false);
    expect(MagnifyInput.safeParse({ target: el("x"), zoom: 4.5 }).success).toBe(false);
  });

  it("validates clear and advance_step", () => {
    expect(ClearInput.safeParse({ overlayId: "all" }).success).toBe(true);
    expect(ClearInput.safeParse({ overlayId: "ov_1" }).success).toBe(true);
    expect(ClearInput.safeParse({}).success).toBe(false);
    expect(AdvanceStepInput.safeParse({ stepsId: "s1" }).success).toBe(true);
    expect(AdvanceStepInput.safeParse({}).success).toBe(false);
  });

  it("validates move_avatar, defaulting to auto", () => {
    expect(MoveAvatarInput.parse({})).toEqual({ position: "auto" });
    expect(MoveAvatarInput.safeParse({ position: "bottom_left", displayId: "2", avoid: el("x") }).success).toBe(true);
    expect(MoveAvatarInput.safeParse({ position: "middle" }).success).toBe(false);
    expect(MoveAvatarInput.safeParse({ avoid: { kind: "element" } }).success).toBe(false);
    expect(ToolResultReason.safeParse("avatar_unavailable").success).toBe(true);
  });
});

describe("ShowExplainerInput", () => {
  const base = { title: "How to attach a photo" };

  it("accepts each kind", () => {
    const specs = [
      { kind: "concept", panels: [{ caption: "Your photos live on a computer far away", imagePrompt: "a friendly cloud above a house" }] },
      { kind: "sequence", steps: [{ icon: "click", caption: "Click Attach" }, { icon: "photo", caption: "Pick a photo" }] },
      { kind: "compare", left: { title: "Real", points: ["Known sender"] }, right: { title: "Scam", points: ["Urgent tone"], imagePrompt: "a fishing hook" } },
      { kind: "anatomy", region: rect, callouts: [{ target: el("fixture.send"), label: "Sends the email" }] },
    ];
    for (const spec of specs) expect(ShowExplainerInput.safeParse({ ...base, spec }).success).toBe(true);
  });

  it("rejects bad specs", () => {
    const bad = [
      { kind: "sequence", steps: [{ icon: "click", caption: "only one" }] }, // < 2 steps
      { kind: "sequence", steps: [{ icon: "rocket", caption: "a" }, { icon: "click", caption: "b" }] }, // bad icon
      { kind: "concept", panels: [] },
      { kind: "concept", panels: Array(4).fill({ caption: "c", imagePrompt: "p" }) },
      { kind: "concept", panels: [{ caption: "x".repeat(91), imagePrompt: "p" }] },
      { kind: "compare", left: { title: "a", points: ["1", "2", "3", "4", "5"] }, right: { title: "b", points: [] } },
      { kind: "anatomy", region: rect, callouts: [] },
      { kind: "anatomy", region: rect, callouts: Array(7).fill({ target: el("a"), label: "a" }) },
      { kind: "diagram" },
    ];
    for (const spec of bad) expect(ShowExplainerInput.safeParse({ ...base, spec }).success).toBe(false);
  });

  it("rejects oversize titles", () => {
    const spec = { kind: "sequence", steps: [{ icon: "click", caption: "a" }, { icon: "send", caption: "b" }] };
    expect(ShowExplainerInput.safeParse({ title: "x".repeat(51), spec }).success).toBe(false);
  });
});

describe("Results and events", () => {
  it("validates ToolResult", () => {
    expect(ToolResult.safeParse({ ok: true, visible: false, reason: "target_not_found" }).success).toBe(true);
    expect(ToolResult.safeParse({ ok: false, visible: false, reason: "unknown_overlay" }).success).toBe(true);
    expect(ToolResult.safeParse({ ok: false, visible: false, reason: "cancelled" }).success).toBe(true);
    expect(ToolResult.safeParse({ ok: true, visible: true, reason: "nope" }).success).toBe(false);
  });
  it("validates events, including the additive dismiss reason", () => {
    expect(OverlayEvent.safeParse({ type: "overlay.shown", overlayId: "a" }).success).toBe(true);
    expect(OverlayEvent.safeParse({ type: "overlay.dismissed", overlayId: "a", by: "model", reason: "replaced" }).success).toBe(true);
    expect(OverlayEvent.safeParse({ type: "overlay.dismissed", overlayId: "a", by: "model" }).success).toBe(true);
    expect(OverlayEvent.safeParse({ type: "overlay.dismissed", overlayId: "a", by: "robot" }).success).toBe(false);
    expect(OverlayEvent.safeParse({ type: "steps.advanced", stepsId: "s", index: 1 }).success).toBe(true);
    expect(OverlayEvent.safeParse({ type: "overlay.exploded", overlayId: "a" }).success).toBe(false);
  });
});

describe("LabelPartsInput (additive tool)", () => {
  const item = (label = "Odd sender") => ({ target: el("a"), label });
  it("accepts 1-5 items; tone defaults to info; expires is optional", () => {
    const r = LabelPartsInput.parse({ items: [item()] });
    expect(r.items[0]!.tone).toBe("info");
    expect(LabelPartsInput.safeParse({ items: [item(), item(), item(), item(), item()], title: "Signs", expires: "manual" }).success).toBe(true);
  });
  it("rejects 0 or 6 items, long labels/titles and bad tones", () => {
    expect(LabelPartsInput.safeParse({ items: [] }).success).toBe(false);
    expect(LabelPartsInput.safeParse({ items: Array.from({ length: 6 }, () => item()) }).success).toBe(false);
    expect(LabelPartsInput.safeParse({ items: [item("x".repeat(41))] }).success).toBe(false);
    expect(LabelPartsInput.safeParse({ items: [item()], title: "x".repeat(41) }).success).toBe(false);
    expect(LabelPartsInput.safeParse({ items: [{ ...item(), tone: "red" }] }).success).toBe(false);
  });
});

describe("verdict explainer spec (additive template)", () => {
  const input = (spec: unknown) => ShowExplainerInput.safeParse({ title: "Likely a scam", spec });
  it("accepts a tone with 1-3 short reasons", () => {
    expect(input({ kind: "verdict", tone: "warning", reasons: ["Fake sender"] }).success).toBe(true);
    expect(input({ kind: "verdict", tone: "success", reasons: ["a", "b", "c"] }).success).toBe(true);
  });
  it("rejects no reasons, more than 3, long reasons and a missing tone", () => {
    expect(input({ kind: "verdict", tone: "warning", reasons: [] }).success).toBe(false);
    expect(input({ kind: "verdict", tone: "warning", reasons: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(input({ kind: "verdict", tone: "warning", reasons: ["x".repeat(61)] }).success).toBe(false);
    expect(input({ kind: "verdict", reasons: ["a"] }).success).toBe(false);
  });
});
