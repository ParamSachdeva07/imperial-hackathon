import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperEvent, RawElement, RawRect, RawSnapshot } from "./AxHelperClient";
import { AxBoundsProvider, type AxHelperLike } from "./AxBoundsProvider";

const el = (id: string, x = 0, y = 0, extra: Partial<RawElement> = {}): RawElement => ({
  id,
  role: "Button",
  label: id,
  window: "W",
  x,
  y,
  w: 20,
  h: 10,
  ...extra,
});

class FakeClient implements AxHelperLike {
  available = true;
  started = false;
  listeners = new Set<(e: HelperEvent) => void>();
  trustedValue = true;
  snapshots: RawSnapshot[] = [];
  snapshotCalls: Array<{ max: number; excl: number[] }> = [];
  live: Record<string, RawRect | null> = {};
  resolveCalls: string[][] = [];
  failSnapshot?: { code: string };
  activeCalls: boolean[] = [];
  async setActive(on: boolean) {
    this.activeCalls.push(on);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  onEvent(cb: (e: HelperEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(e: HelperEvent) {
    for (const l of this.listeners) l(e);
  }
  async snapshot(max: number, excl: number[]) {
    this.snapshotCalls.push({ max, excl });
    if (this.failSnapshot) throw Object.assign(new Error("x"), this.failSnapshot);
    const s = this.snapshots.shift() ?? { app: "A", pid: 1, window: "W", elements: [], truncated: false };
    return s;
  }
  async resolve(ids: string[]) {
    this.resolveCalls.push(ids);
    const out: Record<string, RawRect | null> = {};
    for (const id of ids) out[id] = this.live[id] ?? null;
    return out;
  }
  async trusted() {
    return this.trustedValue;
  }
}

const snap = (els: RawElement[]): RawSnapshot => ({ app: "A", pid: 1, window: "W", elements: els, truncated: false });

function make(client = new FakeClient(), extra = {}) {
  const p = new AxBoundsProvider({
    client,
    getDisplayMatching: (r) => ({ id: r.x >= 1000 ? 2 : 1 }),
    excludePids: () => [99],
    ...extra,
  });
  return { p, client };
}

describe("AxBoundsProvider", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("snapshotNow maps raw elements to global-DIP ElementInfo with displayId", async () => {
    const { p, client } = make();
    client.snapshots.push(snap([el("ax-1", 10, 20, { focused: true }), el("ax-2", 1200, 5)]));
    await p.start();
    const s = await p.snapshotNow("turn");
    expect(client.snapshotCalls[0]).toEqual({ max: 150, excl: [99] });
    expect(s.elements[0]).toEqual({
      id: "ax-1",
      role: "Button",
      label: "ax-1",
      window: "W",
      rect: { x: 10, y: 20, width: 20, height: 10 },
      displayId: "1",
      focused: true,
    });
    expect(s.elements[1]!.displayId).toBe("2");
    expect(p.listElements()).toBe(s.elements);
    p.stop();
  });

  it("is untrusted and returns an empty snapshot when the helper reports not_trusted", async () => {
    const client = new FakeClient();
    client.trustedValue = false;
    const { p } = make(client);
    await p.start();
    expect(p.trusted).toBe(false);
    const grants: boolean[] = [];
    p.onTrustedChange((t) => grants.push(t));
    client.failSnapshot = { code: "not_trusted" };
    const s = await p.snapshotNow("turn");
    expect(s.elements).toEqual([]);
    // grant arrives: the trust poll notices
    client.trustedValue = true;
    await vi.advanceTimersByTimeAsync(3100);
    expect(p.trusted).toBe(true);
    expect(grants).toEqual([true]);
    p.stop();
  });

  it("coalesces concurrent snapshotNow calls", async () => {
    const { p, client } = make();
    await p.start();
    const a = p.snapshotNow("turn");
    const b = p.snapshotNow("turn");
    expect(a).toBe(b);
    await a;
    expect(client.snapshotCalls).toHaveLength(1);
    p.stop();
  });

  it("getBounds resolves live and unknown ids are null", async () => {
    const { p, client } = make();
    client.snapshots.push(snap([el("ax-1", 10, 20)]));
    await p.start();
    await p.snapshotNow("turn");
    client.live["ax-1"] = { x: 15, y: 25, w: 20, h: 10 };
    await expect(p.getBounds("ax-1")).resolves.toEqual({ rect: { x: 15, y: 25, width: 20, height: 10 }, displayId: "1" });
    await expect(p.getBounds("nope")).resolves.toBeNull();
    client.live["ax-1"] = null; // element gone
    await expect(p.getBounds("ax-1")).resolves.toBeNull();
    p.stop();
  });

  it("keeps the previous turn's ids resolvable but not older ones", async () => {
    const { p, client } = make();
    await p.start();
    for (const id of ["t1", "t2", "t3", "t4"]) {
      client.snapshots.push(snap([el(id)]));
      client.live[id] = null;
      await p.snapshotNow("turn");
    }
    // current=t4, previous=[t3,t2]; t1 dropped. Older ids resolve through the live tree.
    client.live.t3 = { x: 1, y: 1, w: 20, h: 10 };
    client.live.t2 = { x: 1, y: 1, w: 20, h: 10 };
    expect((await p.getBounds("t3"))?.rect.width).toBe(20);
    expect((await p.getBounds("t2"))?.rect.width).toBe(20);
    // a successful null resolution means gone, even for an older id (no stale cached rect)
    client.live.t2 = null;
    expect(await p.getBounds("t2")).toBeNull();
    expect(await p.getBounds("t1")).toBeNull();
    // but an id in the CURRENT snapshot that is gone live is null
    expect(await p.getBounds("t4")).toBeNull();
    p.stop();
  });

  it("event-driven snapshots replace the current generation instead of rotating it", async () => {
    const { p, client } = make();
    await p.start();
    client.snapshots.push(snap([el("a")]));
    await p.snapshotNow("turn");
    client.snapshots.push(snap([el("b")]));
    await p.snapshotNow("event:AXMoved");
    client.snapshots.push(snap([el("c")]));
    await p.snapshotNow("event:AXMoved");
    client.live.a = { x: 1, y: 1, w: 5, h: 5 };
    // "a" was given to the model this turn; observer refreshes replaced it, but it must still resolve (live tree)
    expect(await p.getBounds("a")).toEqual({ rect: { x: 1, y: 1, width: 5, height: 5 }, displayId: "1" });
    client.live.a = null;
    // gone live: the helper confirmed it, so no stale cached rect
    expect(await p.getBounds("a")).toBeNull();
    // ids never known at all are still unknown
    expect(await p.getBounds("zzz")).toBeNull();
    p.stop();
  });

  it("debounces helper change events into one snapshot and fires onChange", async () => {
    const { p, client } = make();
    await p.start();
    const changes = vi.fn();
    p.onChange(changes);
    for (let i = 0; i < 5; i++) client.emit({ event: "changed", reason: "AXMoved" });
    await vi.advanceTimersByTimeAsync(149);
    expect(client.snapshotCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5);
    expect(client.snapshotCalls).toHaveLength(1);
    expect(changes).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it("reports desktop context events (not title churn) separately from anchor changes", async () => {
    const { p, client } = make();
    await p.start();
    const ctx = vi.fn();
    p.onContextEvent(ctx);
    client.emit({ event: "changed", reason: "AXWindowMoved" });
    client.emit({ event: "changed", reason: "AXTitleChanged" });
    expect(ctx).toHaveBeenCalledTimes(1);
    expect(ctx).toHaveBeenCalledWith("AXWindowMoved");
    p.stop();
  });

  it("ignores change events while untrusted", async () => {
    const client = new FakeClient();
    client.trustedValue = false;
    const { p } = make(client);
    await p.start();
    client.emit({ event: "changed", reason: "app" });
    await vi.advanceTimersByTimeAsync(500);
    expect(client.snapshotCalls).toHaveLength(0);
    p.stop();
  });

  it("forwards context events while untrusted but active, without snapshotting", async () => {
    const client = new FakeClient();
    client.trustedValue = false;
    const { p } = make(client);
    await p.start();
    p.setActive(true);
    const ctx = vi.fn();
    p.onContextEvent(ctx);
    client.emit({ event: "changed", reason: "app" });
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx).toHaveBeenCalledWith("app");
    expect(client.snapshotCalls).toHaveLength(0);
    p.stop();
  });

  it("polls anchors every 300ms only while anchors exist; onChange on >=1pt move", async () => {
    const { p, client } = make();
    client.snapshots.push(snap([el("ax-1", 10, 20)]));
    await p.start();
    await p.snapshotNow("turn");
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.resolveCalls).toHaveLength(0); // no anchors yet
    client.live["ax-1"] = { x: 10, y: 20, w: 20, h: 10 };
    await p.getBounds("ax-1"); // creates the anchor (1 live resolve)
    const base = client.resolveCalls.length;
    const changes = vi.fn();
    p.onChange(changes);
    await vi.advanceTimersByTimeAsync(300);
    expect(client.resolveCalls.length).toBe(base + 1);
    expect(changes).not.toHaveBeenCalled(); // unmoved
    client.live["ax-1"] = { x: 10.4, y: 20, w: 20, h: 10 }; // sub-point
    await vi.advanceTimersByTimeAsync(300);
    expect(changes).not.toHaveBeenCalled();
    client.live["ax-1"] = { x: 12, y: 20, w: 20, h: 10 };
    await vi.advanceTimersByTimeAsync(300);
    expect(changes).toHaveBeenCalledTimes(1);
    client.live["ax-1"] = null; // element vanished
    await vi.advanceTimersByTimeAsync(300);
    expect(changes).toHaveBeenCalledTimes(2);
    p.clearAnchors();
    const after = client.resolveCalls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.resolveCalls.length).toBe(after);
    p.stop();
  });

  it("batches all anchors into one resolve call", async () => {
    const { p, client } = make();
    client.snapshots.push(snap([el("a"), el("b")]));
    await p.start();
    await p.snapshotNow("turn");
    client.live.a = { x: 0, y: 0, w: 20, h: 10 };
    client.live.b = { x: 0, y: 0, w: 20, h: 10 };
    await p.getBounds("a");
    await p.getBounds("b");
    client.resolveCalls.length = 0;
    await vi.advanceTimersByTimeAsync(300);
    expect(client.resolveCalls).toEqual([["a", "b"]]);
    p.stop();
  });

  it("expires anchors after the TTL", async () => {
    const t = { v: 0 };
    const { p, client } = make(new FakeClient(), { anchorTtlMs: 1000, now: () => t.v });
    client.snapshots.push(snap([el("a")]));
    await p.start();
    await p.snapshotNow("turn");
    client.live.a = { x: 0, y: 0, w: 20, h: 10 };
    await p.getBounds("a");
    t.v = 5000;
    await vi.advanceTimersByTimeAsync(300);
    client.resolveCalls.length = 0;
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.resolveCalls).toHaveLength(0);
    p.stop();
  });
  it("reads nothing while inactive: events ignored, no snapshots, caches dropped, helper told", async () => {
    const { p, client } = make(new FakeClient(), { active: false });
    client.snapshots.push(snap([el("a")]));
    await p.start();
    expect(client.activeCalls).toEqual([false]);
    const ctx: string[] = [];
    p.onContextEvent((r) => ctx.push(r));
    client.emit({ event: "changed", reason: "AXFocusedWindowChanged" });
    await vi.advanceTimersByTimeAsync(500);
    expect(client.snapshotCalls).toHaveLength(0);
    expect((await p.snapshotNow("turn")).elements).toEqual([]);
    expect(client.snapshotCalls).toHaveLength(0);

    p.setActive(true);
    expect(client.activeCalls).toEqual([false, true]);
    expect((await p.snapshotNow("turn")).elements).toHaveLength(1);
    client.live.a = { x: 0, y: 0, w: 20, h: 10 };
    expect(await p.getBounds("a")).not.toBeNull();

    p.setActive(false);
    expect(p.listElements()).toEqual([]);
    expect(await p.getBounds("a")).toBeNull(); // previous/shadow caches dropped too
    client.snapshotCalls.length = 0;
    client.emit({ event: "changed", reason: "AXWindowMoved" });
    await vi.advanceTimersByTimeAsync(500);
    expect(client.snapshotCalls).toHaveLength(0);
    // a restarted helper starts inactive: the provider re-sends its state on ready
    client.emit({ event: "ready", trusted: true });
    expect(client.activeCalls.at(-1)).toBe(false);
    p.stop();
  });
});
