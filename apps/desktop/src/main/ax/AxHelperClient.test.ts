import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxHelperClient, AxHelperError, type HelperEvent, type HelperProcess } from "./AxHelperClient";

/** A fake stdio helper speaking the JSON-lines protocol. */
class FakeHelper extends EventEmitter {
  readonly stdoutEmitter = new EventEmitter();
  readonly written: Array<Record<string, unknown>> = [];
  killed = false;
  stdin = Object.assign(new EventEmitter(), {
    write: (s: string) => {
      for (const line of s.split("\n").filter(Boolean)) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.written.push(msg);
        this.respond?.(msg);
      }
    },
  });
  stdout = { on: (_: "data", cb: (c: Buffer | string) => void) => this.stdoutEmitter.on("data", cb) };
  respond?: (msg: Record<string, unknown>) => void;
  kill() {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
  }
  send(obj: unknown, split = false) {
    const line = `${JSON.stringify(obj)}\n`;
    if (split) {
      this.stdoutEmitter.emit("data", line.slice(0, 7));
      this.stdoutEmitter.emit("data", Buffer.from(line.slice(7)));
    } else this.stdoutEmitter.emit("data", line);
  }
}

function setup(opts: Partial<ConstructorParameters<typeof AxHelperClient>[0]> = {}) {
  const procs: FakeHelper[] = [];
  const client = new AxHelperClient({
    binPath: "/fake/pointy-ax",
    spawn: () => {
      const p = new FakeHelper();
      p.respond = (m) => {
        if (m.cmd === "trusted") p.send({ id: m.id, ok: true, trusted: true });
        else if (m.cmd === "resolve") p.send({ id: m.id, ok: true, rects: { a: { x: 1, y: 2, w: 3, h: 4 }, b: null } });
        else if (m.cmd === "snapshot")
          p.send({ id: m.id, ok: true, app: "X", pid: 1, window: "W", elements: [], truncated: false });
      };
      procs.push(p);
      return p as unknown as HelperProcess;
    },
    killOnExit: false,
    requestTimeoutMs: 100,
    restartBaseMs: 10,
    restartMaxMs: 40,
    ...opts,
  });
  return { client, procs };
}

describe("AxHelperClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("frames requests and responses across chunk boundaries", async () => {
    const { client, procs } = setup();
    client.start();
    procs[0]!.respond = (m) => procs[0]!.send({ id: m.id, ok: true, trusted: true }, true);
    await expect(client.trusted()).resolves.toBe(true);
    client.stop();
  });

  it("an async stdin error (EPIPE) rejects pending requests and restarts the helper", async () => {
    const { client, procs } = setup();
    client.start();
    procs[0]!.respond = () => {};
    const p = client.trusted();
    const assertion = expect(p).rejects.toBeInstanceOf(AxHelperError);
    expect(() => procs[0]!.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
    await assertion;
    await vi.advanceTimersByTimeAsync(20);
    expect(procs.length).toBe(2);
    client.stop();
  });

  it("sends snapshot/resolve with parameters", async () => {
    const { client, procs } = setup();
    client.start();
    const snap = await client.snapshot(150, [42]);
    expect(snap.app).toBe("X");
    expect(procs[0]!.written[0]).toMatchObject({ cmd: "snapshot", maxElements: 150, excludePids: [42] });
    await expect(client.resolve(["a", "b"])).resolves.toEqual({ a: { x: 1, y: 2, w: 3, h: 4 }, b: null });
    client.stop();
  });

  it("rejects helper errors with a code", async () => {
    const { client, procs } = setup();
    client.start();
    procs[0]!.respond = (m) => procs[0]!.send({ id: m.id, ok: false, error: "not_trusted" });
    await expect(client.snapshot(10, [])).rejects.toMatchObject({ code: "not_trusted" });
    client.stop();
  });

  it("times out silent requests", async () => {
    const { client, procs } = setup();
    client.start();
    procs[0]!.respond = undefined;
    const p = client.trusted();
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    client.stop();
  });

  it("emits events and rejects in-flight requests when the helper dies, then restarts with backoff", async () => {
    const { client, procs } = setup();
    const events: HelperEvent[] = [];
    client.onEvent((e) => events.push(e));
    client.start();
    procs[0]!.send({ event: "changed", reason: "app" });
    expect(events).toEqual([{ event: "changed", reason: "app" }]);
    procs[0]!.respond = undefined;
    const inflight = client.trusted();
    const assertion = expect(inflight).rejects.toBeInstanceOf(AxHelperError);
    procs[0]!.emit("exit", 1, null);
    await assertion;
    expect(client.running).toBe(false);
    await vi.advanceTimersByTimeAsync(11);
    expect(procs).toHaveLength(2);
    await expect(client.trusted()).resolves.toBe(true);
    client.stop();
  });

  it("gives up after repeated failures and does not restart once stopped", async () => {
    const { client, procs } = setup({ maxConsecutiveFailures: 2 });
    client.start();
    for (let i = 0; i < 3; i++) {
      procs.at(-1)!.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(client.available).toBe(false);
    const count = procs.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(procs).toHaveLength(count);
    client.stop();
  });

  it("stop kills the child and rejects further requests", async () => {
    const { client, procs } = setup();
    client.start();
    client.stop();
    expect(procs[0]!.killed).toBe(true);
    await expect(client.trusted()).rejects.toMatchObject({ code: "not_running" });
  });

  it("is unavailable when the binary is missing", () => {
    const { client } = setup({ binPath: "/definitely/not/here", checkBinary: true });
    client.start();
    expect(client.available).toBe(false);
    expect(client.running).toBe(false);
  });

  it("elementAt sends coordinates and returns the element or null; helper errors reject", async () => {
    const { client, procs } = setup();
    client.start();
    const p = procs[0]!;
    const base = p.respond!;
    p.respond = (m) => {
      if (m.cmd !== "elementAt") return base(m);
      if (m.x === 1) p.send({ id: m.id, ok: true, element: { id: "ax-1", role: "Button", label: "OK", window: "W", x: 1, y: 2, w: 3, h: 4 } });
      else if (m.x === 2) p.send({ id: m.id, ok: true, element: null });
      else p.send({ id: m.id, ok: false, error: "inactive" });
    };
    expect((await client.elementAt(1, 5, [7]))?.id).toBe("ax-1");
    expect(p.written.at(-1)).toMatchObject({ cmd: "elementAt", x: 1, y: 5, excludePids: [7] });
    expect(await client.elementAt(2, 5)).toBeNull();
    await expect(client.elementAt(3, 5)).rejects.toMatchObject({ code: "inactive" });
  });

  it("elementAt times out", async () => {
    const { client, procs } = setup();
    client.start();
    procs[0]!.respond = () => {};
    const r = client.elementAt(1, 1);
    const check = expect(r).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(150);
    await check;
  });
});
