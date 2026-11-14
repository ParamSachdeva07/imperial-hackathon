import { describe, expect, it } from "vitest";
import type { GestureEvent } from "@pointy/gestures";
import { SimGestureService, type FeedbackGestureService } from "./SimGestureService";

const display = { id: 1, width: 100, height: 50, bounds: { x: 0, y: 0, width: 100, height: 50 } };
const ev = (x: number): GestureEvent => ({ type: "cursor_moved", hand: "Right", x, y: 0, displayId: 1, t: x });
const immediateTimers = { setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };

function fakeBase(): FeedbackGestureService & { emit(e: GestureEvent): void; calls: boolean[]; listenerCount(): number } {
  const any = new Set<(e: GestureEvent) => void>();
  const sess = new Set<(a: boolean) => void>();
  let active = false;
  const calls: boolean[] = [];
  return {
    onAny: (cb) => (any.add(cb), () => any.delete(cb)),
    onSession: (cb) => (sess.add(cb), () => sess.delete(cb)),
    setSessionActive(a) {
      calls.push(a);
      active = a;
      for (const l of sess) l(a);
    },
    get sessionActive() {
      return active;
    },
    display: { ...display, id: 9 },
    emit: (e) => any.forEach((l) => l(e)),
    calls,
    listenerCount: () => any.size + sess.size,
  };
}

describe("SimGestureService standalone", () => {
  it("plays events to listeners and keeps its own session flag", async () => {
    const s = new SimGestureService({ display: () => display, timers: immediateTimers });
    const got: number[] = [];
    const off = s.onAny((e) => got.push(e.t));
    const sessions: boolean[] = [];
    s.onSession((a) => sessions.push(a));
    expect(s.sessionActive).toBe(false);
    s.setSessionActive(true);
    expect(s.sessionActive).toBe(true);
    expect(sessions).toEqual([true]);
    await s.play([ev(1), ev(2)], 0);
    expect(got).toEqual([1, 2]);
    off();
    await s.play([ev(3)], 0);
    expect(got).toEqual([1, 2]);
    expect(s.display.id).toBe(1);
    s.dispose();
  });
  it("needs a base or a display", () => {
    expect(() => new SimGestureService({})).toThrow();
  });
});

describe("SimGestureService merged with a real service", () => {
  it("listeners see real and simulated events; session and display come from the real service", async () => {
    const base = fakeBase();
    const s = new SimGestureService({ base, timers: immediateTimers });
    const got: number[] = [];
    const off = s.onAny((e) => got.push(e.t));
    const sessions: boolean[] = [];
    s.onSession((a) => sessions.push(a));
    base.emit(ev(1));
    await s.play([ev(2)], 0);
    expect(got).toEqual([1, 2]);
    s.setSessionActive(true);
    expect(base.calls).toEqual([true]);
    expect(s.sessionActive).toBe(true);
    expect(sessions).toEqual([true]);
    expect(s.display.id).toBe(9);
    off();
    expect(base.listenerCount()).toBe(1); // only the session listener left
  });
  it("simulated events are not delivered to the real service's listeners registered directly", async () => {
    const base = fakeBase();
    const s = new SimGestureService({ base, timers: immediateTimers });
    const direct: number[] = [];
    base.onAny((e) => direct.push(e.t));
    await s.play([ev(5)], 0);
    expect(direct).toEqual([]);
  });
});
