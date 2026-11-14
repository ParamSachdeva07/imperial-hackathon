/**
 * Dev server (spec §8.1): localhost-only HTTP API the `pointy-draw` CLI talks to. Dev builds only.
 *
 * Security: binds 127.0.0.1; every request needs the `X-Pointy-Token` header (random per run,
 * written to ~/.pointy/dev-server.json with mode 0600); Host must be 127.0.0.1/localhost (blocks
 * DNS rebinding). Browsers can't add custom headers cross-origin without a CORS preflight, which
 * we never grant, so web pages cannot drive the overlay.
 *
 *   POST /tool     { name, input }                      → ToolResult
 *   POST /control  { op: turnStart|contextChange|targetSelected|cue, arg? }
 *   POST /sim      { op: move|remove|restore, elementId?, dx?, dy? }
 *   GET  /events   Server-Sent Events: { at, event: OverlayEvent }
 *   GET  /state    debug snapshot     GET /displays     GET /elements
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DisplayInfo, OverlayControl, OverlayEvent } from "@pointy/shared/overlay";

/** Connection file for the CLI (POINTY_DEV_FILE overrides, e.g. so e2e runs never touch a dev session). */
export const DEV_SERVER_FILE = process.env.POINTY_DEV_FILE ?? join(homedir(), ".pointy", "dev-server.json");
const MAX_BODY = 256 * 1024;

export interface DevServerDeps {
  control: OverlayControl & { debugState?: () => unknown };
  sim: {
    simMove(elementId: string, dx: number, dy: number): void;
    simRemove(elementId: string): void;
    simRestore(elementId?: string): void;
    listElementIds(): string[];
  };
  getDisplays: () => DisplayInfo[];
  getPrimaryDisplayId: () => string;
  /** Extra POST routes (e.g. the realtime test harness). */
  extraRoutes?: Record<string, (body: unknown) => Promise<unknown>>;
}

const ToolBody = z.object({ name: z.string(), input: z.unknown(), caller: z.enum(["user", "model", "controller"]).optional() });
const ControlBody = z.discriminatedUnion("op", [
  z.object({ op: z.literal("turnStart"), arg: z.string().min(1) }),
  z.object({ op: z.literal("contextChange") }),
  z.object({ op: z.literal("targetSelected"), arg: z.string().min(1) }),
  z.object({ op: z.literal("cue"), arg: z.string().min(1) }),
]);
const SimBody = z.discriminatedUnion("op", [
  z.object({ op: z.literal("move"), elementId: z.string(), dx: z.number(), dy: z.number() }),
  z.object({ op: z.literal("remove"), elementId: z.string() }),
  z.object({ op: z.literal("restore"), elementId: z.string().optional() }),
]);

export interface DevServer {
  port: number;
  close(): Promise<void>;
}

export async function startDevServer(deps: DevServerDeps, port = Number(process.env.POINTY_DEV_PORT ?? 47615)): Promise<DevServer> {
  const token = randomBytes(24).toString("hex");
  const sseClients = new Set<ServerResponse>();
  const off = deps.control.onEvent((event: OverlayEvent) => {
    const line = `data: ${JSON.stringify({ at: Date.now(), event })}\n\n`;
    for (const res of sseClients) res.write(line);
  });

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) =>
      err instanceof z.ZodError || err instanceof SyntaxError
        ? send(res, 400, { error: err instanceof z.ZodError ? z.prettifyError(err) : "invalid JSON" })
        : send(res, 500, { error: String(err) }),
    );
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") return send(res, 403, { error: "bad host" });
    if (req.headers["x-pointy-token"] !== token) return send(res, 403, { error: "bad token" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET") {
      switch (url.pathname) {
        case "/events":
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(": connected\n\n");
          sseClients.add(res);
          req.on("close", () => sseClients.delete(res));
          return;
        case "/state":
          return send(res, 200, deps.control.debugState?.() ?? []);
        case "/displays":
          return send(res, 200, { primary: deps.getPrimaryDisplayId(), displays: deps.getDisplays() });
        case "/elements":
          return send(res, 200, deps.sim.listElementIds());
      }
      return send(res, 404, { error: "not found" });
    }

    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "json only" });
    const body = await readJson(req);

    switch (url.pathname) {
      case "/tool": {
        const b = ToolBody.parse(body);
        return send(res, 200, { requestedAt: Date.now(), result: await deps.control.handleTool(b.name, b.input, b.caller ? { caller: b.caller } : {}) });
      }
      case "/control": {
        const b = ControlBody.parse(body);
        if (b.op === "turnStart") deps.control.onTurnStart(b.arg);
        else if (b.op === "contextChange") deps.control.onContextChange();
        else if (b.op === "targetSelected") deps.control.onTargetSelected(b.arg);
        else deps.control.cue(b.arg);
        return send(res, 200, { ok: true });
      }
      case "/sim": {
        const b = SimBody.parse(body);
        if (b.op === "move") deps.sim.simMove(b.elementId, b.dx, b.dy);
        else if (b.op === "remove") deps.sim.simRemove(b.elementId);
        else deps.sim.simRestore(b.elementId);
        return send(res, 200, { ok: true });
      }
    }
    const extra = deps.extraRoutes?.[url.pathname];
    if (extra) return send(res, 200, await extra(body));
    return send(res, 404, { error: "not found" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const actualPort = (server.address() as { port: number }).port;
  mkdirSync(dirname(DEV_SERVER_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(DEV_SERVER_FILE, JSON.stringify({ port: actualPort, token, pid: process.pid }), { mode: 0o600 });
  chmodSync(DEV_SERVER_FILE, 0o600);

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        off();
        for (const r of sseClients) r.end();
        rmSync(DEV_SERVER_FILE, { force: true });
        server.close(() => resolve());
      }),
  };
}

function send(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
