import { describe, expect, it, vi } from "vitest";
import type { GestureEvent } from "@pointy/gestures";
import { MouseEventSink, mergeMouseSources, type MouseSource } from "./SimMouseSink";
import { SimGestureService, type FeedbackGestureService } from "./SimGestureService";

const display = { id: 1, width: 100, height: 50, bounds: { x: 0, y: 0, width: 100, height: 50 } };
const timers = { setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };
const mouse = (x: number): GestureEvent => ({ type: "mouse", hand: "Right", phase: "move", x, y: 1, displayId: 1, t: x });
const click: GestureEvent = { type: "click", hand: "Right", button: "left", x: 1, y: 2, displayId: 1, t: 0 };
const scroll: GestureEvent = { type: "scroll", hand: "Right", phase: "move", dx: 0, dy: 5, t: 0 };
const cursor: GestureEvent = { type: "cursor_moved", hand: "Right", x: 1, y: 1, displayId: 1, t: 0 };

describe("MouseEventSink + mergeMouseSources", () => {
  it("delivers by type and unsubscribes", () => {
    const sink = new MouseEventSink();
    const a = vi.fn();
    const off = sink.on("mouse", a);
    sink.emit(mouse(1) as never);
    sink.emit(click as never);
    expect(a).toHaveBeenCalledTimes(1);
    off();
    sink.emit(mouse(2) as never);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("merged source sees real and sink events and unsubscribes both", () => {
    const realCbs = new Set<(e: never) => void>();
    const real = { display, on: (_t: string, cb: (e: never) => void) => (realCbs.add(cb), () => realCbs.delete(cb)) } as unknown as MouseSource;
    const sink = new MouseEventSink();
    const src = mergeMouseSources(real, sink);
    const got: unknown[] = [];
    const off = src.on("mouse", (e) => got.push(e));
    realCbs.forEach((c) => c(mouse(1) as never));
    sink.emit(mouse(2) as never);
    expect(got).toHaveLength(2);
    expect(src.display.id).toBe(1);
    off();
    sink.emit(mouse(3) as never);
    expect(got).toHaveLength(2);
    expect(realCbs.size).toBe(0);
  });
});

describe("SimGestureService mouse forwarding gate", () => {
  function make(withSink: boolean) {
    let active = false;
    const base: FeedbackGestureService = {
      onAny: () => () => {},
      onSession: () => () => {},
      setSessionActive: (a) => void (active = a),
      get sessionActive() {
        return active;
      },
      display,
    };
    const sink = new MouseEventSink();
    const got: string[] = [];
    for (const t of ["mouse", "click", "scroll"] as const) sink.on(t, () => got.push(t));
    const sim = new SimGestureService({ base, timers, ...(withSink ? { mouseSink: sink } : {}) });
    return { sim, got, base };
  }

  it("forwards mouse/click/scroll to the sink only with a sink AND an open session; never other events", async () => {
    const { sim, got, base } = make(true);
    await sim.play([mouse(1), click, scroll, cursor], 0);
    expect(got).toEqual([]); // session closed
    base.setSessionActive(true);
    await sim.play([mouse(1), click, scroll, cursor], 0);
    expect(got).toEqual(["mouse", "click", "scroll"]);
    base.setSessionActive(false);
    await sim.play([mouse(2)], 0);
    expect(got).toHaveLength(3);
  });

  it("without a sink (flag off) nothing is forwarded even in a session", async () => {
    const { sim, got, base } = make(false);
    base.setSessionActive(true);
    await sim.play([mouse(1), click, scroll], 0);
    expect(got).toEqual([]);
  });
});
