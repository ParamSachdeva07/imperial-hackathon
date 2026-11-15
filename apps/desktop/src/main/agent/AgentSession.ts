/**
 * The assistant when an ElevenLabs agent runs the conversation through the Anam avatar (POINTY_VOICE_STACK=elevenlabs).
 * ElevenLabs and Anam own listening, turn-taking, interruption and speech. This class owns only what is local:
 * opening and closing the call, the gesture session, running the agent's tools, and passing it notes.
 * It has the same surface the menu bar, hotkey and gestures use on AssistantController. No electron import.
 */
import type { Clock, TimerHandle } from "../overlay/clock";
import type { AnamSpeakerClient } from "../assistant/types";
import { StatusEmitter } from "../assistant/status";
import type { ScreenContext } from "../assistant/screenContext";
import type { SpokenEvent } from "./ToolBridge";

export const LOOK_AT_SCREEN = "look_at_screen";

export interface AgentSessionDeps {
  /** The avatar app's control API, plus `message` to put a note into the live conversation. */
  anam: AnamSpeakerClient & { message(text: string): Promise<void> };
  gestures: { setSessionActive(active: boolean): void; clearSelection?(): void };
  /** Tools the agent can call besides look_at_screen: drawing and execution. */
  tools: { names(): string[]; run(name: string, args: unknown): Promise<unknown> };
  buildContext(): Promise<ScreenContext>;
  /** What the user selected with a gesture, as a line of text for the agent; "" when nothing is selected. */
  selectionNote?(): string;
  backgroundWork?(): boolean;
  clock: Clock;
  status?: StatusEmitter;
  /** Close after this long with nothing said and nothing running (default 150 s). */
  idleCloseMs?: number;
  doublePressMs?: number;
  log?(msg: string): void;
}

export class AgentSession {
  readonly status: StatusEmitter;
  private phase: "closed" | "opening" | "open" = "closed";
  private epoch = 0;
  private idleTimer: TimerHandle | null = null;
  private pollTimer: TimerHandle | null = null;
  private lastHotkeyAt = Number.NEGATIVE_INFINITY;
  /** Notes that arrived while closed; given to the agent when the next call opens. */
  private pending: string[] = [];

  constructor(private readonly deps: AgentSessionDeps) {
    this.status = deps.status ?? new StatusEmitter();
  }

  isOpen(): boolean {
    return this.phase !== "closed";
  }
  wake(): Promise<void> {
    return this.phase === "closed" ? this.open("wake") : this.interrupt();
  }
  toolNames(): string[] {
    return [...this.deps.tools.names(), LOOK_AT_SCREEN];
  }

  async open(reason = "open"): Promise<void> {
    if (this.phase !== "closed") return;
    this.phase = "opening";
    const my = ++this.epoch;
    this.deps.log?.(`open (${reason})`);
    this.status.set("opening");
    this.deps.gestures.setSessionActive(true);
    try {
      await this.deps.anam.startSession();
    } catch (e) {
      if (my !== this.epoch) return;
      this.deps.log?.(`open failed: ${e instanceof Error ? e.message : String(e)}`);
      this.teardown("error");
      return;
    }
    if (my !== this.epoch) return;
    this.phase = "open";
    this.status.set("listening");
    this.armIdle();
    this.poll(my, false);
  }

  async close(reason = "close"): Promise<void> {
    if (this.phase === "closed") return;
    this.deps.log?.(`close (${reason})`);
    await this.deps.anam.endSession().catch(() => undefined);
    this.teardown("idle");
  }

  dispose(): void {
    void this.close("dispose");
  }

  /** Stop the avatar talking. A running task is not touched: that is what stop_computer_task is for. */
  async interrupt(): Promise<void> {
    if (this.phase !== "open") return;
    await this.deps.anam.interrupt().catch(() => undefined);
    this.status.set("listening");
  }

  /** The conversation lives in ElevenLabs, so "start over" is a fresh call. */
  clearMemory(): void {
    this.pending = [];
    if (this.phase !== "closed") void this.close("start over").then(() => this.open("start over"));
  }

  async hotkey(): Promise<void> {
    const now = this.deps.clock.now();
    const double = now - this.lastHotkeyAt <= (this.deps.doublePressMs ?? 600);
    this.lastHotkeyAt = double ? Number.NEGATIVE_INFINITY : now;
    if (this.phase === "closed") return this.open("hotkey");
    if (double) return this.close("hotkey double-press");
    if (this.status.get() === "speaking") return this.interrupt();
  }

  /** A note from outside the conversation (a task ended). The agent hears it as a message and reports it. */
  notify(text: string): void {
    if (this.phase !== "open") {
      this.pending = [...this.pending, text].slice(-5);
      return;
    }
    void this.deps.anam.message(text).catch((e: unknown) => this.deps.log?.(`note not delivered: ${e instanceof Error ? e.message : String(e)}`));
    this.armIdle();
  }

  /** Run one tool the agent called. */
  async runTool(name: string, args: unknown): Promise<unknown> {
    this.armIdle();
    if (name !== LOOK_AT_SCREEN) return this.deps.tools.run(name, args);
    const ctx = await this.deps.buildContext();
    const selection = this.deps.selectionNote?.() ?? "";
    return ctx.text + (selection ? `\n${selection}` : "");
  }

  onSpoken(e: SpokenEvent): void {
    if (this.phase !== "open") return;
    this.armIdle();
    if (e.role === "user") this.status.set(e.end ? "thinking" : "listening");
    else this.status.set(e.end || e.interrupted ? "listening" : "speaking");
  }

  private teardown(final: "idle" | "error"): void {
    ++this.epoch;
    this.phase = "closed";
    for (const t of [this.idleTimer, this.pollTimer]) if (t !== null) this.deps.clock.clearTimeout(t);
    this.idleTimer = this.pollTimer = null;
    this.deps.gestures.clearSelection?.();
    this.deps.gestures.setSessionActive(false);
    this.status.set(final);
  }

  private armIdle(): void {
    if (this.idleTimer !== null) this.deps.clock.clearTimeout(this.idleTimer);
    if (this.phase !== "open") return;
    const my = this.epoch;
    this.idleTimer = this.deps.clock.setTimeout(() => {
      this.idleTimer = null;
      if (my !== this.epoch) return;
      if (this.deps.backgroundWork?.() || this.status.get() === "speaking") return this.armIdle();
      void this.close("idle (no speech)");
    }, this.deps.idleCloseMs ?? 150_000);
  }

  /** Watch the call: deliver notes once it is connected, and close when it ended on the avatar's side. */
  private poll(my: number, wasConnected: boolean): void {
    this.pollTimer = this.deps.clock.setTimeout(() => {
      void this.deps.anam.state().then((s) => {
        if (my !== this.epoch) return;
        const connected = s?.connected === true;
        if (connected && !wasConnected) for (const note of this.pending.splice(0)) this.notify(note);
        if (wasConnected && s !== null && !connected && !s.starting) return void this.close("call ended");
        this.poll(my, wasConnected || connected);
      });
    }, 1000);
  }
}
