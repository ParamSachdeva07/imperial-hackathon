import { readFileSync } from "node:fs";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OverlayControl } from "@pointy/shared/overlay";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevServer } from "./devServer";

// Never touch a running dev session's ~/.pointy/dev-server.json.
process.env.POINTY_DEV_FILE = join(mkdtempSync(join(tmpdir(), "pointy-devserver-")), "dev-server.json");
const { DEV_SERVER_FILE, startDevServer } = await import("./devServer");

describe("devServer", () => {
  let server: DevServer;
  let token: string;
  const handleTool = vi.fn(async () => ({ ok: true, visible: true, overlayId: "hl_1" }));
  const control = {
    handleTool,
    onTurnStart: vi.fn(),
    onContextChange: vi.fn(),
    onTargetSelected: vi.fn(),
    cue: vi.fn(),
    onEvent: () => () => {},
    getOverlayWindowIds: () => [],
    withOverlayHidden: (fn: () => Promise<unknown>) => fn(),
  } as unknown as OverlayControl;

  beforeAll(async () => {
    server = await startDevServer(
      { control, sim: { simMove: vi.fn(), simRemove: vi.fn(), simRestore: vi.fn(), listElementIds: () => ["a"] }, getDisplays: () => [], getPrimaryDisplayId: () => "1" },
      0,
    );
    token = (JSON.parse(readFileSync(DEV_SERVER_FILE, "utf8")) as { token: string }).token;
  });
  afterAll(() => server.close());

  const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

  it("rejects requests without the token", async () => {
    expect((await fetch(url("/elements"))).status).toBe(403);
    expect((await fetch(url("/elements"), { headers: { "x-pointy-token": "nope" } })).status).toBe(403);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    // fetch() won't send a custom Host header, so use node:http directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path: "/elements", headers: { "x-pointy-token": token, host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("serves authorised requests and routes tool calls with the caller", async () => {
    expect(await (await fetch(url("/elements"), { headers: { "x-pointy-token": token } })).json()).toEqual(["a"]);
    const res = await fetch(url("/tool"), {
      method: "POST",
      headers: { "x-pointy-token": token, "content-type": "application/json" },
      body: JSON.stringify({ name: "clear", input: { overlayId: "all" }, caller: "controller" }),
    });
    expect(res.status).toBe(200);
    expect(handleTool).toHaveBeenCalledWith("clear", { overlayId: "all" }, { caller: "controller" });
  });

  it("returns 400 for invalid bodies and 415 for non-JSON", async () => {
    const bad = await fetch(url("/sim"), { method: "POST", headers: { "x-pointy-token": token, "content-type": "application/json" }, body: JSON.stringify({ op: "fly" }) });
    expect(bad.status).toBe(400);
    const text = await fetch(url("/tool"), { method: "POST", headers: { "x-pointy-token": token, "content-type": "text/plain" }, body: "x" });
    expect(text.status).toBe(415);
  });
});
