import { afterEach, describe, expect, it, vi } from "vitest";
import { GestureInterpreter, type GestureEvent, type HandObservation, type Point3 } from "../src/index";
import { toMousePoint } from "../src/electron/coords";
import { isGestureEvent, isVisionStatus } from "../src/electron/protocol";
import { startMockController } from "../electron/dev/mockController";
import type { GestureService } from "../src/electron/service";

describe("IPC validation", () => {
  it("accepts every event the interpreter emits", () => {
    const it = new GestureInterpreter({ id: 1, width: 1440, height: 900 });
    const palm = (): HandObservation => {
      const lm: Point3[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
      lm[12] = { x: 0.5, y: 0.3, z: 0 };
      return { label: "Left", landmarks: lm, gesture: { name: "Open_Palm", score: 0.9 } };
    };
    const evs: GestureEvent[] = [];
    for (let i = 0; i < 40; i++) evs.push(...it.process({ t: i * 33, hands: [palm()] }));
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every(isGestureEvent)).toBe(true);
  });

  it("rejects anything else", () => {
    for (const bad of [null, 42, "click", {}, { type: "click" }, { type: "rm -rf", t: 1 }, { type: "__proto__", t: 1 }]) {
      expect(isGestureEvent(bad)).toBe(false);
    }
    expect(isVisionStatus({ type: "running", fps: 30, hands: 1 })).toBe(true);
    expect(isVisionStatus({ type: "nope" })).toBe(false);
  });
});

describe("toMousePoint", () => {
  const bounds = { x: 1920, y: 0, width: 1440, height: 900 };
  const identity = (p: { x: number; y: number }) => p;

  it("macOS: display offset in points, clamped to the display", () => {
    expect(toMousePoint(bounds, 100, 50, "darwin", identity)).toEqual({ x: 2020, y: 50 });
    expect(toMousePoint(bounds, -20, 5000, "darwin", identity)).toEqual({ x: 1920, y: 899 });
  });

  it("Windows: converts DIP to physical pixels with the provided converter", () => {
    const scale150 = (p: { x: number; y: number }) => ({ x: p.x * 1.5, y: p.y * 1.5 });
    expect(toMousePoint(bounds, 100, 50, "win32", scale150)).toEqual({ x: 3030, y: 75 });
  });
});

describe("mock controller", () => {
  afterEach(() => vi.useRealTimers());

  function fakeService() {
    let listener: ((e: GestureEvent) => void) | null = null;
    const svc = {
      sessionActive: false,
      setSessionActive(a: boolean) {
        svc.sessionActive = a;
      },
      onAny(cb: (e: GestureEvent) => void) {
        listener = cb;
        return () => (listener = null);
      },
      emit: (e: GestureEvent) => listener?.(e),
    };
    return svc;
  }

  it("opens the session on wake and closes it after the idle delay", () => {
    vi.useFakeTimers();
    const svc = fakeService();
    const logs: string[] = [];
    startMockController(svc as unknown as GestureService, { idleMs: 1000, log: (m) => logs.push(m) });

    svc.emit({ type: "wake_requested", source: "open_palm", hand: "Left", heldForMs: 700, t: 0 });
    expect(svc.sessionActive).toBe(true);

    vi.advanceTimersByTime(800);
    svc.emit({ type: "click", hand: "Right", button: "left", x: 1, y: 2, displayId: 1, t: 800 });
    vi.advanceTimersByTime(800);
    expect(svc.sessionActive).toBe(true); // the click reset the idle timer

    vi.advanceTimersByTime(300);
    expect(svc.sessionActive).toBe(false);
    expect(logs.some((l) => l.startsWith("SESSION CLOSED"))).toBe(true);
  });
});
