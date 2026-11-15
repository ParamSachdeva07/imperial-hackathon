/** Client for the resident `pointy-ax` Swift helper (JSON lines over stdio). No electron imports. */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface RawElement {
  id: string;
  role: string;
  label: string;
  window: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused?: boolean;
}

export interface RawSnapshot {
  app: string;
  pid: number;
  window: string;
  elements: RawElement[];
  truncated: boolean;
  visited?: number;
  ms?: number;
}

export interface RawRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HelperEvent = { event: "ready"; trusted?: boolean; pid?: number } | { event: "changed"; reason?: string };

/** Thrown for helper-reported failures; `code` is e.g. "not_trusted", "no_target". */
export class AxHelperError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AxHelperError";
  }
}

/** The subset of a child process the client needs (a fake implements it in tests). */
export interface HelperProcess {
  stdin: { write(chunk: string): unknown; on?(event: "error", cb: (err: Error) => void): unknown };
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown };
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(): unknown;
}

export type SpawnHelper = (binPath: string) => HelperProcess;

export interface AxHelperClientOptions {
  /** Path to the compiled helper. */
  binPath: string;
  spawn?: SpawnHelper;
  /** Default 2000. */
  requestTimeoutMs?: number;
  /** Restart backoff: base * 2^n capped at max. Defaults 500 / 5000. */
  restartBaseMs?: number;
  restartMaxMs?: number;
  /** Give up after this many consecutive failed starts (no successful response in between). Default 8. */
  maxConsecutiveFailures?: number;
  /** Check that the binary exists before spawning. Default true for the real spawn, false when `spawn` is injected. */
  checkBinary?: boolean;
  /** Kill the child when this process exits. Default true. */
  killOnExit?: boolean;
  log?: (msg: string) => void;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const defaultSpawn: SpawnHelper = (bin) =>
  nodeSpawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] }) as unknown as HelperProcess;

export class AxHelperClient {
  private proc: HelperProcess | null = null;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(e: HelperEvent) => void>();
  private stopped = true;
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private exitHook: (() => void) | null = null;
  private gaveUp = false;
  private readonly opts: Required<Omit<AxHelperClientOptions, "spawn" | "log">> & {
    spawn: SpawnHelper;
    log: (m: string) => void;
  };

  constructor(options: AxHelperClientOptions) {
    this.opts = {
      binPath: options.binPath,
      spawn: options.spawn ?? defaultSpawn,
      requestTimeoutMs: options.requestTimeoutMs ?? 2000,
      restartBaseMs: options.restartBaseMs ?? 500,
      restartMaxMs: options.restartMaxMs ?? 5000,
      maxConsecutiveFailures: options.maxConsecutiveFailures ?? 8,
      checkBinary: options.checkBinary ?? options.spawn === undefined,
      killOnExit: options.killOnExit ?? true,
      log: options.log ?? (() => {}),
    };
  }

  /** True while a helper process is believed to be running. */
  get running(): boolean {
    return this.proc !== null;
  }

  /** False when the binary is missing or the helper keeps failing to start. */
  get available(): boolean {
    return !this.gaveUp;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.gaveUp = false;
    this.failures = 0;
    if (this.opts.killOnExit && !this.exitHook) {
      this.exitHook = () => this.proc?.kill();
      process.once("exit", this.exitHook);
    }
    this.spawnNow();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.exitHook) {
      process.removeListener("exit", this.exitHook);
      this.exitHook = null;
    }
    const p = this.proc;
    this.proc = null;
    this.rejectAll(new AxHelperError("stopped"));
    try {
      p?.kill();
    } catch {
      /* already gone */
    }
  }

  onEvent(cb: (e: HelperEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  async snapshot(maxElements: number, excludePids: number[]): Promise<RawSnapshot> {
    const r = await this.request({ cmd: "snapshot", maxElements, excludePids });
    return r as unknown as RawSnapshot;
  }

  async resolve(ids: string[]): Promise<Record<string, RawRect | null>> {
    const r = await this.request({ cmd: "resolve", ids });
    return (r.rects ?? {}) as Record<string, RawRect | null>;
  }

  /** The element under a global point (nearest useful ancestor), or null. Throws AxHelperError on helper failure/timeout. */
  async elementAt(x: number, y: number, excludePids: number[] = []): Promise<RawElement | null> {
    const r = await this.request({ cmd: "elementAt", x, y, excludePids });
    return (r.element ?? null) as RawElement | null;
  }

  /** Tells the helper whether it may read/observe at all (it starts inactive). Never throws. */
  async setActive(on: boolean): Promise<void> {
    try {
      await this.request({ cmd: "active", on });
    } catch {
      /* helper restarting: the provider re-sends on the next "ready" */
    }
  }

  async trusted(): Promise<boolean> {
    const r = await this.request({ cmd: "trusted" });
    return r.trusted === true;
  }

  private spawnNow(): void {
    if (this.stopped) return;
    if (this.opts.checkBinary && !existsSync(this.opts.binPath)) {
      this.opts.log(`[ax] helper binary missing: ${this.opts.binPath}`);
      this.gaveUp = true;
      return;
    }
    let proc: HelperProcess;
    try {
      proc = this.opts.spawn(this.opts.binPath);
    } catch (err) {
      this.opts.log(`[ax] spawn failed: ${String(err)}`);
      this.scheduleRestart();
      return;
    }
    this.proc = proc;
    this.buf = "";
    proc.stdout.on("data", (chunk) => {
      if (this.proc !== proc) return;
      this.buf += chunk.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    // EPIPE etc. arrive asynchronously when the helper closes its input mid-write: recover like an exit.
    proc.stdin.on?.("error", (err) => {
      this.opts.log(`[ax] helper stdin error: ${err.message}`);
      this.onExit(proc);
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    });
    proc.on("error", (err) => {
      this.opts.log(`[ax] helper error: ${err.message}`);
      this.onExit(proc);
    });
    proc.on("exit", (code, signal) => {
      this.opts.log(`[ax] helper exited code=${code} signal=${signal}`);
      this.onExit(proc);
    });
  }

  private onExit(proc: HelperProcess): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.rejectAll(new AxHelperError("exited"));
    if (!this.stopped) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    this.failures += 1;
    if (this.failures > this.opts.maxConsecutiveFailures) {
      this.opts.log("[ax] helper keeps failing; giving up");
      this.gaveUp = true;
      return;
    }
    const delay = Math.min(this.opts.restartMaxMs, this.opts.restartBaseMs * 2 ** (this.failures - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnNow();
    }, delay);
    this.restartTimer.unref?.();
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.event === "string") {
      if (msg.event === "ready") this.failures = 0;
      for (const cb of [...this.eventListeners]) cb(msg as unknown as HelperEvent);
      return;
    }
    const id = msg.id;
    if (typeof id !== "number") return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    this.failures = 0;
    if (msg.ok === false) p.reject(new AxHelperError(typeof msg.error === "string" ? msg.error : "error"));
    else p.resolve(msg);
  }

  private request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new AxHelperError("not_running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AxHelperError("timeout"));
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new AxHelperError("write_failed", String(err)));
      }
    });
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
