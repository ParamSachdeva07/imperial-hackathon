import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AnamSpeaker, AnamSpeakerError } from "./AnamSpeaker";

interface Req { method: string; url: string; token: string | undefined; origin: string | undefined; body: unknown }

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function stub(handler: (r: Req) => { status: number; body: unknown }) {
  const seen: Req[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const r: Req = { method: req.method ?? "", url: req.url ?? "", token: req.headers["x-anam-control-token"] as string | undefined, origin: req.headers.origin, body: raw ? JSON.parse(raw) : undefined };
      seen.push(r);
      const out = handler(r);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const speaker = new AnamSpeaker({ readFile: () => JSON.stringify({ port, token: "tok", pid: 1 }), isProcessAlive: () => true });
  return { seen, speaker };
}

describe("AnamSpeaker", () => {
  it("posts session/talk/interrupt with the token and no Origin", async () => {
    const { seen, speaker } = await stub(() => ({ status: 200, body: { ok: true } }));
    await speaker.startSession();
    await speaker.talk({ turnId: "t1-r1", text: "Hello", final: false });
    await speaker.talk({ turnId: "t1-r1", text: "", final: true });
    await speaker.interrupt();
    await speaker.endSession();
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /session", "POST /talk", "POST /talk", "POST /interrupt", "POST /session"]);
    expect(seen[0]?.body).toEqual({ action: "start" });
    expect(seen[1]?.body).toEqual({ turnId: "t1-r1", text: "Hello", final: false });
    expect(seen[2]?.body).toEqual({ turnId: "t1-r1", text: "", final: true });
    expect(seen[4]?.body).toEqual({ action: "end" });
    expect(seen.every((r) => r.token === "tok" && r.origin === undefined)).toBe(true);
  });

  it("reads /state and throws AnamSpeakerError on 503", async () => {
    const { speaker } = await stub((r) =>
      r.url === "/state" ? { status: 200, body: { ok: true, state: { expanded: true, connected: true, speaking: false } } } : { status: 503, body: { ok: false, reason: "not_in_call" } },
    );
    expect(await speaker.state()).toEqual({ connected: true, speaking: false, expanded: true });
    await expect(speaker.talk({ turnId: "x", text: "hi", final: true })).rejects.toMatchObject({ name: "AnamSpeakerError", status: 503 });
  });

  it("state() is null and calls throw when anam is unreachable or the pid is stale", async () => {
    const down = new AnamSpeaker({ readFile: () => { throw new Error("ENOENT"); } });
    expect(await down.state()).toBeNull();
    await expect(down.startSession()).rejects.toBeInstanceOf(AnamSpeakerError);
    let fetched = false;
    const stale = new AnamSpeaker({ readFile: () => JSON.stringify({ port: 1, token: "t", pid: 99999 }), isProcessAlive: () => false, fetch: (() => { fetched = true; return Promise.reject(new Error("no")); }) as unknown as typeof fetch });
    expect(await stale.state()).toBeNull();
    expect(fetched).toBe(false); // the token is never sent to a dead pid's port
  });
});
