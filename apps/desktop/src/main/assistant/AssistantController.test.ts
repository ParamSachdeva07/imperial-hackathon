import { describe, expect, it } from "vitest";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import { FakeClock, flushPromises } from "../overlay/testing/fakeClock";
import { AssistantController, type AssistantDeps } from "./AssistantController";
import type { ScreenContext } from "./screenContext";
import type { AnamSpeakerState, AnamTalk, RealtimeServerEvent, RealtimeTransport } from "./types";

class FakeTransport implements RealtimeTransport {
  sent: Array<{ type: string; item_id?: string; item?: { id?: string; call_id?: string; output?: string }; [k: string]: unknown }> = [];
  mic: boolean[] = [];
  connected = false;
  connectError: Error | null = null;
  private evs = new Set<(e: RealtimeServerEvent) => void>();
  private closes = new Set<(r: string) => void>();
  async connect() {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  send(e: object) {
    this.sent.push(e as { type: string });
  }
  setMicEnabled(b: boolean) {
    this.mic.push(b);
  }
  maxMessageBytes() {
    return 256 * 1024;
  }
  onEvent(cb: (e: RealtimeServerEvent) => void) {
    this.evs.add(cb);
    return () => this.evs.delete(cb);
  }
  onClosed(cb: (r: string) => void) {
    this.closes.add(cb);
    return () => this.closes.delete(cb);
  }
  emit(e: RealtimeServerEvent) {
    for (const cb of [...this.evs]) cb(e);
  }
  drop(reason = "gone") {
    for (const cb of [...this.closes]) cb(reason);
  }
  types() {
    return this.sent.map((e) => e.type);
  }
  count(type: string) {
    return this.sent.filter((e) => e.type === type).length;
  }
}

const ctx = (over: Partial<ScreenContext> = {}): ScreenContext => ({ text: "[screen] hi", imageDataUrl: "data:image/jpeg;base64,AA", imageBytes: 2, displayId: "1", elementIds: ["ax-1"], notes: [], ...over });

function setup(over: Partial<AssistantDeps> = {}) {
  const clock = new FakeClock();
  const transport = new FakeTransport();
  const log: string[] = [];
  const calls: string[] = [];
  const talks: AnamTalk[] = [];
  let anamState: AnamSpeakerState | null = { connected: true, speaking: false, expanded: true };
  let ctxResolve: ((c: ScreenContext) => void) | null = null;
  let ctxMode: "now" | "manual" = "now";
  let selection: SelectionSnapshot | null = null;
  const tools: Array<{ name: string; args: unknown; opts?: unknown }> = [];
  const deps: AssistantDeps = {
    transport,
    clock,
    buildContext: () => (ctxMode === "now" ? Promise.resolve(ctx()) : new Promise((r) => (ctxResolve = r))),
    anam: {
      startSession: async () => void calls.push("anam.start"),
      endSession: async () => void calls.push("anam.end"),
      talk: async (t) => void talks.push(t),
      interrupt: async () => void (calls.push("anam.interrupt"), transport.sent.push({ type: "(anam.interrupt)" })),
      state: async () => anamState,
    },
    overlay: {
      handleTool: async (name, args, opts) => {
        tools.push({ name, args, opts });
        calls.push(`tool.${name}`);
        return { ok: true, visible: true } as never;
      },
      onTurnStart: (id) => void calls.push(`turnStart.${id}`),
    },
    gestures: { setSessionActive: (a) => void calls.push(`gestures.${a}`) },
    selection: { latest: () => selection, clear: () => void calls.push("selection.clear") },
    log: (m) => log.push(m),
    ...over,
  };
  const c = new AssistantController(deps);
  return {
    c, clock, transport, log, calls, talks, tools,
    setState: (s: AnamSpeakerState | null) => (anamState = s),
    manualContext: () => (ctxMode = "manual"),
    resolveContext: (x: ScreenContext) => ctxResolve?.(x),
    setSelection: (s: SelectionSnapshot | null) => (selection = s),
  };
}

type S = ReturnType<typeof setup>;
const settle = async (s: S, ms = 0) => {
  s.clock.advance(ms);
  await flushPromises(30);
};
async function openIt(s: S) {
  await s.c.open("test");
  await flushPromises();
}
const speak = async (s: S) => {
  s.transport.emit({ type: "input_audio_buffer.speech_started" });
  await flushPromises();
  s.transport.emit({ type: "input_audio_buffer.speech_stopped" });
  s.transport.emit({ type: "input_audio_buffer.committed" });
  await flushPromises();
};
const created = (s: S, id: string) => s.transport.emit({ type: "response.created", response: { id } });
const delta = (s: S, id: string, d: string) => s.transport.emit({ type: "response.output_text.delta", response_id: id, delta: d });
const done = async (s: S, id: string, output: unknown[] = [], status = "completed") => {
  s.transport.emit({ type: "response.done", response: { id, status, output } });
  await flushPromises(40);
};

describe("lifecycle", () => {
  it("open starts anam + realtime + gesture session and goes listening", async () => {
    const s = setup();
    const statuses: string[] = [];
    s.c.status.onChange((x) => statuses.push(x));
    await openIt(s);
    expect(s.calls).toEqual(["gestures.true", "anam.start"]);
    expect(s.transport.connected).toBe(true);
    expect(statuses).toEqual(["opening", "listening"]);
    await s.c.open(); // idempotent
    expect(s.calls.filter((x) => x === "anam.start").length).toBe(1);
  });

  it("failed open tears down and reports error", async () => {
    const s = setup();
    s.transport.connectError = new Error("boom");
    await s.c.open();
    await flushPromises();
    expect(s.c.status.get()).toBe("error");
    expect(s.calls).toContain("anam.end");
    expect(s.calls).toContain("gestures.false");
    expect(s.c.isOpen()).toBe(false);
  });

  it("closes after 45 s of silence and clears overlays, selection, gestures, realtime, anam", async () => {
    const s = setup();
    await openIt(s);
    await settle(s, 44_000);
    expect(s.c.isOpen()).toBe(true);
    await settle(s, 1500);
    expect(s.c.isOpen()).toBe(false);
    expect(s.c.status.get()).toBe("idle");
    expect(s.tools[0]).toMatchObject({ name: "clear", args: { overlayId: "all" }, opts: { caller: "controller" } });
    expect(s.calls).toEqual(expect.arrayContaining(["selection.clear", "gestures.false", "anam.end"]));
    expect(s.transport.connected).toBe(false);
  });

  it("ends the anam call before awaiting the overlay clear (quit must not lose it)", async () => {
    let releaseClear: () => void = () => {};
    const s = setup({
      overlay: {
        handleTool: () => new Promise((r) => (releaseClear = () => r({ ok: true } as never))),
        onTurnStart: () => {},
      },
    });
    await openIt(s);
    void s.c.close("quit");
    await flushPromises();
    expect(s.calls).toContain("anam.end");
    expect(s.transport.connected).toBe(false);
    releaseClear();
    await flushPromises();
    expect(s.c.isOpen()).toBe(false);
  });

  it("speech resets the idle timer", async () => {
    const s = setup();
    await openIt(s);
    await settle(s, 40_000);
    await speak(s);
    created(s, "r1");
    await done(s, "r1");
    await settle(s, 44_000);
    expect(s.c.isOpen()).toBe(true);
    await settle(s, 2000);
    expect(s.c.isOpen()).toBe(false);
  });

  it("hotkey: closed opens, listening closes, thinking interrupts", async () => {
    const s = setup();
    await s.c.hotkey();
    await flushPromises();
    expect(s.c.isOpen()).toBe(true);
    await speak(s);
    expect(s.c.status.get()).toBe("thinking");
    await s.c.hotkey();
    expect(s.c.isOpen()).toBe(true); // interrupted, not closed
    await s.c.hotkey();
    expect(s.c.isOpen()).toBe(false);
  });

  it("closes when the anam call ends or anam disappears", async () => {
    const s = setup();
    await openIt(s);
    await settle(s, 4000);
    expect(s.c.isOpen()).toBe(true);
    s.setState({ connected: false, speaking: false, expanded: false });
    await settle(s, 4000);
    expect(s.c.isOpen()).toBe(false);

    const t = setup();
    await openIt(t);
    t.setState(null);
    for (let i = 0; i < 3; i++) await settle(t, 4000);
    expect(t.c.isOpen()).toBe(false);
  });

  it("closes (error) when the realtime connection drops", async () => {
    const s = setup();
    await openIt(s);
    s.transport.drop();
    await flushPromises();
    expect(s.c.isOpen()).toBe(false);
    expect(s.c.status.get()).toBe("error");
  });

  it("close during opening cleans up and ignores the late connect", async () => {
    const s = setup();
    const p = s.c.open();
    await s.c.close("test");
    await p;
    await flushPromises();
    expect(s.c.isOpen()).toBe(false);
    expect(s.c.status.get()).toBe("idle");
  });
});

describe("turn flow", () => {
  it("speech_started -> onTurnStart + [screen] item; committed -> response.create after the item", async () => {
    const s = setup();
    await openIt(s);
    s.transport.emit({ type: "input_audio_buffer.speech_started" });
    await flushPromises();
    expect(s.calls).toContain("turnStart.turn-1");
    expect(s.transport.types()).toEqual(["conversation.item.create"]);
    expect(s.transport.sent[0]?.item?.id).toBe("scr_1");
    s.transport.emit({ type: "input_audio_buffer.committed" });
    await flushPromises();
    expect(s.transport.types()).toEqual(["conversation.item.create", "response.create"]);
  });

  it("deletes the previous turn's image items before adding the new ones", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    await done(s, "r1");
    s.transport.sent.length = 0;
    await speak(s);
    expect(s.transport.types().slice(0, 2)).toEqual(["conversation.item.delete", "conversation.item.create"]);
    expect(s.transport.sent[0]?.item_id).toBe("scr_1");
  });

  it("waits for a slow context, then falls back to answering without it after 1.2 s", async () => {
    const s = setup();
    s.manualContext();
    await openIt(s);
    await speak(s);
    expect(s.transport.count("response.create")).toBe(0);
    await settle(s, 1199);
    expect(s.transport.count("response.create")).toBe(0);
    await settle(s, 2);
    expect(s.transport.count("response.create")).toBe(1);
    s.resolveContext(ctx()); // too late: must not be sent
    await flushPromises();
    expect(s.transport.count("conversation.item.create")).toBe(0);
  });

  it("after a context timeout, the previous turn's screen items are deleted and the model is told", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    await done(s, "r1");
    s.manualContext();
    s.transport.sent.length = 0;
    await speak(s);
    await settle(s, 1300);
    expect(s.transport.sent.filter((e) => e.type === "conversation.item.delete").map((e) => e.item_id)).toEqual(["scr_1"]);
    const note = s.transport.sent.find((e) => e.type === "conversation.item.create");
    expect(JSON.stringify(note)).toContain("could not be captured");
    expect(s.transport.count("response.create")).toBe(1);
  });

  it("a context arriving before the timeout triggers response.create right away", async () => {
    const s = setup();
    s.manualContext();
    await openIt(s);
    await speak(s);
    s.resolveContext(ctx());
    await flushPromises();
    expect(s.transport.types()).toEqual(["conversation.item.create", "response.create"]);
  });

  it("adds a fresh selection once and never re-sends it", async () => {
    const s = setup();
    const png = "data:image/jpeg;base64,AA";
    s.setSelection({ id: "sel-1", kind: "point", capturedAt: 0, displayId: "1", regionGlobal: { x: 0, y: 0, width: 10, height: 10 }, pointGlobal: { x: 1, y: 1 }, full: { mime: "image/jpeg", dataUrl: png, width: 10, height: 10, markedRegion: { x: 0, y: 0, width: 1, height: 1 } }, focus: { mime: "image/jpeg", dataUrl: png, width: 10, height: 10 } });
    await openIt(s);
    await speak(s);
    const ids = s.transport.sent.filter((e) => e.type === "conversation.item.create").map((e) => e.item?.id);
    expect(ids).toEqual(["scr_1", "sel_1_1_0"]);
    created(s, "r1");
    await done(s, "r1");
    s.transport.sent.length = 0;
    await speak(s);
    const again = s.transport.sent.filter((e) => e.type === "conversation.item.create");
    expect(again.length).toBe(1);
    expect(s.transport.sent.filter((e) => e.type === "conversation.item.delete").map((e) => e.item_id)).toEqual(["scr_1", "sel_1_1_0"]);
  });

  it("attaches a selection made after the screen context but before the answer", async () => {
    const s = setup();
    await openIt(s);
    s.transport.emit({ type: "input_audio_buffer.speech_started" });
    await flushPromises(); // context settled, no selection yet
    const png = "data:image/jpeg;base64,AA";
    s.setSelection({ id: "sel-late", kind: "point", capturedAt: 0, displayId: "1", regionGlobal: { x: 0, y: 0, width: 10, height: 10 }, pointGlobal: { x: 1, y: 1 }, full: { mime: "image/jpeg", dataUrl: png, width: 10, height: 10, markedRegion: { x: 0, y: 0, width: 1, height: 1 } }, focus: { mime: "image/jpeg", dataUrl: png, width: 10, height: 10 } });
    s.transport.emit({ type: "input_audio_buffer.speech_stopped" });
    s.transport.emit({ type: "input_audio_buffer.committed" });
    await flushPromises();
    const order = s.transport.sent.filter((e) => e.type === "conversation.item.create" || e.type === "response.create").map((e) => e.item?.id ?? e.type);
    expect(order).toEqual(["scr_1", "sel_1_1_0", "response.create"]);
  });
});

describe("late selection replacement", () => {
  it("a second selection before commit replaces the first with a unique id", async () => {
    const s = setup();
    await openIt(s);
    const png = "data:image/jpeg;base64,AA";
    const mk = (id: string) => ({ id, kind: "point", capturedAt: 0, displayId: "1", regionGlobal: { x: 0, y: 0, width: 10, height: 10 }, pointGlobal: { x: 1, y: 1 }, full: { mime: "image/jpeg", dataUrl: png, width: 10, height: 10, markedRegion: { x: 0, y: 0, width: 1, height: 1 } }, focus: { mime: "image/jpeg", dataUrl: png, width: 10, height: 10 } }) as SelectionSnapshot;
    s.manualContext();
    s.transport.emit({ type: "input_audio_buffer.speech_started" });
    await flushPromises();
    s.setSelection(mk("sel-a"));
    s.resolveContext(ctx());
    await flushPromises();
    s.setSelection(mk("sel-b"));
    s.transport.emit({ type: "input_audio_buffer.speech_stopped" });
    s.transport.emit({ type: "input_audio_buffer.committed" });
    await flushPromises();
    const created = s.transport.sent.filter((e) => e.type === "conversation.item.create").map((e) => e.item?.id as string);
    expect(new Set(created).size).toBe(created.length);
    const deleted = s.transport.sent.filter((e) => e.type === "conversation.item.delete").map((e) => e.item_id);
    expect(created).toEqual(["scr_1", "sel_1_1_0", "sel_1_2_0"].filter((i) => created.includes(i)));
    expect(created.length).toBe(3);
    expect(deleted).toContain(created[1]);
    expect(deleted).not.toContain(created[2]);
  });
});

describe("responses", () => {
  it("never sends response.create while one is active; sends it after response.done", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Hello there my friend. ");
    // User talks again while r1 is still active (barge-in): cancel first, create only after done.
    s.transport.emit({ type: "input_audio_buffer.speech_started" });
    await flushPromises();
    s.transport.emit({ type: "input_audio_buffer.committed" });
    await flushPromises();
    expect(s.transport.count("response.create")).toBe(1);
    expect(s.transport.count("response.cancel")).toBe(1);
    await done(s, "r1", [], "cancelled");
    expect(s.transport.count("response.create")).toBe(2);
  });

  it("barge-in order: response.cancel, then anam.interrupt, never talks the cancelled text", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    s.transport.sent.length = 0;
    s.transport.emit({ type: "input_audio_buffer.speech_started" });
    await flushPromises();
    expect(s.transport.types().slice(0, 2)).toEqual(["response.cancel", "(anam.interrupt)"]);
    delta(s, "r1", "A long late sentence that must be dropped. ");
    await done(s, "r1", [], "cancelled");
    await settle(s, 100);
    expect(s.talks).toEqual([]);
  });

  it("drops late deltas from a different response id", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r2");
    delta(s, "r1", "stale text that is long enough to speak right now. ");
    delta(s, "r2", "Fresh text that is long enough to speak right now. ");
    await flushPromises();
    expect(s.talks.map((t) => t.text)).toEqual(["Fresh text that is long enough to speak right now. "]);
  });

  it("batches sentences into talk chunks and ends the stream with final", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Click the blue button");
    delta(s, "r1", " at the top. Then wait");
    delta(s, "r1", " a moment");
    await done(s, "r1");
    expect(s.talks).toEqual([
      { turnId: "turn-1-r1", text: "Click the blue button at the top. ", final: false },
      { turnId: "turn-1-r1", text: "Then wait a moment", final: true },
    ]);
  });

  it("sends an empty final when the text already went out as chunks", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Click the blue button at the top. ");
    await done(s, "r1");
    expect(s.talks.at(-1)).toEqual({ turnId: "turn-1-r1", text: "", final: true });
  });

  it("a response with no text sends nothing to anam", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    await done(s, "r1");
    expect(s.talks).toEqual([]);
    expect(s.c.status.get()).toBe("listening");
  });
});

describe("tool calls", () => {
  it("runs overlay tools, sends outputs then one response.create", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    s.transport.sent.length = 0;
    created(s, "r1");
    await done(s, "r1", [
      { type: "function_call", name: "highlight", call_id: "c1", arguments: '{"target":{"kind":"element","elementId":"ax-1"}}' },
      { type: "function_call", name: "point_at", call_id: "c2", arguments: "{bad json" },
    ]);
    expect(s.tools.map((t) => t.name)).toEqual(["highlight"]);
    const outs = s.transport.sent.filter((e) => e.type === "conversation.item.create");
    expect(outs.map((e) => e.item?.call_id)).toEqual(["c1", "c2"]);
    expect(JSON.parse(outs[1]?.item?.output ?? "")).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(s.transport.types().at(-1)).toBe("response.create");
    expect(s.transport.count("response.create")).toBe(1);
  });

  it("barge-in while a tool runs stops the tool loop: no follow-up response.create, later calls not painted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ran: string[] = [];
    const s = setup({
      overlay: {
        handleTool: async (name: string) => {
          ran.push(name);
          if (name === "show_explainer") await gate;
          return { ok: true, visible: true } as never;
        },
        onTurnStart: () => undefined,
      },
    });
    await openIt(s);
    await speak(s);
    created(s, "r1");
    s.transport.sent.length = 0;
    const d = done(s, "r1", [
      { type: "function_call", name: "show_explainer", call_id: "c1", arguments: "{}" },
      { type: "function_call", name: "highlight", call_id: "c2", arguments: "{}" },
    ]);
    await flushPromises();
    s.transport.emit({ type: "input_audio_buffer.speech_started" }); // user barges in while the tool runs
    await flushPromises();
    s.transport.sent.length = 0;
    release();
    await d;
    await flushPromises(40);
    expect(ran).not.toContain("highlight");
    expect(s.transport.count("response.create")).toBe(0);
  });

  it("does not run or answer tool calls of a cancelled response", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    await s.c.interrupt();
    s.transport.sent.length = 0;
    await done(s, "r1", [{ type: "function_call", name: "highlight", call_id: "c1", arguments: "{}" }], "cancelled");
    expect(s.tools).toEqual([]);
    expect(s.transport.count("response.create")).toBe(0);
  });
});

describe("half-duplex mic", () => {
  it("mutes on first talk, re-enables after the estimate once anam is done", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Click the blue button at the top of the page. ");
    await done(s, "r1");
    expect(s.transport.mic).toEqual([false]);
    expect(s.c.status.get()).toBe("speaking");
    await settle(s, 3000);
    expect(s.transport.mic).toEqual([false]); // estimate (~700 + 10 words) not over yet
    await settle(s, 4000);
    expect(s.transport.mic).toEqual([false, true]);
    expect(s.c.status.get()).toBe("listening");
  });

  it("keeps the mic muted while anam still reports speaking, up to a cap", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Short answer here for you. ");
    await done(s, "r1");
    s.setState({ connected: true, speaking: true, expanded: true });
    await settle(s, 3000);
    expect(s.transport.mic).toEqual([false]);
    await settle(s, 3000);
    expect(s.transport.mic).toEqual([false]);
    s.setState({ connected: true, speaking: false, expanded: true });
    await settle(s, 1000);
    expect(s.transport.mic).toEqual([false, true]);
  });

  it("rebases the release deadline on playback start when anam connects late", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    s.setState({ connected: false, speaking: false, expanded: false });
    created(s, "r1");
    delta(s, "r1", "Short answer here for you. ");
    await done(s, "r1");
    await settle(s, 19_000); // past the text-based deadline, still waiting for the call
    expect(s.transport.mic).toEqual([false]);
    s.setState({ connected: true, speaking: true, expanded: true });
    await settle(s, 1000); // playback observed
    await settle(s, 5000); // would be released under the old fixed deadline
    expect(s.transport.mic).toEqual([false]);
    s.setState({ connected: true, speaking: false, expanded: true });
    await settle(s, 1000);
    expect(s.transport.mic).toEqual([false, true]);
  });

  it("an in-flight anam state check from before new speech does not unmute the mic", async () => {
    const pending: Array<(v: AnamSpeakerState | null) => void> = [];
    const s = setup({
      anam: {
        startSession: async () => {},
        endSession: async () => {},
        talk: async () => {},
        interrupt: async () => {},
        state: () => new Promise((r) => void pending.push(r)),
      },
    });
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Short answer here for you. ");
    await done(s, "r1");
    for (let i = 0; i < 20 && pending.length === 0; i++) await settle(s, 250); // release check fires; its state() request is now in flight
    const before = pending.length;
    expect(before).toBeGreaterThan(0);
    created(s, "r2");
    delta(s, "r2", "A second answer follows right away. "); // new speech (still streaming): cancels the old release
    await flushPromises(30);
    for (const r of pending) r({ connected: true, speaking: false, expanded: true }); // the stale result lands
    await flushPromises(30);
    expect(s.transport.mic.at(-1)).toBe(false);
  });

  it("keeps the mic muted while anam has not connected yet (speech still queued there)", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Short answer here for you. ");
    await done(s, "r1");
    s.setState({ connected: false, speaking: false, expanded: true });
    await settle(s, 3000);
    await settle(s, 1500);
    expect(s.transport.mic).toEqual([false]);
    s.setState({ connected: true, speaking: false, expanded: true });
    await settle(s, 1000);
    expect(s.transport.mic).toEqual([false, true]);
  });

  it("stays muted across the tool loop and releases after the final answer", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Let me show you where it is. ");
    await done(s, "r1", [{ type: "function_call", name: "highlight", call_id: "c1", arguments: "{}" }]);
    await settle(s, 10_000);
    expect(s.transport.mic).toEqual([false]); // response 2 is pending: no release
    created(s, "r2");
    delta(s, "r2", "It is the blue button there. ");
    await done(s, "r2");
    await settle(s, 8000);
    expect(s.transport.mic).toEqual([false, true]);
  });

  it("interrupt: response.cancel, then anam interrupt, then mic back on", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "A fairly long sentence that is now being spoken aloud. ");
    await flushPromises();
    s.transport.sent.length = 0;
    await s.c.interrupt();
    expect(s.transport.types()).toEqual(["response.cancel", "(anam.interrupt)"]);
    expect(s.transport.mic).toEqual([false, true]);
    expect(s.c.status.get()).toBe("listening");
    // The remaining chunks queued before the interrupt are never talked.
    delta(s, "r1", "More text that is dropped. ");
    await done(s, "r1", [], "cancelled");
    await settle(s, 200);
    expect(s.talks.map((t) => t.text)).toEqual(["A fairly long sentence that is now being spoken aloud. "]);
    expect(s.transport.count("response.create")).toBe(0); // no second answer (sent was cleared above)
  });

  it("a slow anam interrupt finishing after a newer turn started does not unmute or set listening", async () => {
    const releases: Array<() => void> = [];
    const s = setup({
      anam: {
        startSession: async () => {},
        endSession: async () => {},
        talk: async () => {},
        interrupt: () => new Promise<void>((r) => void releases.push(r)),
        state: async () => ({ connected: true, speaking: false, expanded: true }),
      },
    });
    await openIt(s);
    await speak(s);
    created(s, "r1"); // thinking: mic not gated yet, so the user can start a newer turn
    await flushPromises();
    const p = s.c.interrupt();
    await flushPromises();
    await speak(s); // newer user turn
    created(s, "r2");
    delta(s, "r2", "A second long answer sentence that is being spoken now. ");
    await flushPromises();
    const micBefore = [...s.transport.mic];
    for (const r of releases) r();
    await p;
    await flushPromises();
    expect(s.transport.mic).toEqual(micBefore);
    expect(s.c.status.get()).not.toBe("listening");
  });

  it("interrupt right after response.create (before response.created) cancels on arrival", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    s.transport.sent.length = 0;
    await s.c.interrupt();
    expect(s.transport.count("response.cancel")).toBe(0);
    created(s, "r1");
    expect(s.transport.count("response.cancel")).toBe(1);
    delta(s, "r1", "Should never be spoken at all, really. ");
    expect(s.talks).toEqual([]);
  });

  it("idle timer does not close the session while the answer is being spoken", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Short answer here for you. ");
    await done(s, "r1");
    s.setState({ connected: true, speaking: true, expanded: true });
    await settle(s, 9000);
    expect(s.c.isOpen()).toBe(true);
  });
});

describe("review regressions", () => {
  it("closes when anam hangs up before a poll ever saw it connected (starting:false)", async () => {
    const s = setup();
    s.setState({ connected: false, speaking: false, expanded: false, starting: false });
    await openIt(s);
    await settle(s, 4000);
    expect(s.c.isOpen()).toBe(false);
  });

  it("does not close while anam is still starting", async () => {
    const s = setup();
    s.setState({ connected: false, speaking: false, expanded: true, starting: true });
    await openIt(s);
    await settle(s, 4000);
    expect(s.c.isOpen()).toBe(true);
  });

  it("a rejected response.create unsticks the turn", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    const create = s.transport.sent.find((e) => e.type === "response.create") as { event_id?: string };
    expect(typeof create.event_id).toBe("string");
    s.transport.emit({ type: "error", error: { event_id: create.event_id, message: "bad create" } });
    await flushPromises();
    expect(s.c.status.get()).toBe("listening");
    await speak(s); // next turn is answered again
    expect(s.transport.count("response.create")).toBe(2);
  });

  it("keeps the mic gated past the speaking cap while queued speech is still valid in a disconnected anam", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Short answer here for you. ");
    await done(s, "r1");
    s.setState({ connected: false, speaking: false, expanded: true, starting: true });
    await settle(s, 20_000);
    expect(s.transport.mic).toEqual([false]);
    s.setState({ connected: true, speaking: false, expanded: true });
    await settle(s, 1000);
    expect(s.transport.mic).toEqual([false, true]);
  });

  it("a commit for speech ignored while the mic was gated does not start a turn", async () => {
    const s = setup();
    await openIt(s);
    await speak(s);
    created(s, "r1");
    delta(s, "r1", "Short answer here for you. ");
    await done(s, "r1");
    const creates = s.transport.count("response.create");
    await speak(s); // leaked echo while gated
    expect(s.transport.count("response.create")).toBe(creates);
    expect(s.calls.filter((c) => c.startsWith("turnStart.")).length).toBe(1);
  });
});
