import { describe, expect, it } from "vitest";
import type { GestureFeedback } from "@pointy/shared/overlay/render";
import { applyGestureEvents, DEFAULT_GESTURE_CONFIG as CFG, initialGestureState, isGestureAnimating, pruneGesture, type GestureState } from "./gestureFeedback";

const on = (s: GestureState = initialGestureState) => applyGestureEvents(s, [{ kind: "session", active: true }], 0);
const draw = (x: number, y: number): GestureFeedback => ({ kind: "cursor", at: { x, y }, mode: "draw" });

describe("gesture feedback reducer", () => {
  it("ignores everything while the session is inactive", () => {
    const s = applyGestureEvents(initialGestureState, [draw(1, 1), { kind: "click", at: { x: 1, y: 1 } }], 10);
    expect(s).toBe(initialGestureState);
  });

  it("accumulates a trail only in draw mode, capped by the ring buffer", () => {
    let s = on();
    for (let i = 0; i < CFG.trailMaxPoints + 20; i++) s = applyGestureEvents(s, [draw(i, 0)], i);
    expect(s.trail).toHaveLength(CFG.trailMaxPoints);
    expect(s.trail[s.trail.length - 1]!.x).toBe(CFG.trailMaxPoints + 19);
  });

  it("keeps the draw hand's cursor and trail while the other hand drives the mouse", () => {
    let s = on();
    s = applyGestureEvents(s, [draw(1, 1), { kind: "cursor", at: { x: 5, y: 5 }, mode: "mouse" }, draw(2, 2), { kind: "cursor", at: { x: 6, y: 6 }, mode: "mouse" }], 10);
    expect(s.trail).toHaveLength(2);
    expect(s.cursor?.at).toEqual({ x: 2, y: 2 });
    expect(s.mouseCursor?.at).toEqual({ x: 6, y: 6 });
    s = applyGestureEvents(s, [{ kind: "lost", mode: "mouse" }], 20);
    expect(s.mouseCursor).toBeNull();
    expect(s.cursor).not.toBeNull();
    expect(s.trail).toHaveLength(2);
    s = applyGestureEvents(s, [{ kind: "cursor", at: { x: 7, y: 7 }, mode: "mouse" }, { kind: "lost", mode: "draw" }], 30);
    expect(s.cursor).toBeNull();
    expect(s.trail).toHaveLength(0);
    expect(s.mouseCursor).not.toBeNull();
    s = applyGestureEvents(s, [{ kind: "lost" }], 40);
    expect(s.mouseCursor).toBeNull();
  });

  it("ages trail points out and expires flashes", () => {
    let s = on();
    s = applyGestureEvents(s, [draw(1, 1), draw(2, 2)], 100);
    s = applyGestureEvents(s, [draw(3, 3), { kind: "click", at: { x: 3, y: 3 } }], 1000);
    expect(isGestureAnimating(s)).toBe(true);
    const mid = pruneGesture(s, 100 + CFG.trailMs + 1);
    expect(mid.trail.map((p) => p.x)).toEqual([3]);
    expect(mid.flashes).toHaveLength(1);
    expect(pruneGesture(mid, 100 + CFG.trailMs + 1)).toBe(mid); // nothing left to drop: same object
    const end = pruneGesture(mid, 1000 + Math.max(CFG.flashMs, CFG.trailMs));
    expect(end.flashes).toHaveLength(0);
    expect(end.trail).toHaveLength(0);
    expect(isGestureAnimating(end)).toBe(false);
  });

  it("lost clears cursor, ring and trail", () => {
    let s = on();
    s = applyGestureEvents(s, [draw(1, 1), { kind: "progress", at: { x: 1, y: 1 }, value: 0.5, progressKind: "dwell" }], 0);
    expect(s.drawProgress?.value).toBe(0.5);
    s = applyGestureEvents(s, [{ kind: "lost" }], 1);
    expect(s).toMatchObject({ cursor: null, drawProgress: null, trail: [], stroke: false });
  });

  it("progress 0 clears the ring", () => {
    let s = on();
    s = applyGestureEvents(s, [{ kind: "progress", at: { x: 1, y: 1 }, value: 0.5, progressKind: "click" }, { kind: "progress", at: { x: 1, y: 1 }, value: 0, progressKind: "click" }], 0);
    expect(s.mouseProgress).toBeNull();
  });

  it("mouse loss clears the click ring but leaves the draw ring", () => {
    let s = on();
    const at = { x: 1, y: 1 };
    s = applyGestureEvents(s, [
      { kind: "progress", at, value: 0.5, progressKind: "dwell" },
      { kind: "progress", at, value: 0.4, progressKind: "click" },
    ], 0);
    expect(s.drawProgress?.value).toBe(0.5);
    expect(s.mouseProgress?.value).toBe(0.4);
    s = applyGestureEvents(s, [{ kind: "lost", mode: "mouse" }], 1);
    expect(s.mouseProgress).toBeNull();
    expect(s.drawProgress?.value).toBe(0.5);
  });

  it("zero progress from one mode does not clear the other", () => {
    let s = on();
    const at = { x: 1, y: 1 };
    s = applyGestureEvents(s, [
      { kind: "progress", at, value: 0.5, progressKind: "dwell" },
      { kind: "progress", at, value: 0, progressKind: "click" },
    ], 0);
    expect(s.drawProgress?.value).toBe(0.5);
    s = applyGestureEvents(s, [{ kind: "lost", mode: "draw" }], 1);
    expect(s.drawProgress).toBeNull();
  });

  it("a selection clears the trail and adds a flash that survives", () => {
    let s = on();
    s = applyGestureEvents(s, [draw(1, 1), draw(2, 2)], 0);
    s = applyGestureEvents(s, [{ kind: "selected_region", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], bounds: { x: 0, y: 0, width: 5, height: 5 } }], 10);
    expect(s.trail).toHaveLength(0);
    expect(s.flashes.map((f) => f.kind)).toEqual(["region"]);
    expect(s.cursor).not.toBeNull();
  });

  it("session off clears everything but flashes in flight", () => {
    let s = on();
    s = applyGestureEvents(s, [draw(1, 1), { kind: "scroll", phase: "start" }, { kind: "selected_point", at: { x: 1, y: 1 } }], 0);
    expect(s.scrolling).toBe(true);
    s = applyGestureEvents(s, [{ kind: "session", active: false }], 5);
    expect(s).toMatchObject({ session: false, cursor: null, drawProgress: null, mouseProgress: null, trail: [], scrolling: false });
    expect(s.flashes).toHaveLength(1);
    expect(applyGestureEvents(s, [draw(9, 9)], 6)).toBe(s);
  });
});
