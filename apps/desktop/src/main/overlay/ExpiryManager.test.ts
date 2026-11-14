import { describe, expect, it, vi } from "vitest";
import { ExpiryManager, type ExpireCause, type ExpiryEntry } from "./ExpiryManager";
import { FakeClock } from "./testing/fakeClock";

function setup() {
  const clock = new FakeClock();
  const calls: Array<[string, ExpireCause]> = [];
  const m = new ExpiryManager({ clock, onExpire: (id, c) => calls.push([id, c]) });
  return { clock, calls, m };
}
const entry = (over: Partial<ExpiryEntry> & { id: string }): ExpiryEntry => ({
  expires: undefined,
  elementIds: [],
  coordinateOnly: false,
  ...over,
});

describe("ExpiryManager", () => {
  it("undefined expiry behaves as next_turn", () => {
    const { m, calls } = setup();
    m.track(entry({ id: "a" }));
    m.onContextChange();
    m.onTargetSelected("x");
    expect(calls).toEqual([]);
    m.onTurnStart("t1");
    expect(calls).toEqual([["a", "next_turn"]]);
    expect(m.has("a")).toBe(false);
  });

  it("explicit next_turn expires on turn start only", () => {
    const { m, calls } = setup();
    m.track(entry({ id: "a", expires: "next_turn" }));
    m.onContextChange();
    expect(calls).toEqual([]);
    m.onTurnStart("t");
    expect(calls).toEqual([["a", "next_turn"]]);
  });

  it("context_change expires on context change only", () => {
    const { m, calls } = setup();
    m.track(entry({ id: "a", expires: "context_change" }));
    m.onTurnStart("t");
    m.onTargetSelected("x");
    expect(calls).toEqual([]);
    m.onContextChange();
    expect(calls).toEqual([["a", "context_change"]]);
  });

  it("on_target_selected only for matching element ids", () => {
    const { m, calls } = setup();
    m.track(entry({ id: "a", expires: "on_target_selected", elementIds: ["e1", "e2"] }));
    m.track(entry({ id: "b", expires: "on_target_selected", elementIds: ["e3"] }));
    m.track(entry({ id: "c", expires: "on_target_selected", elementIds: [] }));
    m.onTargetSelected("nope");
    expect(calls).toEqual([]);
    m.onTargetSelected("e2");
    expect(calls).toEqual([["a", "target_selected"]]);
    expect(m.has("b")).toBe(true);
    expect(m.has("c")).toBe(true);
  });

  it("on_target_selected is not triggered by turn start or context change", () => {
    const { m, calls } = setup();
    m.track(entry({ id: "a", expires: "on_target_selected", elementIds: ["e"] }));
    m.onTurnStart("t");
    m.onContextChange();
    expect(calls).toEqual([]);
  });

  it("{ms} expires via timer after ms", () => {
    const { m, calls, clock } = setup();
    m.track(entry({ id: "a", expires: { ms: 1000 } }));
    clock.advance(999);
    expect(calls).toEqual([]);
    clock.advance(1);
    expect(calls).toEqual([["a", "timer"]]);
    expect(m.has("a")).toBe(false);
  });

  it("{ms} entries are not affected by turn start / target selected", () => {
    const { m, calls } = setup();
    m.track(entry({ id: "a", expires: { ms: 1000 }, elementIds: ["e"] }));
    m.onTurnStart("t");
    m.onTargetSelected("e");
    expect(calls).toEqual([]);
  });

  it("{ms} entries expire on context change when coordinateOnly, and the timer is cancelled", () => {
    const { m, calls, clock } = setup();
    m.track(entry({ id: "a", expires: { ms: 1000 }, coordinateOnly: true }));
    m.onContextChange();
    expect(calls).toEqual([["a", "context_change"]]);
    expect(clock.pendingCount).toBe(0);
    clock.advance(5000);
    expect(calls).toHaveLength(1);
  });

  it.each([undefined, "next_turn", "on_target_selected", "context_change", "manual", { ms: 5000 }] as const)(
    "coordinateOnly always expires on context change (expires=%j)",
    (expires) => {
      const { m, calls } = setup();
      m.track(entry({ id: "a", expires: expires as ExpiryEntry["expires"], coordinateOnly: true }));
      m.onContextChange();
      expect(calls).toEqual([["a", "context_change"]]);
    },
  );

  it("non-coordinateOnly manual survives everything", () => {
    const { m, calls, clock } = setup();
    m.track(entry({ id: "a", expires: "manual", elementIds: ["e"] }));
    m.onTurnStart("t");
    m.onContextChange();
    m.onTargetSelected("e");
    clock.advance(10 * 60_000);
    expect(calls).toEqual([]);
    expect(m.has("a")).toBe(true);
    m.untrack("a");
    expect(m.has("a")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("re-tracking the same id restarts the timer", () => {
    const { m, calls, clock } = setup();
    m.track(entry({ id: "a", expires: { ms: 1000 } }));
    clock.advance(800);
    m.track(entry({ id: "a", expires: { ms: 1000 } }));
    clock.advance(800);
    expect(calls).toEqual([]);
    clock.advance(200);
    expect(calls).toEqual([["a", "timer"]]);
  });

  it("re-tracking replaces the entry (manual → next_turn)", () => {
    const { m, calls } = setup();
    m.track(entry({ id: "a", expires: "manual" }));
    m.track(entry({ id: "a", expires: "next_turn" }));
    m.onTurnStart("t");
    expect(calls).toEqual([["a", "next_turn"]]);
  });

  it("re-tracking from {ms} to manual cancels the old timer", () => {
    const { m, calls, clock } = setup();
    m.track(entry({ id: "a", expires: { ms: 1000 } }));
    m.track(entry({ id: "a", expires: "manual" }));
    expect(clock.pendingCount).toBe(0);
    clock.advance(5000);
    expect(calls).toEqual([]);
  });

  it("untrack cancels the timer and never fires onExpire", () => {
    const { m, calls, clock } = setup();
    m.track(entry({ id: "a", expires: { ms: 1000 } }));
    m.untrack("a");
    expect(clock.pendingCount).toBe(0);
    clock.advance(2000);
    expect(calls).toEqual([]);
  });

  it("untrack of an unknown id is a no-op", () => {
    const { m } = setup();
    expect(() => m.untrack("zzz")).not.toThrow();
  });

  it("dispose cancels all timers and forgets all entries", () => {
    const { m, calls, clock } = setup();
    m.track(entry({ id: "a", expires: { ms: 1000 } }));
    m.track(entry({ id: "b", expires: { ms: 2000 } }));
    m.track(entry({ id: "c" }));
    m.dispose();
    expect(clock.pendingCount).toBe(0);
    expect(m.has("a") || m.has("b") || m.has("c")).toBe(false);
    clock.advance(5000);
    m.onTurnStart("t");
    m.onContextChange();
    expect(calls).toEqual([]);
  });

  it("onExpire fires once per entry", () => {
    const { m, calls } = setup();
    m.track(entry({ id: "a" }));
    m.onTurnStart("1");
    m.onTurnStart("2");
    m.onContextChange();
    expect(calls).toHaveLength(1);
  });

  it("expires several entries in one event, in tracking order", () => {
    const { m, calls } = setup();
    m.track(entry({ id: "a" }));
    m.track(entry({ id: "b", expires: "manual" }));
    m.track(entry({ id: "c", expires: "next_turn" }));
    m.onTurnStart("t");
    expect(calls).toEqual([
      ["a", "next_turn"],
      ["c", "next_turn"],
    ]);
  });

  it("an onExpire callback may untrack/track other entries safely", () => {
    const clock = new FakeClock();
    const seen: string[] = [];
    const m: ExpiryManager = new ExpiryManager({
      clock,
      onExpire: (id) => {
        seen.push(id);
        if (id === "a") m.untrack("b");
      },
    });
    m.track(entry({ id: "a" }));
    m.track(entry({ id: "b" }));
    m.onTurnStart("t");
    expect(seen).toEqual(["a"]);
  });

  it("uses the real clock by default", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const m = new ExpiryManager({ onExpire });
      m.track(entry({ id: "a", expires: { ms: 500 } }));
      vi.advanceTimersByTime(500);
      expect(onExpire).toHaveBeenCalledWith("a", "timer");
    } finally {
      vi.useRealTimers();
    }
  });
});
