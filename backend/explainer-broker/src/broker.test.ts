import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrokerServer } from "./app.js";
import { buildPrompt, cacheKey, ImageService, STYLE_SUFFIX } from "./imageService.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "broker-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeService(generate = vi.fn(async (_p: string) => ({ url: "https://fal.example/x.png" }))) {
  const download = vi.fn(async (_u: string) => ({ bytes: PNG, contentType: "image/png" }));
  const service = new ImageService({ modelId: "m/1", cacheDir: dir, generate, download });
  return { service, generate, download };
}

async function withServer<T>(service: ImageService, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createBrokerServer(service, () => base);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = (base: string, body: string, type = "application/json") =>
  fetch(`${base}/explainer/image`, { method: "POST", headers: { "content-type": type }, body });

describe("prompt + cache key", () => {
  it("appends the style suffix verbatim", () => {
    expect(buildPrompt("a cat")).toBe(`a cat, ${STYLE_SUFFIX}`);
    expect(STYLE_SUFFIX.endsWith("no text, no letters, no words, no numbers")).toBe(true);
  });
  it("sends the suffixed prompt to fal", async () => {
    const { service, generate } = makeService();
    await service.getImageFile("a cat");
    expect(generate).toHaveBeenCalledWith(`a cat, ${STYLE_SUFFIX}`);
  });
  it("key is sha256(modelId + prompt + styleId)", () => {
    expect(cacheKey("m", "p", "s")).toBe(createHash("sha256").update("mps").digest("hex"));
    expect(cacheKey("m", "p", "s")).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheKey("m", "p", "s")).not.toBe(cacheKey("m", "p", "t"));
    expect(cacheKey("m", "p", "s")).not.toBe(cacheKey("n", "p", "s"));
  });
});

describe("ImageService cache", () => {
  it("a cache hit does not call fal again", async () => {
    const { service, generate, download } = makeService();
    const a = await service.getImageFile("a cat");
    const b = await service.getImageFile("a cat");
    expect(a).toBe(b);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([a]);
  });
  it("persists across service instances (disk cache)", async () => {
    const first = makeService();
    await first.service.getImageFile("a cat");
    const second = makeService();
    await second.service.getImageFile("a cat");
    expect(second.generate).not.toHaveBeenCalled();
  });
  it("different styleId is a different entry", async () => {
    const { service, generate } = makeService();
    await service.getImageFile("a cat", "a");
    await service.getImageFile("a cat", "b");
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("shares one fal call between concurrent identical requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const generate = vi.fn(async (_p: string) => {
      await gate;
      return { url: "u" };
    });
    const { service } = makeService(generate);
    const ps = [service.getImageFile("same"), service.getImageFile("same"), service.getImageFile("same")];
    release();
    const names = await Promise.all(ps);
    expect(new Set(names).size).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("does not cache failures", async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ url: "u" });
    const { service } = makeService(generate);
    await expect(service.getImageFile("x")).rejects.toThrow("boom");
    await expect(service.getImageFile("x")).resolves.toMatch(/\.png$/);
  });
});

describe("HTTP", () => {
  it("POST returns a url that serves the cached bytes", async () => {
    const { service } = makeService();
    await withServer(service, async (base) => {
      const res = await post(base, JSON.stringify({ prompt: "a cat" }));
      expect(res.status).toBe(200);
      const { url } = (await res.json()) as { url: string };
      expect(url.startsWith(`${base}/explainer/files/`)).toBe(true);
      const img = await fetch(url);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    });
  });
  it("validates the body", async () => {
    const { service, generate } = makeService();
    await withServer(service, async (base) => {
      for (const body of [{}, { prompt: "" }, { prompt: "   " }, { prompt: "x".repeat(301) }, { prompt: "a", styleId: "../x" }]) {
        const res = await post(base, JSON.stringify(body));
        expect(res.status).toBe(400);
        expect(await res.json()).toHaveProperty("error");
      }
      expect((await post(base, "not json")).status).toBe(400);
      expect((await post(base, "{}", "text/plain")).status).toBe(415);
      expect((await post(base, JSON.stringify({ prompt: "x".repeat(20000) }))).status).toBe(413);
      expect(generate).not.toHaveBeenCalled();
    });
  });
  it("maps generation errors to { error }", async () => {
    const { service } = makeService(vi.fn().mockRejectedValue(new Error("secret internal detail")));
    await withServer(service, async (base) => {
      const res = await post(base, JSON.stringify({ prompt: "a cat" }));
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("image generation failed");
    });
  });
  it("serves files safely (no traversal, strict names)", async () => {
    const { service } = makeService();
    await withServer(service, async (base) => {
      for (const p of ["../package.json", "..%2fpackage.json", "%2e%2e%2f%2e%2e%2fetc%2fpasswd", "abc.png", "x/y.png"]) {
        const res = await fetch(`${base}/explainer/files/${p}`);
        expect(res.status).toBe(404);
      }
      const missing = `${"a".repeat(64)}.png`;
      expect((await fetch(`${base}/explainer/files/${missing}`)).status).toBe(404);
    });
  });
});
