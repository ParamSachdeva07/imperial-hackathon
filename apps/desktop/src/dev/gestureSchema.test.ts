import { describe, expect, it } from "vitest";
import { assertEventsForDisplay, GestureBody, GestureSessionBody } from "./gestureSchema";

const cursor = { type: "cursor_moved", hand: "Right", x: 1, y: 2, displayId: 1, t: 0 };

describe("gesture dev schema", () => {
  it("accepts every event shape", () => {
    const events = [
      { type: "wake_requested", source: "open_palm", hand: "Left", heldForMs: 500, t: 1 },
      { type: "wake_progress", hand: "Right", progress: 0.4, x: 1, y: 2, displayId: 1, t: 0 },
      cursor,
      { type: "dwell_progress", hand: "Right", progress: 0.5, x: 1, y: 2, displayId: 1, t: 0 },
      { type: "point_selected", hand: "Right", x: 1, y: 2, displayId: 1, heldForMs: 800, t: 0 },
      { type: "region_selected", hand: "Right", polygon: [[0, 0], [10, 0], [10, 10]], bbox: { x: 0, y: 0, width: 10, height: 10 }, displayId: 1, t: 0 },
      { type: "scroll", hand: "Right", phase: "move", dx: 0, dy: 5, t: 0 },
      { type: "mouse", hand: "Right", phase: "start", x: 1, y: 2, displayId: 1, t: 0 },
      { type: "click_progress", hand: "Right", progress: 1, x: 1, y: 2, displayId: 1, t: 0 },
      { type: "click", hand: "Right", button: "left", x: 1, y: 2, displayId: 1, t: 0 },
      { type: "hand_lost", hand: "Right", reason: "absent", t: 0 },
    ];
    expect(GestureBody.parse({ events, intervalMs: 10 }).events).toHaveLength(events.length);
  });
  it("rejects bad shapes", () => {
    expect(GestureBody.safeParse({ events: [] }).success).toBe(false);
    expect(GestureBody.safeParse({ events: [{ ...cursor, displayId: "1" }] }).success).toBe(false);
    expect(GestureBody.safeParse({ events: [{ ...cursor, type: "nope" }] }).success).toBe(false);
    expect(GestureBody.safeParse({ events: [{ ...cursor, x: null }] }).success).toBe(false);
    expect(GestureBody.safeParse({ events: [cursor], intervalMs: -1 }).success).toBe(false);
  });
  it("session body", () => {
    expect(GestureSessionBody.parse({ active: true })).toEqual({ active: true });
    expect(GestureSessionBody.safeParse({}).success).toBe(false);
  });
});

describe("assertEventsForDisplay", () => {
  const events = GestureBody.parse({ events: [cursor, { type: "hand_lost", hand: "Right", reason: "absent", t: 0 }] }).events;
  it("passes events for the gesture display and events without a display", () => {
    expect(() => assertEventsForDisplay(events, 1)).not.toThrow();
  });
  it("rejects other display ids with a ZodError", () => {
    expect(() => assertEventsForDisplay(events, 2)).toThrow(/displayId 1 is not supported.*display 2/);
  });
});
