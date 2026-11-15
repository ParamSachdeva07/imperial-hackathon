import type { GestureEvent } from "@pointy/gestures";
import { describe, expect, it, vi } from "vitest";
import { DevSessionController } from "./DevSessionController";

function setup(idleMs = 1000) {
  let now = 0;
  const pending: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (h: unknown) => {
      const i = pending.findIndex((p) => p.id === h);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const p of [...pending].sort((a, b) => a.at - b.at)) {
      if (p.at <= now) {
        pending.splice(pending.indexOf(p), 1);
        p.fn();
      }
    }
  };
  let handler: ((e: GestureEvent) => void) | null = null;
  const off = vi.fn();
  const service = {
    onAny: (cb: (e: GestureEvent) => void) => {
      handler = cb;
      return off;
    },
    setSessionActive: vi.fn(),
  };
  const ctl = new DevSessionController({ service, idleMs, timers });
  const emit = (e: Partial<GestureEvent> & { type: GestureEvent["type"] }) => handler?.(e as GestureEvent);
  return { ctl, service, advance, emit, off, pending };
}

describe("DevSessionController", () => {
  it("wake opens, idle closes", () => {
    const { ctl, service, advance, emit } = setup();
    const changes: boolean[] = [];
    ctl.onChange((a) => changes.push(a));
    emit({ type: "wake_requested" });
    expect(ctl.isActive()).toBe(true);
    expect(service.setSessionActive).toHaveBeenLastCalledWith(true);
    advance(999);
    expect(ctl.isActive()).toBe(true);
    advance(1);
    expect(ctl.isActive()).toBe(false);
    expect(service.setSessionActive).toHaveBeenLastCalledWith(false);
    expect(changes).toEqual([true, false]);
  });

  it("other events reset the idle timer; events while closed are ignored", () => {
    const { ctl, advance, emit, pending } = setup();
    emit({ type: "cursor_moved" });
    expect(ctl.isActive()).toBe(false);
    expect(pending).toHaveLength(0);
    emit({ type: "wake_requested" });
    advance(800);
    emit({ type: "cursor_moved" });
    advance(800);
    expect(ctl.isActive()).toBe(true);
    advance(200);
    expect(ctl.isActive()).toBe(false);
  });

  it("wake while open does not re-notify", () => {
    const { ctl, service, emit } = setup();
    emit({ type: "wake_requested" });
    emit({ type: "wake_requested" });
    expect(service.setSessionActive).toHaveBeenCalledTimes(1);
    expect(ctl.isActive()).toBe(true);
  });

  it("open/close are idempotent and manual", () => {
    const { ctl, service, pending } = setup();
    ctl.open();
    ctl.open();
    expect(service.setSessionActive).toHaveBeenCalledTimes(1);
    ctl.close();
    ctl.close();
    expect(service.setSessionActive).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(0);
  });

  it("onChange unsubscribes; dispose detaches and clears timers", () => {
    const { ctl, off, pending, emit } = setup();
    const cb = vi.fn();
    const un = ctl.onChange(cb);
    un();
    ctl.open();
    expect(cb).not.toHaveBeenCalled();
    ctl.dispose();
    expect(off).toHaveBeenCalled();
    expect(pending).toHaveLength(0);
    expect(ctl.isActive()).toBe(false);
    emit({ type: "wake_requested" });
    expect(ctl.isActive()).toBe(false);
  });
});

describe("DevSessionController manual mode (production)", () => {
  it("ignores wake_requested and never idles out; only open()/close() drive the session", () => {
    const box: { handler?: (e: GestureEvent) => void } = {};
    const service = {
      onAny: (cb: (e: GestureEvent) => void) => {
        box.handler = cb;
        return () => {};
      },
      setSessionActive: vi.fn(),
    };
    const set = vi.fn();
    const ctl = new DevSessionController({ service, idleMs: 10, manual: true, timers: { setTimeout: set, clearTimeout: () => {} } });
    box.handler?.({ type: "wake_requested" } as GestureEvent);
    expect(ctl.isActive()).toBe(false);
    ctl.open();
    expect(ctl.isActive()).toBe(true);
    expect(service.setSessionActive).toHaveBeenCalledWith(true);
    expect(set).not.toHaveBeenCalled();
    ctl.close();
    expect(ctl.isActive()).toBe(false);
  });
});
