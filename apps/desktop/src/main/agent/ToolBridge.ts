/**
 * Local server the avatar app calls in agent mode, where an ElevenLabs agent runs the conversation:
 *   GET  /tools                      -> { tools: string[] }   the tool names to register with the Anam SDK
 *   POST /tool  { name, arguments }  -> { result: string }    run one tool the agent called
 *   POST /event { role, id, content, end, interrupted }       what was just said (status and idle timing)
 * Loopback only, token in a 0600 discovery file. No electron import.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const toolBridgeFile = (): string => process.env.POINTY_TOOL_BRIDGE_FILE || join(homedir(), ".pointy", "tool-bridge.json");

export interface SpokenEvent {
  role: "user" | "persona";
  id: string;
  content: string;
  end: boolean;
  interrupted: boolean;
}

export interface ToolBridgeDeps {
  toolNames(): string[];
  /** Run a tool; the returned value is given to the agent as text. */
  runTool(name: string, args: unknown): Promise<unknown>;
  onSpoken(event: SpokenEvent): void;
  file?: string | null;
  log?(msg: string): void;
}

export class ToolBridge {
  private server?: http.Server;
  private readonly token = randomBytes(24).toString("hex");
  port = 0;

  constructor(private readonly deps: ToolBridgeDeps) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    const file = this.deps.file === undefined ? toolBridgeFile() : this.deps.file;
    if (file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ port: this.port, token: this.token, pid: process.pid }), { mode: 0o600 });
    }
  }

  stop(): void {
    this.server?.closeAllConnections();
    this.server?.close();
    const file = this.deps.file === undefined ? toolBridgeFile() : this.deps.file;
    if (file) rmSync(file, { force: true });
  }

  /** For tests: the header value a caller must send. */
  tokenForTests(): string {
    return this.token;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const given = Buffer.from(String(req.headers["x-tool-bridge-token"] ?? ""));
      const expected = Buffer.from(this.token);
      // A web page can reach loopback, so it must never be answered: it has no token, and an Origin header is refused outright.
      if (req.headers.origin !== undefined || given.length !== expected.length || !timingSafeEqual(given, expected)) return send(401, { ok: false });
      const route = `${req.method} ${(req.url ?? "").split("?")[0]}`;
      if (route === "GET /tools") return send(200, { tools: this.deps.toolNames() });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 64_000) return send(413, { ok: false });
      }
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (route === "POST /tool") {
        if (typeof body.name !== "string" || !this.deps.toolNames().includes(body.name)) return send(404, { result: JSON.stringify({ ok: false, error: "unknown tool" }) });
        let result: unknown;
        try {
          result = await this.deps.runTool(body.name, body.arguments ?? {});
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        this.deps.log?.(`tool ${body.name} -> ${(typeof result === "string" ? result : JSON.stringify(result)).slice(0, 160)}`);
        return send(200, { result: typeof result === "string" ? result : JSON.stringify(result) });
      }
      if (route === "POST /event") {
        if ((body.role === "user" || body.role === "persona") && typeof body.content === "string") {
          this.deps.onSpoken({ role: body.role, id: String(body.id ?? ""), content: body.content, end: body.end === true, interrupted: body.interrupted === true });
        }
        return send(200, { ok: true });
      }
      send(404, { ok: false });
    } catch {
      if (!res.headersSent) send(400, { ok: false });
    }
  }
}
