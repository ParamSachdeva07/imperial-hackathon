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
  /** Anam's pid from the discovery file, when present. */
  pid: number | null;
}

/** How long the last good state survives transport failures (timeouts, restarts, auth errors). */
const STALE_GRACE_MS = 2000;

/** `process.kill(pid, 0)`: ESRCH means gone; EPERM means it exists but is not ours (alive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
  /** Liveness check for the pid in the discovery file (default `process.kill(pid, 0)`). */
  isProcessAlive?: (pid: number) => boolean;
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
  private readonly isAlive: (pid: number) => boolean;
  private conn: Connection | null = null;
  private state: AnamState | null = null;
  /** Bumped on every local state change, so a poll that started earlier can't overwrite it. */
  private version = 0;
  private timer: TimerHandle | null = null;
  private running = false;
  /** Bumped on start() and dispose(); work begun under an older generation must not touch state. */
  private generation = 0;
  /** Clock time of the last successful /state response. */
  private lastGoodAt = 0;

  constructor(opts: AnamAvatarClientOptions = {}) {
    this.controlFile = opts.controlFile ?? anamControlFile();
    this.intervalMs = opts.intervalMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 1000;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.readFile = opts.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.clock = opts.clock ?? realClock;
    this.isAlive = opts.isProcessAlive ?? isProcessAlive;
  }

  /** Begin polling (idempotent). The first poll runs immediately. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    void this.loop(this.generation);
  }

  dispose(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.state = null;
  }

  private async loop(gen: number): Promise<void> {
    await this.refresh();
    if (gen !== this.generation) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (gen === this.generation) void this.loop(gen);
    }, this.intervalMs);
  }

  /** Poll once now (also used by the loop). Resolves the cached state; never rejects. */
  async refresh(): Promise<AnamState | null> {
    const startedAt = this.version;
    const gen = this.generation;
    const res = await this.call("GET", "/state");
    if (gen !== this.generation) return this.state; // disposed (or restarted) while in flight
    if (this.version !== startedAt) return this.state; // a move landed meanwhile; keep the newer data
    const transportFailure = !res || res.status === 401 || res.status === 403;
    if (transportFailure) {
      // Keep the last good state briefly so one slow poll doesn't flicker avoid rects / skip a dodge.
      if (this.state && this.clock.now() - this.lastGoodAt >= STALE_GRACE_MS) this.state = null;
      return this.state;
    }
    // A definitive answer (200, or 503 no_window, ...) updates immediately.
    const next = res.status === 200 ? parseState((res.body as { state?: unknown } | null)?.state) : null;
    this.state = next;
    if (next) this.lastGoodAt = this.clock.now();
    return next;
  }

  /** True while there is a cached state from Anam (fresh, or within the grace period). */
  hasLiveState(): boolean {
    return this.state !== null;
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
      const j = JSON.parse(this.readFile(this.controlFile)) as { port?: unknown; token?: unknown; pid?: unknown };
      if (typeof j.port !== "number" || typeof j.token !== "string") return null;
      const pid = typeof j.pid === "number" && Number.isInteger(j.pid) && j.pid > 0 ? j.pid : null;
      if (pid !== null && !this.isAlive(pid)) return null; // stale file from a crashed Anam
      return { port: j.port, token: j.token, pid };
    } catch {
      return null;
    }
  }

  /**
   * One request. On a network failure or an auth failure (401/403: Anam restarted with a new token,
   * possibly on the same port) re-read the discovery file and retry once if the connection changed;
   * if it did not, drop the cached connection so the next call re-reads it.
   */
  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
    const first = (this.conn ??= this.readConnection());
    if (!first) return null;
    if (first.pid !== null && !this.isAlive(first.pid)) {
      this.conn = null; // never send the token to whatever now owns the port
      return null;
    }
    const res = await this.request(first, method, path, body);
    if (res && res.status !== 401 && res.status !== 403) return res;
    const fresh = this.readConnection();
    if (!fresh || (fresh.port === first.port && fresh.token === first.token)) {
      this.conn = null;
      return res;
    }
    this.conn = fresh;
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
