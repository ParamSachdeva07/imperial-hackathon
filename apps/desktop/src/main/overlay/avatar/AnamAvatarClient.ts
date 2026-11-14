/**
 * Client for the Anam voice avatar's local control API (anam-overlay/electron/control.mts).
 *
 * The avatar is a separate Electron process. It publishes `{ port, token, pid }` in a discovery
 * file; we poll `GET /state` and cache it, so the overlay can read the avatar's bounds
 * synchronously (AvoidRectsProvider.getAvoidRects, AvatarController.getBounds) and move it with
 * `POST /move`. Both sides use the same global-DIP space as Pointy.
 *
 * Never throws to callers: any failure (Anam not running, restarting, slow) just means "unknown",
 * and the discovery file is re-read so a restarted Anam is picked up again.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AvatarController, AvoidRectsProvider, Point, Rect } from "@pointy/shared/overlay";
import { realClock, type Clock, type TimerHandle } from "../clock";

export const ANAM_TOKEN_HEADER = "x-anam-control-token";

export function anamControlFile(): string {
  return process.env.ANAM_CONTROL_FILE ?? join(homedir(), ".pointy", "anam-control.json");
}

export interface AnamState {
  expanded: boolean;
  dragging: boolean;
  bounds: Rect;
  workArea: Rect;
  displayId: string;
}

interface Connection {
  port: number;
  token: string;
}

export interface AnamAvatarClientOptions {
  /** Discovery file (default ANAM_CONTROL_FILE or ~/.pointy/anam-control.json). */
  controlFile?: string;
  /** State poll interval (default 500 ms). */
  intervalMs?: number;
  /** Per-request timeout (default 1000 ms). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  readFile?: (path: string) => string;
  clock?: Clock;
}

const isRect = (v: unknown): v is Rect => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n)) && (r.width as number) > 0 && (r.height as number) > 0;
};

function parseState(v: unknown): AnamState | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.expanded !== "boolean" || !isRect(s.bounds) || !isRect(s.workArea)) return null;
  return {
    expanded: s.expanded,
    dragging: s.dragging === true,
    bounds: s.bounds,
    workArea: s.workArea,
    displayId: String(s.displayId ?? ""),
  };
}

export class AnamAvatarClient implements AvatarController, AvoidRectsProvider {
  private readonly controlFile: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly readFile: (path: string) => string;
  private readonly clock: Clock;
  private conn: Connection | null = null;
  private state: AnamState | null = null;
  /** Bumped on every local state change, so a poll that started earlier can't overwrite it. */
  private version = 0;
  private timer: TimerHandle | null = null;
  private running = false;

  constructor(opts: AnamAvatarClientOptions = {}) {
    this.controlFile = opts.controlFile ?? anamControlFile();
    this.intervalMs = opts.intervalMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 1000;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.readFile = opts.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.clock = opts.clock ?? realClock;
  }

  /** Begin polling (idempotent). The first poll runs immediately. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  dispose(): void {
    this.running = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.state = null;
  }

  private async loop(): Promise<void> {
    await this.refresh();
    if (!this.running) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.running) void this.loop();
    }, this.intervalMs);
  }

  /** Poll once now (also used by the loop). Resolves the cached state; never rejects. */
  async refresh(): Promise<AnamState | null> {
    const startedAt = this.version;
    const res = await this.call("GET", "/state");
    if (this.version !== startedAt) return this.state; // a move landed meanwhile; keep the newer data
    const next = res && res.status === 200 ? parseState((res.body as { state?: unknown } | null)?.state) : null;
    this.state = next;
    return next;
  }

  // ---------------------------------------------------------------- AvatarController / AvoidRectsProvider

  getBounds(): Rect | null {
    return this.state?.expanded ? this.state.bounds : null;
  }

  isMovable(): boolean {
    return !!this.state && this.state.expanded && !this.state.dragging;
  }

  /** The cached state (for the display's work area), or null when unknown. */
  getState(): AnamState | null {
    return this.state;
  }

  getAvoidRects(): Rect[] {
    const b = this.getBounds();
    return b ? [b] : [];
  }

  async moveTo(topLeft: Point): Promise<Rect | null> {
    if (!this.isMovable()) return null;
    const res = await this.call("POST", "/move", { x: topLeft.x, y: topLeft.y });
    if (!res) return null;
    const body = res.body as { bounds?: unknown; reason?: unknown } | null;
    if (res.status === 200 && body && isRect(body.bounds) && this.state) {
      this.version += 1;
      this.state = { ...this.state, bounds: body.bounds };
      return body.bounds;
    }
    if (res.status === 409 && this.state) {
      this.version += 1;
      this.state = body?.reason === "collapsed" ? { ...this.state, expanded: false } : { ...this.state, dragging: true };
    }
    return null;
  }

  // ---------------------------------------------------------------- transport

  private readConnection(): Connection | null {
    try {
      const j = JSON.parse(this.readFile(this.controlFile)) as { port?: unknown; token?: unknown };
      return typeof j.port === "number" && typeof j.token === "string" ? { port: j.port, token: j.token } : null;
    } catch {
      return null;
    }
  }

  /** One request; if it fails, re-read the discovery file and retry once when the connection changed. */
  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
    const first = (this.conn ??= this.readConnection());
    if (!first) return null;
    const res = await this.request(first, method, path, body);
    if (res) return res;
    const fresh = this.readConnection();
    this.conn = fresh;
    if (!fresh || (fresh.port === first.port && fresh.token === first.token)) return null;
    return this.request(fresh, method, path, body);
  }

  private async request(conn: Connection, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
    const controller = new AbortController();
    const timer = this.clock.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // No Origin header: the control API rejects browser-originated requests.
      const res = await this.fetchImpl(`http://127.0.0.1:${conn.port}${path}`, {
        method,
        headers: { [ANAM_TOKEN_HEADER]: conn.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const parsed: unknown = await res.json().catch(() => null);
      return { status: res.status, body: parsed };
    } catch {
      return null;
    } finally {
      this.clock.clearTimeout(timer);
    }
  }
}
