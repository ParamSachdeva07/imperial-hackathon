import type { GestureEvent } from "@pointy/gestures";
import { describe, expect, it } from "vitest";
import { PointerTracker } from "./PointerTracker";

const mouse = (
  phase: "start" | "move" | "end",
  x: number,
  y: number,
): GestureEvent => ({
  type: "mouse",
  hand: "Right",
  phase,
  x,
  y,
  displayId: 7,
  t: 0,
});

describe("PointerTracker", () => {
  it("tracks start/move in global DIP, ignores end and other events", () => {
    let clock = 1000;
    const p = new PointerTracker({
      getBounds: () => ({ x: 1440, y: 0 }),
      now: () => clock,
    });
    expect(p.last()).toBeNull();
    expect(p.activeRecently(5000)).toBe(false);
    p.observe(mouse("start", 10, 20));
    expect(p.last()).toEqual({ x: 1450, y: 20, displayId: 7, at: 1000 });
    clock = 1500;
    p.observe(mouse("move", 30, 40));
    p.observe(mouse("end", 99, 99));
    p.observe({ type: "hand_lost", hand: "Right", reason: "absent", t: 0 });
    expect(p.last()).toEqual({ x: 1470, y: 40, displayId: 7, at: 1500 });
    clock = 2500;
    expect(p.activeRecently(1000)).toBe(true);
    clock = 2501;
    expect(p.activeRecently(1000)).toBe(false);
  });
});
