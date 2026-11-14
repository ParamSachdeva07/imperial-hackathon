import { describe, expect, it } from "vitest";
import type { GestureEvent } from "@pointy/gestures";
import { SimGestureSource } from "./SimGestureSource";

function fakeTimers() {
  const queue: { fn: () => void; ms: number; id: number }[] = [];
  let id = 0;
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        queue.push({ fn, ms, id: ++id });
        return id;
      },
      clearTimeout: (h: unknown) => {
        const i = queue.findIndex((q) => q.id === h);
        if (i >= 0) queue.splice(i, 1);
      },
    },
    queue,
    tick: () => queue.shift()?.fn(),
  };
}

const ev = (x: number): GestureEvent => ({ type: "cursor_moved", hand: "Right", x, y: 0, displayId: 1, t: x });

describe("SimGestureSource", () => {
  it("emits the first event immediately then one per interval", async () => {
    const f = fakeTimers();
    const src = new SimGestureSource({ timers: f.timers });
    const got: number[] = [];
    src.onAny((e) => got.push(e.type === "cursor_moved" ? e.x : -1));
    const done = src.play([ev(1), ev(2), ev(3)], 50);
    expect(got).toEqual([1]);
    expect(f.queue[0]?.ms).toBe(50);
    f.tick();
    f.tick();
    await done;
    expect(got).toEqual([1, 2, 3]);
    expect(src.isPlaying()).toBe(false);
    expect(f.queue).toHaveLength(0);
  });

  it("defaults to 33 ms", () => {
    const f = fakeTimers();
    const src = new SimGestureSource({ timers: f.timers });
    void src.play([ev(1), ev(2)]);
    expect(f.queue[0]?.ms).toBe(33);
  });

  it("a new play cancels the previous one; unsubscribe stops delivery", async () => {
    const f = fakeTimers();
    const src = new SimGestureSource({ timers: f.timers });
    const got: number[] = [];
    const off = src.onAny((e) => got.push(e.type === "cursor_moved" ? e.x : -1));
    const first = src.play([ev(1), ev(2)]);
    void src.play([ev(10)]);
    await first;
    expect(got).toEqual([1, 10]);
    off();
    void src.play([ev(20)]);
    expect(got).toEqual([1, 10]);
  });

  it("empty list resolves; dispose cancels", async () => {
    const f = fakeTimers();
    const src = new SimGestureSource({ timers: f.timers });
    await src.play([]);
    const p = src.play([ev(1), ev(2)]);
    src.dispose();
    await p;
    expect(f.queue).toHaveLength(0);
  });

  it("resets partial wake progress when a replay is replaced or disposed, not after a completed wake", async () => {
    const wp = (progress: number): GestureEvent => ({ type: "wake_progress", hand: "Right", progress, x: 5, y: 6, displayId: 1, t: 1 });
    const wake: GestureEvent = { type: "wake_requested", source: "open_palm", hand: "Right", heldForMs: 1, t: 2 };
    const f = fakeTimers();
    const src = new SimGestureSource({ timers: f.timers });
    const got: string[] = [];
    src.onAny((e) => got.push(e.type === "wake_progress" ? `wp${e.progress}@${e.x},${e.y}` : e.type));
    void src.play([wp(0.4), wp(0.8), wake], 10);
    f.tick();
    expect(got).toEqual(["wp0.4@5,6", "wp0.8@5,6"]);
    void src.play([ev(1)], 10);
    expect(got).toEqual(["wp0.4@5,6", "wp0.8@5,6", "wp0@5,6", "cursor_moved"]);
    // a completed wake leaves nothing to reset
    got.length = 0;
    void src.play([wp(0.5), wake], 10);
    f.tick();
    src.dispose();
    expect(got).toEqual(["wp0.5@5,6", "wake_requested"]);
    // dispose mid-hold resets too
    got.length = 0;
    const src2 = new SimGestureSource({ timers: f.timers });
    src2.onAny((e) => got.push(e.type === "wake_progress" ? `wp${e.progress}` : e.type));
    void src2.play([wp(0.3), wp(0.6)], 10);
    src2.dispose();
    expect(got).toEqual(["wp0.3", "wp0"]);
  });
});
