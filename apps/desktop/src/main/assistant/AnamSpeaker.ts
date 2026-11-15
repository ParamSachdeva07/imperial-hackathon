/**
 * AnamSpeakerClient over the Anam control server (anam-overlay/electron/control.mts, ANAM_SPEAK_ONLY=1):
 *   POST /session {action:"start"|"end"}   POST /talk {turnId,text,final}   POST /interrupt   GET /state
 * Discovery (file, token header, stale-pid check) mirrors AnamAvatarClient. No electron import.
 */
import { readFileSync } from "node:fs";
import { ANAM_TOKEN_HEADER, anamControlFile, isProcessAlive } from "../overlay/avatar/AnamAvatarClient";
import type { AnamSpeakerClient, AnamSpeakerState, AnamTalk } from "./types";

export class AnamSpeakerError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "AnamSpeakerError";
  }
}

export interface AnamSpeakerOptions {
  controlFile?: string;
  fetch?: typeof fetch;
  readFile?: (path: string) => string;
  isProcessAlive?: (pid: number) => boolean;
  /** Per-request timeout (default 5000 ms; /session start can take a moment). */
  timeoutMs?: number;
}

interface Connection {
  port: number;
  token: string;
  pid: number | null;
}

export class AnamSpeaker implements AnamSpeakerClient {
  private readonly controlFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readFile: (path: string) => string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly timeoutMs: number;

  constructor(opts: AnamSpeakerOptions = {}) {
    this.controlFile = opts.controlFile ?? anamControlFile();
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.readFile = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
    this.isAlive = opts.isProcessAlive ?? isProcessAlive;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async startSession(): Promise<void> {
    await this.mustOk("POST", "/session", { action: "start" });
  }

  async endSession(): Promise<void> {
    await this.mustOk("POST", "/session", { action: "end" });
  }

  async talk(t: AnamTalk): Promise<void> {
    await this.mustOk("POST", "/talk", { turnId: t.turnId, text: t.text, final: t.final });
  }

  async interrupt(): Promise<void> {
    await this.mustOk("POST", "/interrupt", {});
  }

  /** Agent mode: put a text message into the live conversation (the ElevenLabs agent answers it aloud). */
  async message(text: string): Promise<void> {
    await this.mustOk("POST", "/message", { text: text.slice(0, 4000) });
  }

  async state(): Promise<AnamSpeakerState | null> {
    const res = await this.request("GET", "/state");
    if (!res || res.status !== 200) return null;
    const s = (res.body as { state?: Record<string, unknown> } | null)?.state;
    if (!s || typeof s !== "object") return null;
    return { connected: s.connected === true, speaking: s.speaking === true, expanded: s.expanded === true, ...(typeof s.starting === "boolean" ? { starting: s.starting } : {}) };
  }

  private connection(): Connection | null {
    try {
      const j = JSON.parse(this.readFile(this.controlFile)) as { port?: unknown; token?: unknown; pid?: unknown };
      if (typeof j.port !== "number" || typeof j.token !== "string") return null;
      const pid = typeof j.pid === "number" && Number.isInteger(j.pid) && j.pid > 0 ? j.pid : null;
      if (pid !== null && !this.isAlive(pid)) return null; // never send the token to whatever now owns the port
      return { port: j.port, token: j.token, pid };
    } catch {
      return null;
    }
  }

  private async mustOk(method: "GET" | "POST", path: string, body?: unknown): Promise<void> {
    const res = await this.request(method, path, body);
    if (!res) throw new AnamSpeakerError(`anam unreachable (${path})`, null);
    if (res.status < 200 || res.status >= 300) {
      const reason = (res.body as { reason?: unknown } | null)?.reason;
      throw new AnamSpeakerError(`anam ${path} -> ${res.status}${typeof reason === "string" ? ` ${reason}` : ""}`, res.status);
    }
  }

  /** One request; re-reads the discovery file each time (Anam may have restarted with a new token). */
  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
    const conn = this.connection();
    if (!conn) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // No Origin header: the control API rejects browser-originated requests.
      const res = await this.fetchImpl(`http://127.0.0.1:${conn.port}${path}`, {
        method,
        headers: { [ANAM_TOKEN_HEADER]: conn.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
