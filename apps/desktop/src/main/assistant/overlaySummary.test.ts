import { describe, expect, it } from "vitest";
import type { RenderItem } from "@pointy/shared/overlay";
import { summarizeOverlays } from "./overlaySummary";

const tgt = (x: number, y: number) => ({ bounds: { x, y, width: 10, height: 20 }, shape: { kind: "rect" as const } });

describe("summarizeOverlays", () => {
  it("says none when empty or only exiting", () => {
    expect(summarizeOverlays([])).toBe("[overlays] none visible");
    const ex = { kind: "highlight", id: "a", state: "exiting", style: "ring", tone: "info", target: tgt(1, 2), label: null } as RenderItem;
    expect(summarizeOverlays([ex])).toBe("[overlays] none visible");
  });
  it("lists a ring+label and a card compactly", () => {
    const hl = { kind: "highlight", id: "a", state: "visible", style: "ring", tone: "info", target: tgt(100, 200), label: { text: "Send", rect: { x: 0, y: 0, width: 1, height: 1 }, connector: null } } as RenderItem;
    const card = { kind: "explainer", id: "b", state: "visible", title: "Likely a scam", anchor: null, designSize: { width: 1, height: 1 }, imageScale: 1, scale: 1, card: { x: 5, y: 6, width: 300, height: 200 }, connector: null, body: { kind: "verdict", tone: "warning", reasons: [] } } as RenderItem;
    expect(summarizeOverlays([hl, card])).toBe(`[overlays] 2 visible: ring+label "Send" at 100,200,10,20; card 'Likely a scam' at 5,6,300,200`);
  });
});
