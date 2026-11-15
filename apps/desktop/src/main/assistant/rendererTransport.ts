/**
 * RealtimeTransport over the hidden assistant renderer (WebRTC lives there). Pure: the IPC channel is
 * injected (assistantWindow.ts provides the electron one), so this is unit-tested with a fake.
 */
import type { AssistantCommand, AssistantMessage } from "./ipc";
import type { RealtimeServerEvent, RealtimeTransport } from "./types";

export interface RendererChannel {
  send(cmd: AssistantCommand): void;
  onMessage(cb: (m: AssistantMessage) => void): () => void;
}

export interface RendererTransportOptions {
  channel: RendererChannel;
  /** Max wait for ready + open (default 15 s). */
  connectTimeoutMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

export class RendererTransport implements RealtimeTransport {
  private readonly events = new Set<(e: RealtimeServerEvent) => void>();
  private readonly closes = new Set<(r: string) => void>();
  private readonly audio = new Set<(pcm: string | null) => void>();
  private maxBytes: number | undefined;
  private ready = false;
  private open = false;
  private pending: { resolve(): void; reject(e: Error): void; timer: unknown } | null = null;
  private readonly off: () => void;
  private readonly st: NonNullable<RendererTransportOptions["setTimeout"]>;
  private readonly ct: NonNullable<RendererTransportOptions["clearTimeout"]>;

  constructor(private readonly opts: RendererTransportOptions) {
    this.st = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.ct = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.off = opts.channel.onMessage((m) => this.onMessage(m));
  }

  connect(): Promise<void> {
    if (this.pending) return Promise.reject(new Error("connect already in progress"));
    return new Promise<void>((resolve, reject) => {
      const timer = this.st(() => {
        this.fail(new Error("realtime connect timed out"));
        this.opts.channel.send({ kind: "disconnect" });
      }, this.opts.connectTimeoutMs ?? 15_000);
      this.pending = { resolve, reject, timer };
      this.opts.channel.send({ kind: "connect" }); // the renderer queues it until its page has loaded
    });
  }

  disconnect(): void {
    this.fail(new Error("disconnected"));
    this.open = false;
    this.maxBytes = undefined;
    this.opts.channel.send({ kind: "disconnect" });
  }

  send(event: object): void {
    if (this.open) this.opts.channel.send({ kind: "send", event });
  }

  setMicEnabled(enabled: boolean): void {
    this.opts.channel.send({ kind: "mic", enabled });
  }

  /** Whether the assistant page plays the model's voice (true) or leaves it to the avatar (false). Applies from the next answer. */
  setLocalVoice(local: boolean): void {
    this.opts.channel.send({ kind: "voice", local });
  }

  maxMessageBytes(): number | undefined {
    return this.maxBytes;
  }

  onEvent(cb: (e: RealtimeServerEvent) => void): () => void {
    this.events.add(cb);
    return () => this.events.delete(cb);
  }

  onClosed(cb: (reason: string) => void): () => void {
    this.closes.add(cb);
    return () => this.closes.delete(cb);
  }

  /** The model's voice as it plays (see AssistantMessage "audio"). */
  onAudio(cb: (pcm: string | null) => void): () => void {
    this.audio.add(cb);
    return () => this.audio.delete(cb);
  }

  dispose(): void {
    this.off();
    this.fail(new Error("disposed"));
    this.events.clear();
    this.closes.clear();
    this.audio.clear();
  }

  private fail(err: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.ct(p.timer);
    p.reject(err);
  }

  private onMessage(m: AssistantMessage): void {
    switch (m.kind) {
      case "ready":
        this.ready = true;
        return;
      case "open": {
        this.open = true;
        this.maxBytes = m.maxMessageBytes;
        const p = this.pending;
        if (p) {
          this.pending = null;
          this.ct(p.timer);
          p.resolve();
        }
        return;
      }
      case "failed":
        this.open = false;
        this.fail(new Error(m.error));
        return;
      case "closed": {
        const wasOpen = this.open;
        this.open = false;
        this.fail(new Error(m.reason));
        if (wasOpen) for (const cb of [...this.closes]) cb(m.reason);
        return;
      }
      case "server":
        for (const cb of [...this.events]) cb(m.event);
        return;
      case "audio":
        for (const cb of [...this.audio]) cb(m.pcm);
        return;
    }
  }

  /** Whether the renderer page has loaded (diagnostics). */
  get rendererReady(): boolean {
    return this.ready;
  }
}
