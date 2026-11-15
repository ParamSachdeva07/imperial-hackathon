import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realClock } from "../clock";
import { AnamAvatarClient, ANAM_TOKEN_HEADER, type AnamState } from "./AnamAvatarClient";

const WA = { x: 0, y: 25, width: 1440, height: 875 };
const BOUNDS = { x: 1096, y: 49, width: 320, height: 400 };

interface Stub {
  server: Server;
  port: number;
  state: AnamState | null;
  moves: { x: number; y: number }[];
  requests: { method: string; url: string; token: string | undefined; origin: string | undefined }[];
  moveStatus: 200 | 409;
  moveReason: string;
}

async function startStub(token: string, initial: AnamState | null): Promise<Stub> {
  const stub = { state: initial, moves: [], requests: [], moveStatus: 200, moveReason: "dragging" } as unknown as Stub;
  stub.server = createServer((req: IncomingMessage, res) => {
    stub.requests.push({ method: req.method ?? "", url: req.url ?? "", token: req.headers[ANAM_TOKEN_HEADER] as string | undefined, origin: req.headers.origin });
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers[ANAM_TOKEN_HEADER] !== token) return reply(401, { ok: false });
    if (req.method === "GET" && req.url === "/state") {
      return stub.state ? reply(200, { ok: true, state: stub.state }) : reply(503, { ok: false, reason: "no_window" });
    }
    if (req.method === "POST" && req.url === "/move") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const p = JSON.parse(raw) as { x: number; y: number };
        stub.moves.push(p);
        if (stub.moveStatus === 409) return reply(409, { ok: false, reason: stub.moveReason });
        const bounds = { ...BOUNDS, x: p.x, y: p.y };
        if (stub.state) stub.state = { ...stub.state, bounds };
        reply(200, { ok: true, bounds });
      });
      return;
    }
    reply(404, { ok: false });
  });
  await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", r));
  stub.port = (stub.server.address() as { port: number }).port;
  return stub;
}

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
const expanded = (extra: Partial<AnamState> = {}): AnamState => ({ expanded: true, dragging: false, bounds: BOUNDS, workArea: WA, displayId: "1", ...extra });

describe("AnamAvatarClient", () => {
  let dir: string;
  let file: string;
  let stubs: Stub[];
  let client: AnamAvatarClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anam-client-"));
    file = join(dir, "anam-control.json");
    stubs = [];
  });
  afterEach(async () => {
    client?.dispose();
    for (const s of stubs) await close(s.server);
    rmSync(dir, { recursive: true, force: true });
  });

  const stub = async (token: string, state: AnamState | null) => {
    const s = await startStub(token, state);
    stubs.push(s);
    return s;
  };
  const publish = (s: Stub, token: string) => writeFileSync(file, JSON.stringify({ port: s.port, token, pid: 1 }));

  it("reads state with the token header and no Origin; exposes bounds, movability and avoid rects", async () => {
    const s = await stub("tok", expanded());
    publish(s, "tok");
    client = new AnamAvatarClient({ controlFile: file });
    expect(client.getBounds()).toBeNull(); // nothing polled yet
    expect(client.isMovable()).toBe(false);
    await client.refresh();
    expect(client.getBounds()).toEqual(BOUNDS);
    expect(client.isMovable()).toBe(true);
    expect(client.getAvoidRects()).toEqual([BOUNDS]);
    expect(s.requests[0]).toMatchObject({ method: "GET", url: "/state", token: "tok", origin: undefined });
  });

  it("collapsed: no bounds, no avoid rects, not movable (and moveTo does not call out)", async () => {
    const s = await stub("tok", expanded({ expanded: false, bounds: { x: 1380, y: 40, width: 56, height: 56 } }));
    publish(s, "tok");
    client = new AnamAvatarClient({ controlFile: file });
    await client.refresh();
    expect(client.getBounds()).toBeNull();
    expect(client.getAvoidRects()).toEqual([]);
    expect(client.isMovable()).toBe(false);
    expect(await client.moveTo({ x: 10, y: 10 })).toBeNull();
    expect(s.moves).toEqual([]);
  });

  it("dragging: avoid rect stays but it is not movable", async () => {
    const s = await stub("tok", expanded({ dragging: true }));
    publish(s, "tok");
    client = new AnamAvatarClient({ controlFile: file });
    await client.refresh();
    expect(client.getAvoidRects()).toEqual([BOUNDS]);
    expect(client.isMovable()).toBe(false);
  });

  it("moveTo posts the top-left and updates the cache from the response", async () => {
    const s = await stub("tok", expanded());
    publish(s, "tok");
    client = new AnamAvatarClient({ controlFile: file });
    await client.refresh();
    expect(await client.moveTo({ x: 24, y: 451 })).toEqual({ ...BOUNDS, x: 24, y: 451 });
    expect(s.moves).toEqual([{ x: 24, y: 451 }]);
    expect(client.getBounds()).toEqual({ ...BOUNDS, x: 24, y: 451 });
  });

  it("a 409 resolves null and updates the cached state", async () => {
    const s = await stub("tok", expanded());
    publish(s, "tok");
    client = new AnamAvatarClient({ controlFile: file });
    await client.refresh();
    s.moveStatus = 409;
    s.moveReason = "collapsed";
    expect(await client.moveTo({ x: 1, y: 1 })).toBeNull();
    expect(client.isMovable()).toBe(false);
    expect(client.getBounds()).toBeNull();
  });

  it("503 (no window) clears the cache; it comes back when the window does", async () => {
    const s = await stub("tok", expanded());
    publish(s, "tok");
    client = new AnamAvatarClient({ controlFile: file });
    await client.refresh();
    s.state = null;
    await client.refresh();
    expect(client.getBounds()).toBeNull();
    s.state = expanded();
    await client.refresh();
    expect(client.getBounds()).toEqual(BOUNDS);
  });

  it("never throws: missing discovery file, dead port, garbage file", async () => {
    client = new AnamAvatarClient({ controlFile: join(dir, "missing.json"), timeoutMs: 200 });
    await expect(client.refresh()).resolves.toBeNull();
    await expect(client.moveTo({ x: 0, y: 0 })).resolves.toBeNull();
    const s = await stub("tok", expanded());
    const dead = s.port;
    await close(s.server);
    stubs.pop();
    writeFileSync(file, JSON.stringify({ port: dead, token: "tok", pid: 1 }));
    client = new AnamAvatarClient({ controlFile: file, timeoutMs: 200 });
    await expect(client.refresh()).resolves.toBeNull();
    writeFileSync(file, "not json");
    client = new AnamAvatarClient({ controlFile: file });
    await expect(client.refresh()).resolves.toBeNull();
    expect(client.getAvoidRects()).toEqual([]);
  });

  it("re-reads the discovery file after a failure (Anam restarted on a new port/token)", async () => {
    const first = await stub("old", expanded());
    publish(first, "old");
    client = new AnamAvatarClient({ controlFile: file, timeoutMs: 300 });
    await client.refresh();
    expect(client.getBounds()).toEqual(BOUNDS);
    await close(first.server);
    stubs.shift();
    const second = await stub("new", expanded({ bounds: { ...BOUNDS, x: 500 } }));
    publish(second, "new");
    await client.refresh();
    expect(client.getBounds()).toEqual({ ...BOUNDS, x: 500 });
    expect(second.requests[0]?.token).toBe("new");
  });

  it("polls on an interval after start() and stops on dispose()", async () => {
    const s = await stub("tok", expanded());
    publish(s, "tok");
    client = new AnamAvatarClient({ controlFile: file, intervalMs: 20 });
    client.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(s.requests.length).toBeGreaterThanOrEqual(3);
    expect(client.getBounds()).toEqual(BOUNDS);
    client.dispose();
    const n = s.requests.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(s.requests.length).toBeLessThanOrEqual(n + 1); // at most the one already in flight
    expect(client.getBounds()).toBeNull();
  });

  it("recovers from a 401 when Anam restarts on the SAME port with a new token", async () => {
    const first = await stub("old", expanded());
    publish(first, "old");
    client = new AnamAvatarClient({ controlFile: file, timeoutMs: 300 });
    await client.refresh();
    const port = first.port;
    await close(first.server);
    stubs.shift();
    const second = { state: expanded({ bounds: { ...BOUNDS, x: 7 } }), moves: [], requests: [], moveStatus: 200, moveReason: "" } as unknown as Stub;
    second.server = createServer((req, res) => {
      second.requests.push({ method: req.method ?? "", url: req.url ?? "", token: req.headers[ANAM_TOKEN_HEADER] as string | undefined, origin: undefined });
      res.writeHead(req.headers[ANAM_TOKEN_HEADER] === "new" ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, state: second.state }));
    });
    await new Promise<void>((r) => second.server.listen(port, "127.0.0.1", r));
    second.port = port;
    stubs.push(second);
    writeFileSync(file, JSON.stringify({ port, token: "new", pid: 1 }));
    await client.refresh();
    expect(client.getBounds()).toEqual({ ...BOUNDS, x: 7 });
  });

  it("on 401 with an unchanged discovery file, drops the cached connection so the next poll re-reads", async () => {
    const s = await stub("tok", expanded());
    publish(s, "wrong");
    client = new AnamAvatarClient({ controlFile: file });
    await client.refresh();
    expect(client.getBounds()).toBeNull();
    publish(s, "tok");
    await client.refresh();
    expect(client.getBounds()).toEqual(BOUNDS);
  });

  it("treats a dead pid (ESRCH) as no connection and never contacts the port", async () => {
    const s = await stub("tok", expanded());
    publish(s, "tok");
    let alive = false;
    client = new AnamAvatarClient({ controlFile: file, isProcessAlive: () => alive });
    await client.refresh();
    expect(s.requests).toEqual([]);
    expect(client.getBounds()).toBeNull();
    alive = true;
    await client.refresh();
    expect(client.getBounds()).toEqual(BOUNDS);
    alive = false; // crash after caching the connection
    await client.refresh();
    expect(s.requests.length).toBe(1);
  });

  it("keeps the last good state through a transient failure for the grace period, then nulls it", async () => {
    const s = await stub("tok", expanded());
    publish(s, "tok");
    let now = 1000;
    client = new AnamAvatarClient({ controlFile: file, timeoutMs: 200, clock: { ...realClock, now: () => now } });
    await client.refresh();
    await close(s.server);
    stubs.pop();
    now += 1500;
    await client.refresh();
    expect(client.getBounds()).toEqual(BOUNDS);
    expect(client.hasLiveState()).toBe(true);
    now += 600;
    await client.refresh();
    expect(client.getBounds()).toBeNull();
    expect(client.hasLiveState()).toBe(false);
  });

  it("a definitive no_window answer clears immediately even inside the grace period", async () => {
    const s = await stub("tok", expanded());
    publish(s, "tok");
    client = new AnamAvatarClient({ controlFile: file });
    await client.refresh();
    s.state = null;
    await client.refresh();
    expect(client.hasLiveState()).toBe(false);
  });

  it("dispose() during an in-flight refresh leaves the state null; start() is idempotent and restartable", async () => {
    const s = await stub("tok", expanded());
    publish(s, "tok");
    client = new AnamAvatarClient({ controlFile: file, intervalMs: 1000 });
    const p = client.refresh();
    client.dispose();
    await p;
    expect(client.getBounds()).toBeNull();
    client.start();
    client.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.requests.length).toBe(2); // 1 from the disposed refresh + 1 first poll (one loop only)
    client.dispose();
    client.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(client.getBounds()).toEqual(BOUNDS);
  });
});
