import { describe, expect, it, vi } from "vitest";
import { createQuitGuard, createScrollInvalidator } from "./productionLogic";

describe("createScrollInvalidator", () => {
  it("ignores scrolls while the real mouse is not attached", () => {
    const f = createScrollInvalidator({ mouseAttached: () => false, now: () => 0 });
    expect(f({ type: "scroll", phase: "end" })).toBe(false);
  });
  it("fires on end, throttles moves, ignores other events", () => {
    let t = 1000;
    const f = createScrollInvalidator({ mouseAttached: () => true, now: () => t, throttleMs: 400 });
    expect(f({ type: "wake_requested" })).toBe(false);
    expect(f({ type: "scroll", phase: "start" })).toBe(false);
    expect(f({ type: "scroll", phase: "move" })).toBe(true);
    t += 100;
    expect(f({ type: "scroll", phase: "move" })).toBe(false);
    t += 400;
    expect(f({ type: "scroll", phase: "move" })).toBe(true);
    expect(f({ type: "scroll", phase: "end" })).toBe(true);
  });
});

describe("createQuitGuard", () => {
  it("blocks the first quit, awaits close, then lets the second through", async () => {
    let resolve!: () => void;
    const quit = vi.fn();
    const guard = createQuitGuard({ close: () => new Promise<void>((r) => (resolve = r)), quit });
    expect(guard()).toBe(true);
    expect(guard()).toBe(true); // still closing
    expect(quit).not.toHaveBeenCalled();
    resolve();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(guard()).toBe(false);
  });
  it("quits after the timeout when close hangs", async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const guard = createQuitGuard({ close: () => new Promise<void>(() => {}), timeoutMs: 2000, quit });
    expect(guard()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(quit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
