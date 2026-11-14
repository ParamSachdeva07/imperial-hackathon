import { describe, expect, it } from "vitest";
import type { ElementBounds } from "@pointy/shared/overlay";
import { AnchorTracker } from "./AnchorTracker";
import { FakeBoundsProvider, FakeClock, flushPromises } from "./testing/fakeClock";

const eb = (x: number, y = 0, displayId = "1"): ElementBounds => ({
  rect: { x, y, width: 50, height: 20 },
  displayId,
});

function setup(opts: { intervalMs?: number; lostAfterMisses?: number } = {}) {
  const clock = new FakeClock();
  const provider = new FakeBoundsProvider();
  const moved: Array<[string, string, ElementBounds]> = [];
  const lost: Array<[string, string]> = [];
  const t = new AnchorTracker({
    boundsProvider: provider,
    clock,
    ...opts,
    onMoved: (o, e, b) => moved.push([o, e, b]),
    onLost: (o, e) => lost.push([o, e]),
  });
  return { clock, provider, moved, lost, t };
}
const tick = async (clock: FakeClock, ms: number) => {
  clock.advance(ms);
  await flushPromises();
};

describe("AnchorTracker polling", () => {
  it("polls every 300ms by default", async () => {
    const { t, clock, provider } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.start();
    await tick(clock, 299);
    expect(provider.calls).toHaveLength(0);
    await tick(clock, 1);
    expect(provider.calls).toHaveLength(1);
    await tick(clock, 300);
    expect(provider.calls).toHaveLength(2);
    await tick(clock, 300);
    await tick(clock, 300);
    expect(provider.calls).toHaveLength(4);
  });

  it("honours a custom interval", async () => {
    const { t, clock, provider } = setup({ intervalMs: 100 });
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.start();
    await tick(clock, 100);
    await tick(clock, 100);
    await tick(clock, 100);
    expect(provider.calls).toHaveLength(3);
  });

  it("no timer runs when nothing is tracked, before or after", async () => {
    const { t, clock } = setup();
    t.start();
    expect(clock.pendingCount).toBe(0);
    t.track("o1", ["e"], new Map());
    expect(clock.pendingCount).toBe(1);
    t.untrack("o1");
    expect(clock.pendingCount).toBe(0);
  });

  it("no timer before start()", () => {
    const { t, clock } = setup();
    t.track("o1", ["e"], new Map());
    expect(clock.pendingCount).toBe(0);
    t.start();
    expect(clock.pendingCount).toBe(1);
  });

  it("stop() clears the timer and unsubscribes from onChange", async () => {
    const { t, clock, provider } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.start();
    expect(provider.listenerCount).toBe(1);
    t.stop();
    expect(provider.listenerCount).toBe(0);
    expect(clock.pendingCount).toBe(0);
    provider.fireChange();
    await tick(clock, 5000);
    expect(provider.calls).toHaveLength(0);
  });

  it("start() twice subscribes once; stop() then start() resumes", async () => {
    const { t, clock, provider } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.start();
    t.start();
    expect(provider.listenerCount).toBe(1);
    t.stop();
    t.start();
    await tick(clock, 300);
    expect(provider.calls).toHaveLength(1);
  });

  it("untracking the last overlay stops polling", async () => {
    const { t, clock, provider } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.start();
    t.untrack("o1");
    expect(t.isTracking("o1")).toBe(false);
    await tick(clock, 2000);
    expect(provider.calls).toHaveLength(0);
  });

  it("onChange with nothing tracked does not query", async () => {
    const { t, provider } = setup();
    t.start();
    provider.fireChange();
    await flushPromises();
    expect(provider.calls).toHaveLength(0);
  });
});

describe("AnchorTracker onChange and overlap", () => {
  it("checks immediately when onChange fires", async () => {
    const { t, provider, moved } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.start();
    provider.set("e", eb(100));
    provider.fireChange();
    await flushPromises();
    expect(moved).toEqual([["o1", "e", eb(100)]]);
  });

  it("a change mid-check schedules exactly one follow-up", async () => {
    const { t, provider } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.start();
    let release!: () => void;
    provider.gate = new Promise<void>((r) => (release = r));
    provider.fireChange();
    await flushPromises();
    expect(provider.calls).toHaveLength(1);
    provider.fireChange();
    provider.fireChange();
    provider.fireChange();
    await flushPromises();
    expect(provider.calls).toHaveLength(1); // no overlapping check
    provider.gate = null;
    release();
    await flushPromises();
    expect(provider.calls).toHaveLength(2); // exactly one follow-up
  });

  it("check() during a check returns the in-flight promise and runs one follow-up", async () => {
    const { t, provider } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    let release!: () => void;
    provider.gate = new Promise<void>((r) => (release = r));
    const p1 = t.check();
    const p2 = t.check();
    provider.gate = null;
    release();
    await Promise.all([p1, p2]);
    expect(provider.calls).toHaveLength(2);
  });

  it("a timer tick during an in-flight check is skipped", async () => {
    const { t, provider, clock } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.start();
    let release!: () => void;
    provider.gate = new Promise<void>((r) => (release = r));
    await tick(clock, 300);
    await tick(clock, 300);
    await tick(clock, 300);
    expect(provider.calls).toHaveLength(1);
    provider.gate = null;
    release();
    await flushPromises();
    expect(provider.calls).toHaveLength(1);
    await tick(clock, 300);
    expect(provider.calls).toHaveLength(2);
  });
});

describe("AnchorTracker onMoved", () => {
  it("does not fire when bounds equal the initial bounds (within 0.5)", async () => {
    const { t, provider, moved } = setup();
    provider.set("e", { rect: { x: 0.4, y: 0, width: 50, height: 20 }, displayId: "1" });
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    await t.check();
    expect(moved).toEqual([]);
  });

  it("fires when the rect changes, then not again if stable", async () => {
    const { t, provider, moved } = setup();
    provider.set("e", eb(10));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    await t.check();
    await t.check();
    expect(moved).toEqual([["o1", "e", eb(10)]]);
  });

  it("fires when only displayId changes", async () => {
    const { t, provider, moved } = setup();
    provider.set("e", eb(0, 0, "2"));
    t.track("o1", ["e"], new Map([["e", eb(0, 0, "1")]]));
    await t.check();
    expect(moved).toEqual([["o1", "e", eb(0, 0, "2")]]);
  });

  it("fires when an element never found initially is found", async () => {
    const { t, provider, moved, lost } = setup();
    t.track("o1", ["e"], new Map());
    provider.set("e", eb(5));
    await t.check();
    expect(moved).toEqual([["o1", "e", eb(5)]]);
    expect(lost).toEqual([]);
  });

  it("fires on reappearance after being lost, even at the same bounds", async () => {
    const { t, provider, moved, lost } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    provider.set("e", null);
    await t.check();
    await t.check();
    expect(lost).toHaveLength(1);
    provider.set("e", eb(0));
    await t.check();
    expect(moved).toEqual([["o1", "e", eb(0)]]);
  });
});

describe("AnchorTracker onLost", () => {
  it("fires only after 2 consecutive misses", async () => {
    const { t, provider, lost } = setup();
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    provider.set("e", null);
    await t.check();
    expect(lost).toEqual([]);
    await t.check();
    expect(lost).toEqual([["o1", "e"]]);
  });

  it("fires only once while still missing", async () => {
    const { t, lost } = setup();
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    for (let i = 0; i < 6; i++) await t.check();
    expect(lost).toHaveLength(1);
  });

  it("a hit between misses resets the counter", async () => {
    const { t, provider, lost } = setup();
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    provider.set("e", null);
    await t.check();
    provider.set("e", eb(0));
    await t.check();
    provider.set("e", null);
    await t.check();
    expect(lost).toEqual([]);
    await t.check();
    expect(lost).toHaveLength(1);
  });

  it("can be lost again after being found again", async () => {
    const { t, provider, lost } = setup();
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    provider.set("e", null);
    await t.check();
    await t.check();
    provider.set("e", eb(0));
    await t.check();
    provider.set("e", null);
    await t.check();
    await t.check();
    expect(lost).toHaveLength(2);
  });

  it("honours a custom lostAfterMisses", async () => {
    const { t, lost } = setup({ lostAfterMisses: 3 });
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    await t.check();
    await t.check();
    expect(lost).toEqual([]);
    await t.check();
    expect(lost).toHaveLength(1);
  });

  it("an element never found initially is lost after 2 misses", async () => {
    const { t, lost } = setup();
    t.track("o1", ["e"], new Map());
    await t.check();
    await t.check();
    expect(lost).toEqual([["o1", "e"]]);
  });

  it("provider rejection counts as a miss and does not throw", async () => {
    const { t, provider, lost } = setup();
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    provider.set("e", new Error("boom"));
    await expect(t.check()).resolves.toBeUndefined();
    expect(lost).toEqual([]);
    await t.check();
    expect(lost).toEqual([["o1", "e"]]);
  });

  it("a throwing callback does not break the check or tracking", async () => {
    const clock = new FakeClock();
    const provider = new FakeBoundsProvider();
    const got: string[] = [];
    const t = new AnchorTracker({
      boundsProvider: provider,
      clock,
      onMoved: (o) => {
        got.push(o);
        throw new Error("cb");
      },
      onLost: () => {},
    });
    provider.set("e", eb(9));
    t.track("a", ["e"], new Map());
    t.track("b", ["e"], new Map());
    await expect(t.check()).resolves.toBeUndefined();
    expect(got).toEqual(["a", "b"]);
  });
});

describe("AnchorTracker multiple overlays / elements", () => {
  it("resolves each distinct element id once per check", async () => {
    const { t, provider, moved } = setup();
    provider.set("e", eb(10));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.track("o2", ["e"], new Map([["e", eb(0)]]));
    t.track("o3", ["e", "f"], new Map());
    provider.set("f", eb(1));
    await t.check();
    expect(provider.calls.filter((c) => c === "e")).toHaveLength(1);
    expect(provider.calls.filter((c) => c === "f")).toHaveLength(1);
    expect(moved.map(([o, e]) => `${o}:${e}`).sort()).toEqual(["o1:e", "o2:e", "o3:e", "o3:f"]);
  });

  it("overlays sharing an element are notified independently of untracking", async () => {
    const { t, provider, moved, lost } = setup();
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    t.track("o2", ["e"], new Map([["e", eb(0)]]));
    t.untrack("o1");
    provider.set("e", null);
    await t.check();
    await t.check();
    expect(lost).toEqual([["o2", "e"]]);
    expect(moved).toEqual([]);
    expect(t.isTracking("o2")).toBe(true);
  });

  it("an overlay tracked later with its own initial bounds is compared to those", async () => {
    const { t, provider, moved } = setup();
    provider.set("e", eb(0));
    t.track("o1", ["e"], new Map([["e", eb(50)]]));
    t.track("o2", ["e"], new Map([["e", eb(0)]]));
    await t.check();
    expect(moved).toEqual([["o1", "e", eb(0)]]);
  });

  it("re-tracking an overlay id replaces its elements and state", async () => {
    const { t, provider, lost } = setup();
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    provider.set("e", null);
    await t.check();
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    await t.check();
    expect(lost).toEqual([]); // counter restarted
  });

  it("untracked mid-check: no callbacks for it", async () => {
    const { t, provider, moved } = setup();
    provider.set("e", eb(99));
    t.track("o1", ["e"], new Map([["e", eb(0)]]));
    let release!: () => void;
    provider.gate = new Promise<void>((r) => (release = r));
    const p = t.check();
    await flushPromises();
    t.untrack("o1");
    provider.gate = null;
    release();
    await p;
    expect(moved).toEqual([]);
  });

  it("check() with nothing tracked does not query the provider", async () => {
    const { t, provider } = setup();
    await t.check();
    expect(provider.calls).toEqual([]);
  });

describe("AnchorTracker: drift and per-check callback", () => {
  it("accumulates sub-tolerance drift against the last reported position", async () => {
    const clock = new FakeClock();
    const provider = new FakeBoundsProvider();
    const moved: number[] = [];
    let x = 100;
    provider.set("a", { rect: { x, y: 0, width: 10, height: 10 }, displayId: "1" });
    const t = new AnchorTracker({ boundsProvider: provider, clock, onMoved: (_o, _e, b) => moved.push(b.rect.x), onLost: () => {} });
    t.track("o", ["a"], new Map([["a", { rect: { x, y: 0, width: 10, height: 10 }, displayId: "1" }]]));
    for (let i = 0; i < 4; i++) {
      x += 0.4; // each step is below the 0.5 DIP tolerance…
      provider.set("a", { rect: { x, y: 0, width: 10, height: 10 }, displayId: "1" });
      await t.check();
    }
    // …but they add up: reported whenever the total since the last report exceeds the tolerance
    // (+0.8 and +1.6). Before, every step was compared to the previous one and nothing was reported.
    expect(moved).toHaveLength(2);
    expect(moved[0]).toBeCloseTo(100.8);
    expect(moved[1]).toBeCloseTo(101.6);
  });

  it("calls onCheckDone once per check, after the move callbacks", async () => {
    const provider = new FakeBoundsProvider();
    const order: string[] = [];
    provider.set("a", { rect: { x: 0, y: 0, width: 10, height: 10 }, displayId: "1" });
    provider.set("b", { rect: { x: 50, y: 0, width: 10, height: 10 }, displayId: "1" });
    const t = new AnchorTracker({
      boundsProvider: provider,
      clock: new FakeClock(),
      onMoved: (_o, e) => order.push(`moved:${e}`),
      onLost: () => {},
      onCheckDone: () => order.push("done"),
    });
    t.track("o", ["a", "b"], new Map());
    await t.check();
    expect(order).toEqual(["moved:a", "moved:b", "done"]);
  });
});
});
