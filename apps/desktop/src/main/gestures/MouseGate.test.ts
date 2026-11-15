import { describe, expect, it, vi } from "vitest";
import { gateMouseToSession } from "./MouseGate";

function fakeSession() {
  let active = false;
  const cbs = new Set<(a: boolean) => void>();
  return {
    isActive: () => active,
    onChange: (cb: (a: boolean) => void) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    set(a: boolean) {
      active = a;
      for (const c of cbs) c(a);
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("gateMouseToSession", () => {
  it("attaches on open and detaches on close", async () => {
    const s = fakeSession();
    const detach = vi.fn();
    const attach = vi.fn(async () => detach);
    gateMouseToSession(s, attach);
    expect(attach).not.toHaveBeenCalled();
    s.set(true);
    await tick();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(detach).not.toHaveBeenCalled();
    s.set(false);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("detaches immediately when attach resolves after close", async () => {
    const s = fakeSession();
    const detach = vi.fn();
    let resolve!: (d: () => void) => void;
    gateMouseToSession(s, () => new Promise((r) => (resolve = r)));
    s.set(true);
    s.set(false);
    resolve(detach);
    await tick();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("a stale attach does not clobber a newer open/close cycle", async () => {
    const s = fakeSession();
    const d1 = vi.fn();
    const d2 = vi.fn();
    const resolvers: ((d: () => void) => void)[] = [];
    gateMouseToSession(s, () => new Promise((r) => resolvers.push(r)));
    s.set(true);
    s.set(false);
    s.set(true);
    resolvers[1]?.(d2);
    await tick();
    resolvers[0]?.(d1);
    await tick();
    expect(d1).toHaveBeenCalledTimes(1);
    expect(d2).not.toHaveBeenCalled();
    s.set(false);
    expect(d2).toHaveBeenCalledTimes(1);
  });

  it("dispose detaches and logs attach failures without throwing", async () => {
    const s = fakeSession();
    const detach = vi.fn();
    const log = vi.fn();
    const dispose = gateMouseToSession(s, async () => detach, log);
    s.set(true);
    await tick();
    dispose();
    expect(detach).toHaveBeenCalledTimes(1);

    const s2 = fakeSession();
    gateMouseToSession(s2, async () => Promise.reject(new Error("boom")), log);
    s2.set(true);
    await tick();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
