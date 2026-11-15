/**
 * AssistantController: the production brain's lifecycle + per-turn state machine. Pure (everything
 * injected, no electron import) so it is unit-tested with fakes.
 *
 * Lifecycle: open (wake / hotkey / tray) -> Anam call + Realtime + gesture session; close (45 s of
 * silence, hotkey, tray, Anam call ended, connection lost) -> clear overlays, selection, gesture
 * session, Realtime, Anam. interrupt() cancels the current answer and speech.
 *
 * Turn: speech_started -> overlay.onTurnStart + build screen context -> [screen] item (+ selection)
 * -> delete the previous turn's image items -> input_audio_buffer.committed -> response.create
 * (1.2 s timeout fallback). Never two responses at once; late deltas are dropped by response id.
 * Text deltas are sentence-batched into Anam talk chunks. The mic is gated while Anam speaks.
 */
import type { OverlayControl } from "@pointy/shared/overlay";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import type { Clock, TimerHandle } from "../overlay/clock";
import { selectionItems } from "../../renderer/voice/realtimeEvents";
import { screenItemEventWithin, type ScreenContext } from "./screenContext";
import { SentenceBatcher } from "./sentenceBatcher";
import { estimateSpeakMs } from "./speechEstimate";
import { StatusEmitter, type AssistantStatus } from "./status";
import { usesCoordinateTargets } from "./toolTargets";
import type { AnamSpeakerClient, RealtimeServerEvent, RealtimeTransport } from "./types";

export interface AssistantConfig {
  /** Close after this long with no speech and nothing in progress (default 45 s). */
  idleCloseMs: number;
  /** Max wait for the screen context after the user stops talking (default 1.2 s). */
  contextTimeoutMs: number;
  /** Extra time after the estimated end of speech before the mic is re-enabled (default 350 ms). */
  speechMarginMs: number;
  /** Delay before the first words are heard when Anam is idle (default 700 ms). */
  speechStartLatencyMs: number;
  /** Poll interval for Anam state while open / after the estimated speech end (default 4 s / 400 ms). */
  anamPollMs: number;
  speechPollMs: number;
  /** Never hold the mic muted longer than this past the estimate (default 10 s). */
  maxSpeechExtendMs: number;
  /** A selection older than this is not attached to a turn (default 60 s). */
  selectionMaxAgeMs: number;
  /** Close if Anam never reports a connected call within this (default 25 s). */
  anamConnectGraceMs: number;
  /** Speech queued in Anam while its call is not connected stays valid this long (matches Anam's queue age; default 30 s). */
  anamQueueMaxAgeMs: number;
  /** After the offer question finishes (mic released) with no answer for this long, the outline is dropped (default 15 s). */
  offerNoAnswerMs: number;
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  idleCloseMs: 45_000,
  contextTimeoutMs: 1200,
  speechMarginMs: 350,
  speechStartLatencyMs: 700,
  anamPollMs: 4000,
  speechPollMs: 400,
  maxSpeechExtendMs: 10_000,
  selectionMaxAgeMs: 60_000,
  anamConnectGraceMs: 25_000,
  anamQueueMaxAgeMs: 30_000,
  offerNoAnswerMs: 15_000,
};

export interface AssistantDeps {
  transport: RealtimeTransport;
  /** One screen capture + AX snapshot (screenContext.captureScreenContext, bound). Should not reject. */
  buildContext(opts?: { skipScreenshot?: boolean }): Promise<ScreenContext>;
  anam: AnamSpeakerClient;
  overlay: Pick<OverlayControl, "handleTool" | "onTurnStart">;
  gestures: { setSessionActive(active: boolean): void; /** Remove the kept selection outline from the feedback window. */ clearSelection?(): void };
  selection: { latest(): SelectionSnapshot | null; clear(): void; /** A new gesture selection was captured (starts the offer flow). */ onSnapshot?(cb: (s: SelectionSnapshot) => void): () => void };
  /** Monotonic counter bumped whenever the desktop context changes (focus, scroll, window move): coordinate tool calls from an older revision are skipped. */
  contextRevision?(): number;
  clock: Clock;
  status?: StatusEmitter;
  config?: Partial<AssistantConfig>;
  log?(msg: string): void;
}

interface Turn {
  id: string;
  n: number;
  speaking: boolean; // user still talking (no committed yet)
  committed: boolean;
  contextSettled: boolean;
  gaveUp: boolean;
  createRequested: boolean;
  /** A [screen] item was sent for this turn (so a late selection can ride along). */
  screenSent?: boolean;
  /** Desktop context revision when this turn's screen was captured. */
  revision: number;
  timer: TimerHandle | null;
}

/** A selection the assistant asked about and is waiting on an answer for. */
interface Offer {
  sel: SelectionSnapshot;
  /** conversation item ids (selection images + [offer] note) kept for the follow-up turn. */
  itemIds: string[];
  /** The offer response finished (a question was asked): the no-answer timer may run. */
  asked: boolean;
  timer: TimerHandle | null;
  /** Desktop context revision when the selection images were captured (the follow-up turn inherits it). */
  revision: number;
}

type Phase = "closed" | "opening" | "open" | "closing";

interface FunctionCall {
  name: string;
  call_id: string;
  arguments: string;
}

export class AssistantController {
  readonly status: StatusEmitter;
  private readonly cfg: AssistantConfig;
  private readonly log: (msg: string) => void;
  private phase: Phase = "closed";
  /** Bumped on every open/close so async work from an older session is ignored. */
  private epoch = 0;
  private turnCounter = 0;
  private turn: Turn | null = null;
  /** response.create sent, response.created not seen yet. */
  private responseRequested = false;
  private activeResponseId: string | null = null;
  private cancelOnCreate = false;
  private readonly cancelled = new Set<string>();
  private pendingCreate = false;
  private toolsRunning = 0;
  private responseSeq = 0;
  private createSeq = 0;
  private createEventId = "";
  private responseTurnKey = "";
  private talkStarted = false;
  private readonly batcher = new SentenceBatcher();
  private talkGen = 0;
  private selSeq = 0;
  private talkChain: Promise<void> = Promise.resolve();
  private micGated = false;
  private gatedAt = 0;
  /** Speech_started was ignored while the mic was gated: its committed event must not start a turn. */
  private ignoreCommit = false;
  private speechEndsAt = 0;
  /** Estimated total speech length queued since the last reset; with speakingSeenAt it rebases the release deadline onto real playback. */
  private speechEstMs = 0;
  /** First time anam was observed connected + speaking for the current queued speech (playback start). */
  private speakingSeenAt: number | null = null;
  private releaseTimer: TimerHandle | null = null;
  /** Bumped by every clearRelease(): an in-flight Anam state() check from before it must not release the mic. */
  private releaseGen = 0;
  private idleTimer: TimerHandle | null = null;
  private pollTimer: TimerHandle | null = null;
  private prevItemIds: string[] = [];
  private lastSelectionId: string | null = null;
  private openedAt = 0;
  private sawAnamConnected = false;
  private anamMisses = 0;
  private readonly offs: Array<() => void> = [];
  private offer: Offer | null = null;
  /** The next response.created belongs to the offer (it must not clear the outline). */
  private offerCreatePending = false;
  private offerResponseId: string | null = null;
  /** The deferred response.create (pendingCreate) is an offer: tool_choice none. */
  private pendingOfferCreate = false;
  /** A gesture outline is on screen and not yet cleared. */
  private outlineActive = false;
  private offerTok = 0;
  /** A turn took over the offer (its images ride that turn) but the answer has not started: the outline is still waiting on the user. */
  private offerTaken = false;
  private outlineTimer: TimerHandle | null = null;
  /** Desktop context revision at the moment each recent selection was captured (its pixels belong to it). */
  private readonly selRevisions = new Map<string, number>();

  constructor(private readonly deps: AssistantDeps) {
    this.cfg = { ...DEFAULT_ASSISTANT_CONFIG, ...deps.config };
    this.status = deps.status ?? new StatusEmitter();
    this.log = deps.log ?? (() => {});
    this.offs.push(deps.transport.onEvent((e) => this.onServerEvent(e)));
    this.offs.push(deps.transport.onClosed((reason) => this.onTransportClosed(reason)));
    const offSel = deps.selection.onSnapshot?.((s) => void this.onSelection(s));
    if (offSel) this.offs.push(offSel);
  }

  isOpen(): boolean {
    return this.phase === "open" || this.phase === "opening";
  }

  // ------------------------------------------------------------------ lifecycle

  /** Wake gesture: opens only (never closes). */
  wake(): Promise<void> {
    return this.open("wake");
  }

  /** Hotkey: closed -> open; speaking/thinking -> interrupt; otherwise close. */
  async hotkey(): Promise<void> {
    if (this.phase === "closed") return this.open("hotkey");
    if (this.phase === "opening") return this.close("hotkey");
    if (this.phase !== "open") return;
    const s = this.status.get();
    if (s === "speaking" || s === "thinking") return this.interrupt();
    return this.close("hotkey");
  }

  async open(reason = "open"): Promise<void> {
    if (this.phase !== "closed") return;
    this.phase = "opening";
    const my = ++this.epoch;
    this.log(`open (${reason})`);
    this.status.set("opening");
    this.openedAt = this.deps.clock.now();
    this.sawAnamConnected = false;
    this.anamMisses = 0;
    this.deps.gestures.setSessionActive(true);
    try {
      await Promise.all([this.deps.anam.startSession(), this.deps.transport.connect()]);
    } catch (e) {
      if (my !== this.epoch) return; // closed while opening: close() already cleaned up
      this.log(`open failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.teardown("error");
      return;
    }
    if (my !== this.epoch) return;
    this.phase = "open";
    this.status.set("listening");
    this.armIdle();
    this.armPoll();
  }

  async close(reason = "close"): Promise<void> {
    if (this.phase === "closed" || this.phase === "closing") return;
    this.log(`close (${reason})`);
    await this.teardown("idle");
  }

  dispose(): void {
    void this.close("dispose");
    for (const off of this.offs.splice(0)) off();
  }

  /** The user (hotkey/tray) cancels the current answer: response.cancel, then Anam interrupt, then mic back on. */
  async interrupt(): Promise<void> {
    if (this.phase !== "open") return;
    const my = this.epoch;
    this.cancelResponse();
    const gen = this.talkGen; // bumped by cancelResponse; any newer turn/barge-in bumps it again
    const turnAtStart = this.turn;
    this.pendingCreate = false;
    this.pendingOfferCreate = false;
    if (this.turn) this.turn.createRequested = true; // do not answer this turn after an explicit interrupt
    this.clearRelease();
    await this.deps.anam.interrupt().catch((e: unknown) => this.log(`anam interrupt failed: ${String(e)}`));
    if (my !== this.epoch || gen !== this.talkGen || turnAtStart !== this.turn) return; // a newer turn owns the mic now
    this.speechEndsAt = 0;
    this.speechEstMs = 0;
    this.speakingSeenAt = null;
    this.releaseMic();
  }

  /** Anam reported the call ended (e.g. end-call button). */
  notifyAnamEnded(): void {
    void this.close("anam call ended");
  }

  private async teardown(final: AssistantStatus): Promise<void> {
    this.phase = "closing";
    this.epoch++;
    this.clearAllTimers();
    this.talkGen++;
    this.batcher.reset();
    this.turn = null;
    this.responseRequested = false;
    this.activeResponseId = null;
    this.cancelOnCreate = false;
    this.cancelled.clear();
    this.pendingCreate = false;
    this.toolsRunning = 0;
    this.micGated = false;
    this.ignoreCommit = false;
    this.speechEndsAt = 0;
    this.speechEstMs = 0;
    this.speakingSeenAt = null;
    this.prevItemIds = [];
    this.lastSelectionId = null;
    this.selRevisions.clear();
    this.dropOffer(false);
    this.offerCreatePending = false;
    this.offerResponseId = null;
    this.pendingOfferCreate = false;
    this.clearOutline();
    // End the Anam call first (fire now, await below): on quit the process may exit during the awaited overlay clear.
    const anamEnded = this.deps.anam.endSession().catch((e: unknown) => this.log(`anam end failed: ${String(e)}`));
    try {
      this.deps.transport.disconnect();
    } catch (e) {
      this.log(`transport disconnect failed: ${String(e)}`);
    }
    await this.deps.overlay.handleTool("clear", { overlayId: "all" }, { caller: "controller" }).catch((e: unknown) => this.log(`clear failed: ${String(e)}`));
    try {
      this.deps.selection.clear();
    } catch (e) {
      this.log(`selection clear failed: ${String(e)}`);
    }
    try {
      this.deps.gestures.setSessionActive(false);
    } catch (e) {
      this.log(`gesture session close failed: ${String(e)}`);
    }
    await anamEnded;
    this.phase = "closed";
    this.status.set(final);
  }

  private onTransportClosed(reason: string): void {
    if (this.phase === "closed" || this.phase === "closing") return;
    this.log(`realtime connection lost: ${reason}`);
    void this.teardown("error");
  }

  // ------------------------------------------------------------------ server events

  private onServerEvent(ev: RealtimeServerEvent): void {
    if (this.phase !== "open") return;
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        return this.onSpeechStarted();
      case "input_audio_buffer.speech_stopped":
        if (this.turn) this.turn.speaking = false;
        // A barge-in that never commits (cough / VAD false positive) must not leave the offer without its no-answer timer.
        if (!this.busy()) {
          this.maybeStartOfferTimer();
          this.maybeStartOutlineTimer();
        }
        return;
      case "input_audio_buffer.committed":
        return this.onCommitted();
      case "response.created": {
        const id = (ev.response as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") this.onResponseCreated(id);
        return;
      }
      case "response.output_text.delta": {
        const id = ev.response_id;
        if (typeof id !== "string" || id !== this.activeResponseId || this.cancelled.has(id)) return; // late delta
        if (typeof ev.delta === "string") for (const chunk of this.batcher.push(ev.delta)) this.speak(chunk, false);
        return;
      }
      case "response.done":
        return void this.onResponseDone(ev);
      case "conversation.item.input_audio_transcription.completed":
        if (typeof ev.transcript === "string" && ev.transcript.trim()) this.log(`you: ${ev.transcript.trim()}`);
        return;
      case "error": {
        const msg = (ev.error as { message?: string } | undefined)?.message ?? JSON.stringify(ev);
        if (!/no active response/i.test(msg)) this.log(`realtime error: ${msg}`);
        const failedId = (ev.error as { event_id?: unknown } | undefined)?.event_id;
        if (this.responseRequested && typeof failedId === "string" && failedId === this.createEventId) this.onCreateRejected();
        return;
      }
    }
  }

  /** response.create was rejected: no response.created/done will ever arrive, so unstick the turn. */
  private onCreateRejected(): void {
    const deferred = this.pendingCreate; // a create (e.g. the offer's) that was waiting behind the rejected one
    this.responseRequested = false;
    this.cancelOnCreate = false;
    this.offerCreatePending = false;
    if (this.toolsRunning > 0) {
      this.pendingCreate = false;
      return;
    }
    if (deferred) return this.requestResponse(); // sends it (keeping its offer flag) and clears pendingCreate
    this.afterAnswer();
  }

  private onSpeechStarted(): void {
    if (this.micGated) {
      this.ignoreCommit = true; // our own speech leaking: not the user
      return;
    }
    this.clearIdle();
    if (this.activeResponseId || this.responseRequested || this.toolsRunning > 0) {
      // Barge-in while thinking (or while tools run: cancelResponse bumps talkGen so the tool loop stops): stop the stale answer (cancel first, then speech).
      this.cancelResponse();
      void this.deps.anam.interrupt().catch((e: unknown) => this.log(`anam interrupt failed: ${String(e)}`));
    } else if (this.speechEndsAt > this.deps.clock.now()) {
      void this.deps.anam.interrupt().catch(() => undefined);
    }
    this.pendingCreate = false;
    this.pendingOfferCreate = false;
    this.cancelOfferTimer();
    this.cancelOutlineTimer();
    this.clearRelease();
    this.ignoreCommit = false;
    this.startTurn(true);
    this.status.set("listening");
  }

  private startTurn(speaking: boolean): Turn {
    if (this.turn?.timer != null) this.deps.clock.clearTimeout(this.turn.timer);
    const n = ++this.turnCounter;
    const turn: Turn = { id: `turn-${n}`, n, speaking, committed: false, contextSettled: false, gaveUp: false, createRequested: false, revision: this.offer?.revision ?? this.deps.contextRevision?.() ?? 0, timer: null }; // provisional: onContext re-stamps it when the screenshot is actually captured; a retained offer keeps its own revision (its images are what the model sees)
    this.turn = turn;
    try {
      this.deps.overlay.onTurnStart(turn.id);
    } catch (e) {
      this.log(`onTurnStart failed: ${String(e)}`);
    }
    const my = this.epoch;
    void this.deps.buildContext(this.offer ? { skipScreenshot: true } : undefined).then(
      (ctx) => {
        if (my === this.epoch) this.onContext(turn, ctx);
      },
      (e: unknown) => {
        this.log(`screen context failed: ${String(e)}`);
        if (my === this.epoch) this.onContext(turn, null);
      },
    );
    return turn;
  }

  private onContext(turn: Turn, ctx: ScreenContext | null): void {
    if (this.turn !== turn || turn.gaveUp) return; // superseded or too late: never sent
    turn.contextSettled = true;
    // The revision belongs to the captured context (after the AX / overlay-hide wait), not to speech start. A retained offer's images keep the offer's revision.
    turn.revision = this.offer?.revision ?? this.deps.contextRevision?.() ?? turn.revision;
    const ids: string[] = [];
    const events: object[] = [];
    if (ctx) {
      const sid = `scr_${turn.n}`;
      const { event, droppedImage } = screenItemEventWithin(ctx, sid, this.deps.transport.maxMessageBytes());
      if (droppedImage) this.log("screenshot exceeds the data channel message size; sent text only");
      events.push(event);
      ids.push(sid);
      turn.screenSent = true;
      const sel = this.freshSelection();
      if (sel) {
        const { events: selEvents, note } = selectionItems(sel, { maxMessageBytes: this.deps.transport.maxMessageBytes() });
        this.log(`selection attached: ${note}`);
        this.adoptSelectionRevision(turn, sel);
        const seq = ++this.selSeq;
        selEvents.forEach((e, i) => {
          const id = `sel_${turn.n}_${seq}_${i}`;
          const item = (e as { item: object }).item;
          events.push({ ...e, item: { ...item, id } });
          ids.push(id);
        });
        this.lastSelectionId = sel.id;
      }
    }
    // The previous turn's screen/selection items are stale (old ids, old pixels): drop them.
    for (const old of this.prevItemIds) this.deps.transport.send({ type: "conversation.item.delete", item_id: old });
    // The offer's items are NOT taken over here: speech start may never commit (VAD false positive). They are handed over in maybeRespond.
    this.prevItemIds = ids;
    for (const e of events) this.deps.transport.send(e);
    this.maybeRespond(turn);
  }

  /** Coordinates derived from a selection's (newer) full-screen image are valid at the selection's revision, not the earlier speech-start one. */
  private adoptSelectionRevision(turn: Turn, sel: SelectionSnapshot): void {
    const r = this.selRevisions.get(sel.id);
    if (r !== undefined && r > turn.revision) turn.revision = r;
  }

  private freshSelection(): SelectionSnapshot | null {
    const s = this.deps.selection.latest();
    if (!s || s.id === this.lastSelectionId) return null;
    return this.deps.clock.now() - s.capturedAt <= this.cfg.selectionMaxAgeMs ? s : null;
  }

  private onCommitted(): void {
    if (this.ignoreCommit || (this.micGated && !this.turn?.speaking)) {
      this.ignoreCommit = false; // commit of leaked/ignored speech: no new turn
      return;
    }
    let turn = this.turn;
    if (!turn || turn.committed) turn = this.startTurn(false); // speech_started was missed
    turn.speaking = false;
    turn.committed = true;
    this.cancelOutlineTimer();
    this.cancelOfferTimer(); // a speech_stopped may have re-armed it; the utterance is real, the answer path owns the offer now
    this.status.set("thinking");
    this.clearIdle();
    if (!turn.contextSettled) {
      const t = turn;
      turn.timer = this.deps.clock.setTimeout(() => {
        t.timer = null;
        if (this.turn !== t || t.contextSettled) return;
        this.log("screen context too slow; answering without it");
        t.gaveUp = true;
        const kept = this.consumeOffer();
        if (this.prevItemIds.length > 0) {
          // The old screen/selection items describe a previous screen: drop them and say so.
          for (const old of this.prevItemIds) this.deps.transport.send({ type: "conversation.item.delete", item_id: old });
          const nid = `scr_${t.n}`;
          this.prevItemIds = [nid, ...kept];
          this.deps.transport.send({
            type: "conversation.item.create",
            item: { id: nid, type: "message", role: "user", content: [{ type: "input_text", text: "[screen] The current screen could not be captured in time. You cannot see the screen right now; do not rely on earlier screenshots or control ids." }] },
          });
        } else {
          this.prevItemIds = kept;
        }
        this.maybeRespond(t);
      }, this.cfg.contextTimeoutMs);
    }
    this.maybeRespond(turn);
  }

  private maybeRespond(turn: Turn): void {
    if (this.turn !== turn || !turn.committed || turn.createRequested) return;
    if (!turn.contextSettled && !turn.gaveUp) return;
    turn.createRequested = true;
    if (turn.timer != null) this.deps.clock.clearTimeout(turn.timer);
    turn.timer = null;
    this.prevItemIds.push(...this.consumeOffer()); // a committed utterance answers the offer: its items ride this turn and are deleted by the next
    this.attachLateSelection(turn);
    this.requestResponse();
  }

  /** A gesture selection made after the screen context was captured (but before the answer): attach it now. */
  private attachLateSelection(turn: Turn): void {
    if (!turn.screenSent) return;
    const sel = this.freshSelection();
    if (!sel) return;
    const { events, note } = selectionItems(sel, { maxMessageBytes: this.deps.transport.maxMessageBytes() });
    this.log(`late selection attached: ${note}`);
    this.adoptSelectionRevision(turn, sel);
    // Replace any selection already attached for this turn (unique ids; the old items must go).
    const stale = this.prevItemIds.filter((i) => i.startsWith(`sel_${turn.n}_`));
    for (const old of stale) this.deps.transport.send({ type: "conversation.item.delete", item_id: old });
    this.prevItemIds = this.prevItemIds.filter((i) => !stale.includes(i));
    const seq = ++this.selSeq;
    events.forEach((e, i) => {
      const id = `sel_${turn.n}_${seq}_${i}`;
      const item = (e as { item: object }).item;
      this.deps.transport.send({ ...e, item: { ...item, id } });
      this.prevItemIds.push(id);
    });
    this.lastSelectionId = sel.id;
  }

  // ------------------------------------------------------------------ responses

  /** The single place response.create is sent; never while a response is active or pending. */
  private requestResponse(opts?: { offer?: boolean }): void {
    if (opts?.offer) this.pendingOfferCreate = true;
    if (this.responseRequested || this.activeResponseId) {
      this.pendingCreate = true;
      return;
    }
    this.pendingCreate = false;
    const offer = this.pendingOfferCreate;
    this.pendingOfferCreate = false;
    this.offerCreatePending = offer;
    this.responseRequested = true;
    this.cancelOnCreate = false;
    this.status.set("thinking");
    this.createEventId = `rc-${++this.createSeq}`;
    // An offer reply is a spoken question only: tool_choice none (GA response.create accepts it under `response`).
    this.deps.transport.send({ type: "response.create", event_id: this.createEventId, ...(offer ? { response: { tool_choice: "none" } } : {}) });
  }

  private onResponseCreated(id: string): void {
    this.responseRequested = false;
    const cancelling = this.cancelOnCreate; // this response is about to be cancelled: it must neither own the offer nor clear the outline
    if (this.offerCreatePending) {
      this.offerCreatePending = false;
      if (!cancelling) this.offerResponseId = id;
    } else if (this.outlineActive && !cancelling) {
      this.clearOutline(); // the AI starts answering a user turn: the selection outline has done its job
    }
    this.activeResponseId = id;
    this.responseSeq++;
    this.responseTurnKey = `${this.turn?.id ?? "turn-0"}-r${this.responseSeq}`;
    this.talkStarted = false;
    this.batcher.reset();
    if (this.cancelOnCreate) {
      this.cancelOnCreate = false;
      this.cancelled.add(id);
      this.deps.transport.send({ type: "response.cancel" });
    }
  }

  /** response.cancel for whatever is active or about to be; its deltas are dropped from now on. */
  private cancelResponse(): void {
    this.talkGen++;
    this.batcher.reset();
    this.talkStarted = false;
    if (this.activeResponseId) {
      this.cancelled.add(this.activeResponseId);
      this.deps.transport.send({ type: "response.cancel" });
    } else if (this.responseRequested) {
      this.cancelOnCreate = true;
    }
  }

  private async onResponseDone(ev: RealtimeServerEvent): Promise<void> {
    const response = ev.response as { id?: string; status?: string; output?: unknown[] } | undefined;
    const id = response?.id;
    const my = this.epoch;
    const wasCancelled = typeof id === "string" && this.cancelled.has(id);
    if (typeof id === "string") this.cancelled.delete(id);
    if (id !== undefined && id !== this.activeResponseId && !wasCancelled) return; // not ours
    this.activeResponseId = null;
    if (!wasCancelled && id !== undefined && id === this.offerResponseId) {
      this.offerResponseId = null;
      if (this.offer) this.offer.asked = true;
    }

    if (!wasCancelled) {
      const rest = this.batcher.flush();
      if (this.talkStarted || rest) this.speak(rest, true);
    }

    const calls = wasCancelled
      ? []
      : ((response?.output ?? []).filter(
          (o): o is FunctionCall & { type: "function_call" } => typeof o === "object" && o !== null && (o as { type?: string }).type === "function_call",
        ) as FunctionCall[]);

    if (calls.length > 0) {
      const gen = this.talkGen;
      const originTurn = this.turn;
      this.toolsRunning++;
      for (const call of calls) {
        let output: unknown;
        if (this.turn !== originTurn || gen !== this.talkGen) {
          // Superseded by a new turn: do not paint for a stale turn, but keep the conversation consistent.
          output = { ok: false, visible: false, reason: "cancelled", error: "superseded by a new user turn" };
          this.deps.transport.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) } });
          continue;
        }
        try {
          const args: unknown = JSON.parse(call.arguments || "{}");
          if (originTurn && (this.deps.contextRevision?.() ?? 0) !== originTurn.revision && usesCoordinateTargets(args)) {
            // The desktop changed after the screenshot this answer is based on: coordinates would land in the wrong place.
            output = { ok: false, visible: false, reason: "stale_context", error: "The screen changed since you last looked, so these screen positions are out of date. Nothing was drawn. Use element ids from the latest [screen] list, or tell the user you need to look again." };
          } else {
            output = await this.deps.overlay.handleTool(call.name, args);
          }
        } catch (e) {
          output = { ok: false, visible: false, reason: "invalid_input", error: String(e) };
        }
        if (my !== this.epoch) return;
        this.log(`tool ${call.name} -> ${JSON.stringify(output).slice(0, 200)}`);
        this.deps.transport.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) } });
      }
      this.toolsRunning--;
      if (gen !== this.talkGen || this.turn !== originTurn) return; // the user interrupted / barged in while tools ran: no follow-up answer
      this.requestResponse();
      return;
    }
    if (this.pendingCreate) {
      this.requestResponse();
      return;
    }
    if (!this.responseRequested) this.afterAnswer();
  }

  /** The answer (and any tool loop) is complete: release the mic once the avatar is done talking. */
  private afterAnswer(): void {
    if (this.micGated) {
      this.scheduleRelease();
    } else if (!this.turn?.speaking && !(this.turn?.committed && !this.turn.createRequested)) {
      this.status.set("listening");
      this.armIdle();
      this.maybeStartOfferTimer();
    }
  }

  // ------------------------------------------------------------------ selection offer

  private onSelection(sel: SelectionSnapshot): Promise<void> {
    if (this.phase !== "open") return Promise.resolve();
    if (sel.id === this.lastSelectionId) return Promise.resolve();
    this.selRevisions.set(sel.id, this.deps.contextRevision?.() ?? 0);
    if (this.selRevisions.size > 8) this.selRevisions.delete(this.selRevisions.keys().next().value as string);
    return this.runOffer(sel);
  }

  private midUtterance(): boolean {
    const t = this.turn;
    return !!t && (t.speaking || (t.committed && !t.createRequested));
  }

  private async runOffer(sel: SelectionSnapshot): Promise<void> {
    const my = this.epoch;
    const tok = ++this.offerTok;
    const revision = this.selRevisions.get(sel.id) ?? this.deps.contextRevision?.() ?? 0; // the selection's pixels belong to this revision, not to whatever it is after interrupt() waits
    this.outlineActive = true;
    this.offerTaken = false;
    this.dropOffer(false); // a newer selection replaces a pending offer (the feedback window already redrew)
    if (this.midUtterance()) return; // the user is talking: the existing late-attach path hands the selection over, no offer
    const busy = this.micGated || this.responseRequested || this.activeResponseId !== null || this.toolsRunning > 0 || this.status.get() === "speaking" || this.status.get() === "thinking";
    if (busy) {
      // A selection is an explicit user action: stop whatever is being said first.
      await this.interrupt();
      if (my !== this.epoch || tok !== this.offerTok || this.phase !== "open" || this.midUtterance()) return;
    }
    this.sendOffer(sel, revision);
  }

  private sendOffer(sel: SelectionSnapshot, revision: number): void {
    if (this.turn?.timer != null) this.deps.clock.clearTimeout(this.turn.timer);
    const n = ++this.turnCounter;
    const turn: Turn = { id: `turn-${n}`, n, speaking: false, committed: true, contextSettled: true, gaveUp: false, createRequested: true, revision, timer: null };
    this.turn = turn;
    try {
      this.deps.overlay.onTurnStart(turn.id);
    } catch (e) {
      this.log(`onTurnStart failed: ${String(e)}`);
    }
    // The previous turn's screen/selection items are stale: drop them; the offer carries its own images.
    for (const old of this.prevItemIds) this.deps.transport.send({ type: "conversation.item.delete", item_id: old });
    this.prevItemIds = [];
    const { events, note } = selectionItems(sel, { maxMessageBytes: this.deps.transport.maxMessageBytes() });
    this.log(`offer: selection attached: ${note}`);
    const seq = ++this.selSeq;
    const itemIds: string[] = [];
    events.forEach((e, i) => {
      const id = `sel_${n}_${seq}_${i}`;
      this.deps.transport.send({ ...e, item: { ...(e as { item: object }).item, id } });
      itemIds.push(id);
    });
    const oid = `offer_${n}`;
    this.deps.transport.send({
      type: "conversation.item.create",
      item: {
        id: oid,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "[offer] The user just selected this on purpose and has not said anything yet. In ONE short sentence, say what it looks like and offer to check whether it is safe or to explain it. Do not draw anything and do not call any tool yet." }],
      },
    });
    itemIds.push(oid);
    this.lastSelectionId = sel.id;
    this.offer = { sel, itemIds, asked: false, timer: null, revision: turn.revision };
    this.clearIdle();
    this.requestResponse({ offer: true });
  }

  /** Ownership of the offer's item ids moves to the follow-up turn (it deletes them on the turn after). */
  private consumeOffer(): string[] {
    const o = this.offer;
    if (!o) return [];
    this.cancelOfferTimer();
    this.offer = null;
    this.offerTaken = true;
    return o.itemIds;
  }

  /** Forget the offer; optionally also remove the outline. Its conversation items are deleted. */
  private dropOffer(clearOutline: boolean): void {
    const o = this.offer;
    if (o) {
      this.cancelOfferTimer();
      this.offer = null;
      if (this.phase === "open") for (const id of o.itemIds) this.deps.transport.send({ type: "conversation.item.delete", item_id: id });
      this.offerResponseId = null;
    }
    if (clearOutline) this.clearOutline();
  }

  private clearOutline(): void {
    this.outlineActive = false;
    this.offerTaken = false;
    this.cancelOutlineTimer();
    try {
      this.deps.gestures.clearSelection?.();
    } catch (e) {
      this.log(`clear selection outline failed: ${String(e)}`);
    }
  }

  private cancelOutlineTimer(): void {
    if (this.outlineTimer != null) this.deps.clock.clearTimeout(this.outlineTimer);
    this.outlineTimer = null;
  }

  /**
   * The offer was taken over by a barge-in turn (speech start) that then ended without a committed utterance (cough / VAD false
   * positive): nothing will answer, so give the user the same quiet no-answer window before the outline goes.
   */
  private maybeStartOutlineTimer(): void {
    if (!this.offerTaken || !this.outlineActive || this.outlineTimer != null || this.micGated || this.midUtterance()) return;
    const my = this.epoch;
    this.outlineTimer = this.deps.clock.setTimeout(() => {
      this.outlineTimer = null;
      if (my !== this.epoch || this.phase !== "open" || !this.offerTaken || this.busy()) return;
      this.log("offer: no answer after a false barge-in, clearing the selection");
      this.clearOutline();
    }, this.cfg.offerNoAnswerMs);
  }

  private cancelOfferTimer(): void {
    if (this.offer?.timer != null) this.deps.clock.clearTimeout(this.offer.timer);
    if (this.offer) this.offer.timer = null;
  }

  /** 15 s after the question finished (mic released) with no answer: drop the outline quietly. */
  private maybeStartOfferTimer(): void {
    const o = this.offer;
    if (!o || !o.asked || o.timer != null || this.micGated || this.midUtterance()) return;
    const my = this.epoch;
    o.timer = this.deps.clock.setTimeout(() => {
      o.timer = null;
      if (my !== this.epoch || this.offer !== o || this.phase !== "open") return;
      if (this.turn?.speaking) return; // the user is talking right now
      this.log("offer: no answer, clearing the selection");
      this.dropOffer(true);
    }, this.cfg.offerNoAnswerMs);
  }

  // ------------------------------------------------------------------ speaking + half-duplex mic

  private speak(text: string, final: boolean): void {
    const gen = this.talkGen;
    const my = this.epoch;
    const turnId = this.responseTurnKey;
    if (!this.micGated) {
      this.micGated = true;
      this.gatedAt = this.deps.clock.now();
      this.deps.transport.setMicEnabled(false);
    }
    this.clearRelease();
    this.clearIdle();
    this.status.set("speaking");
    this.talkStarted = !final;
    const now = this.deps.clock.now();
    this.speechEndsAt = Math.max(this.speechEndsAt, now + (this.speechEndsAt > now ? 0 : this.cfg.speechStartLatencyMs)) + estimateSpeakMs(text);
    this.speechEstMs += estimateSpeakMs(text);
    this.speakingSeenAt = null;
    this.talkChain = this.talkChain.then(async () => {
      if (gen !== this.talkGen || my !== this.epoch) return; // interrupted / closed meanwhile
      try {
        await this.deps.anam.talk({ turnId, text, final });
      } catch (e) {
        this.log(`anam talk failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  private scheduleRelease(): void {
    this.clearRelease();
    const my = this.epoch;
    const rg = this.releaseGen;
    const now = this.deps.clock.now();
    const check = () => {
      this.releaseTimer = null;
      if (my !== this.epoch) return;
      void this.deps.anam.state().then((st) => {
        if (my !== this.epoch || rg !== this.releaseGen || this.releaseTimer !== null || !this.micGated) return;
        const t = this.deps.clock.now();
        if (st?.connected && st.speaking && this.speakingSeenAt === null) this.speakingSeenAt = t;
        // Playback may start long after the text was generated (Anam connecting late): rebase on first observed speech.
        const deadline = Math.max(this.speechEndsAt, this.speakingSeenAt === null ? 0 : this.speakingSeenAt + this.speechEstMs) + this.cfg.maxSpeechExtendMs;
        // Not connected yet means /talk is still queued in Anam: keep the mic gated until it has played.
        // Not connected: queued speech stays valid in Anam for anamQueueMaxAgeMs, so keep the mic gated that long.
        const waitingForCall = st !== null && !st.connected && t < this.gatedAt + this.cfg.anamQueueMaxAgeMs;
        if (((st?.speaking && t < deadline) || waitingForCall)) {
          this.releaseTimer = this.deps.clock.setTimeout(check, this.cfg.speechPollMs);
          return;
        }
        this.releaseMic();
      });
    };
    const wait = Math.max(0, this.speechEndsAt + this.cfg.speechMarginMs - now);
    this.releaseTimer = this.deps.clock.setTimeout(check, wait);
  }

  private releaseMic(): void {
    this.clearRelease();
    if (this.micGated) {
      this.micGated = false;
      this.deps.transport.setMicEnabled(true);
    }
    if (this.phase === "open") {
      this.status.set("listening");
      this.armIdle();
      this.maybeStartOfferTimer();
    }
  }

  // ------------------------------------------------------------------ timers

  private busy(): boolean {
    return this.micGated || this.responseRequested || this.activeResponseId !== null || this.toolsRunning > 0 || (this.turn?.speaking ?? false) || (this.turn?.committed === true && !this.turn.createRequested);
  }

  private armIdle(): void {
    this.clearIdle();
    const my = this.epoch;
    this.idleTimer = this.deps.clock.setTimeout(() => {
      this.idleTimer = null;
      if (my !== this.epoch || this.phase !== "open") return;
      if (this.busy()) return this.armIdle();
      void this.close("idle (no speech)");
    }, this.cfg.idleCloseMs);
  }

  private clearIdle(): void {
    if (this.idleTimer != null) this.deps.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearRelease(): void {
    if (this.releaseTimer != null) this.deps.clock.clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.releaseGen++;
  }

  /** While open, notice the Anam call ending (end-call button) or Anam going away. */
  private armPoll(): void {
    const my = this.epoch;
    this.pollTimer = this.deps.clock.setTimeout(() => {
      this.pollTimer = null;
      if (my !== this.epoch || this.phase !== "open") return;
      void this.deps.anam.state().then((st) => {
        if (my !== this.epoch || this.phase !== "open") return;
        if (st === null) {
          if (++this.anamMisses >= 3) return void this.close("anam unreachable");
        } else {
          this.anamMisses = 0;
          if (st.connected) this.sawAnamConnected = true;
          else if (this.sawAnamConnected || st.starting === false) return void this.close("anam call ended"); // starting:false = hung up before we ever saw it connected
          else if (this.deps.clock.now() - this.openedAt > this.cfg.anamConnectGraceMs) return void this.close("anam call never connected");
        }
        this.armPoll();
      });
    }, this.cfg.anamPollMs);
  }

  private clearAllTimers(): void {
    this.clearIdle();
    this.clearRelease();
    this.cancelOutlineTimer();
    if (this.pollTimer != null) this.deps.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.turn?.timer != null) this.deps.clock.clearTimeout(this.turn.timer);
  }
}
