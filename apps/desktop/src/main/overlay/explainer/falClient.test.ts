import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FalClient } from "./falClient.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "falclient-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

// A real PNG signature (FalClient validates magic bytes) followed by filler.
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function brokerFetch(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/explainer/image")) {
      return new Response(JSON.stringify({ url: "http://127.0.0.1:1/explainer/files/x.png" }), { status: 200 });
    }
    return new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;
}

describe("FalClient", () => {
  it("serves a local asset first without touching the network", async () => {
    await writeFile(path.join(dir, "a.png"), BYTES);
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ entries: [{ prompt: "a house", styleId: "default", file: "a.png" }] }),
    );
    const fetchImpl = vi.fn();
    const c = new FalClient({ brokerUrl: "http://b", assetsDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await c.getImage("  a house  ");
    expect(r).toEqual({ ok: true, source: "asset", dataUrl: `data:image/png;base64,${BYTES.toString("base64")}` });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not match an asset with a different styleId, and falls to the broker", async () => {
    await writeFile(path.join(dir, "a.png"), BYTES);
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ entries: [{ prompt: "a house", styleId: "default", file: "a.png" }] }),
    );
    const c = new FalClient({ brokerUrl: "http://b", assetsDir: dir, fetchImpl: brokerFetch() });
    const r = await c.getImage("a house", "other");
    expect(r).toMatchObject({ ok: true, source: "broker" });
  });

  it("ignores manifest entries that escape the assets dir", async () => {
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ entries: [{ prompt: "p", styleId: "default", file: "../../etc/hosts.png" }] }),
    );
    const c = new FalClient({ brokerUrl: "http://b", assetsDir: dir, fetchImpl: brokerFetch() });
    expect(await c.getImage("p")).toMatchObject({ source: "broker" });
  });

  it("uses the broker when no manifest exists", async () => {
    const fetchImpl = brokerFetch();
    const c = new FalClient({ brokerUrl: "http://b/", assetsDir: dir, fetchImpl });
    const r = await c.getImage("p", "s");
    expect(r).toEqual({ ok: true, source: "broker", dataUrl: `data:image/png;base64,${BYTES.toString("base64")}` });
    const first = vi.mocked(fetchImpl).mock.calls[0];
    expect(first?.[0]).toBe("http://b/explainer/image");
    expect(JSON.parse(String((first?.[1] as RequestInit).body))).toEqual({ prompt: "p", styleId: "s" });
  });

  it("maps a broker error response to broker_error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 502 }));
    const c = new FalClient({ brokerUrl: "http://b", assetsDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await c.getImage("p")).toEqual({ ok: false, error: "broker_error" });
  });

  it("maps a network failure to network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const c = new FalClient({ brokerUrl: "http://b", assetsDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await c.getImage("p")).toEqual({ ok: false, error: "network" });
  });

  it("times out a hanging broker, even one that ignores the abort signal", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const c = new FalClient({
      brokerUrl: "http://b",
      assetsDir: dir,
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await c.getImage("p")).toEqual({ ok: false, error: "timeout" });
  });

  it("defaults to an 8 s bound (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const c = new FalClient({ brokerUrl: "http://b", assetsDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = c.getImage("p");
    while (fetchImpl.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(7999);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toEqual({ ok: false, error: "timeout" });
  });
});

describe("promptSimilarity / fuzzy asset match", () => {
  it("scores reworded prompts high and unrelated ones low", async () => {
    const { promptSimilarity } = await import("./falClient");
    const base = "a crumpled envelope with a fishing hook coming out of it";
    expect(promptSimilarity(base, base)).toBe(1);
    expect(promptSimilarity(base, "a crumpled envelope with a fishing hook coming out")).toBeGreaterThanOrEqual(0.6);
    expect(promptSimilarity(base, "a neat envelope with a green tick seal")).toBeLessThan(0.6);
    expect(promptSimilarity(base, "")).toBe(0);
  });
});

describe("sniffImageType", () => {
  it("recognises real image bytes and rejects everything else", async () => {
    const { sniffImageType } = await import("./falClient");
    expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("RIFF1234WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("<html>error</html>"))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("corrupt images", () => {
  it("a broker response that is not an image is a failure, not a ready picture", async () => {
    const { FalClient } = await import("./falClient");
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/explainer/image")
        ? new Response(JSON.stringify({ url: "http://127.0.0.1:1/explainer/files/x.png" }), { status: 200 })
        : new Response("<html>oops</html>", { status: 200, headers: { "content-type": "image/png" } }),
    );
    const client = new FalClient({ brokerUrl: "http://127.0.0.1:1", assetsDir: "/nonexistent", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.getImage("a cat")).toEqual({ ok: false, error: "broker_error" });
  });
});
