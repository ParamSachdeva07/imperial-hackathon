/**
 * AssistantController: the production brain's lifecycle + per-turn state machine. Pure (everything
 * injected, no electron import) so it is unit-tested with fakes.
 *
 * Lifecycle: open (wake / hotkey / tray) -> Anam call + Realtime + gesture session; close (150 s of
 * silence, hotkey double-press, tray, Anam call ended, connection lost) -> clear overlays, selection, gesture
 * session, Realtime, Anam. interrupt() cancels the current answer and speech.
 *
 * Turn: speech_started -> overlay.onTurnStart + build screen context -> [screen] item (+ selection)
 * -> delete the previous turn's image items -> input_audio_buffer.committed -> response.create
 * (1.2 s timeout fallback). Never two responses at once; late deltas are dropped by response id.
 * Text deltas are sentence-batched into Anam talk chunks. Barge-in: see BargeInMode (guarded = echo-checked via the streaming
 * transcript). A rolling in-RAM memory is re-injected as one [memory] item whenever a new Realtime session opens.
 */
import type { OverlayControl, Rect } from "@pointy/shared/overlay";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import type { Clock, TimerHandle } from "../overlay/clock";
import { SILENCE_MS } from "./realtimeProtocol";
import { selectionItems } from "../../renderer/voice/realtimeEvents";
import { screenItemEventWithin, type ScreenContext } from "./screenContext";
import { SentenceBatcher } from "./sentenceBatcher";
import { estimateSpeakMs } from "./speechEstimate";
import { StatusEmitter, type AssistantStatus } from "./status";
import { usesCoordinateTargets } from "./toolTargets";
import type { AnamSpeakerClient, RealtimeServerEvent, RealtimeTransport } from "./types";

export interface AssistantConfig {
  /** Close after this long with no speech and nothing in progress (default 150 s; memory survives a later re-open). */
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
  /** Wait this long after a selection before offering; speech in the window cancels the offer (default 1.2 s). */
  offerDelayMs: number;
  /** Rolling conversation memory: kept this long / at most this many characters (default 20 min / 6000). */
  memoryMaxAgeMs: number;
  memoryMaxChars: number;
  /** The hotkey interrupts (never closes) if something was spoken within this (default 30 s). */
  recentSpokenMs: number;
  /** Two hotkey presses within this close the assistant (default 600 ms). */
  doublePressMs: number;
  /** Echo guard: Anam's own words from this window are compared with a candidate barge-in (default 15 s); overlap at/above echoOverlap = echo. */
  echoWindowMs: number;
  echoOverlap: number;
  /**
   * While Anam speaks, what the microphone heard is cut off and transcribed this often (default 700 ms), so someone talking
   * over the answer is noticed within about a second. Without the cut the model waits for silence, which never comes while
   * the speakers are still playing the answer. 0 turns it off.
   */
  bargeCutMs: number;
  /** This many words Anam did not say are enough to count as the user talking over it (default 2). */
  bargeNovelWords: number;
  /** At most this many drawing tool calls (highlight, point_at, label_parts, show_steps, show_explainer) per answer; extra calls are skipped (default 2). */
  maxDrawingsPerAnswer: number;
}

/** off = old half-duplex (mic muted while Anam speaks); guarded = mic open, echo-checked barge-in; open = any speech interrupts at once (headphones). */
export type BargeInMode = "guarded" | "open" | "off";

/** Parse POINTY_BARGE_IN (guarded|open|off, default guarded). */
export function parseBargeIn(v: string | undefined): BargeInMode {
  const x = (v ?? "").trim().toLowerCase();
  return x === "open" || x === "off" ? x : "guarded";
}

const STOP_PHRASES = ["stop", "wait", "hold on", "pause", "never mind", "nevermind"];

const normWords = (t: string): string[] => t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/** Share of the candidate's words that Anam recently said (0..1). Pure. */
export function wordOverlap(candidate: string, spoken: string): number {
  const w = normWords(candidate);
  if (w.length === 0) return 0;
  const set = new Set(normWords(spoken));
  return w.filter((x) => set.has(x)).length / w.length;
}

/** How many of the candidate's real words (three letters or more) Anam did not just say. Pure. */
export function novelWords(candidate: string, spoken: string): number {
  const said = new Set(normWords(spoken));
  return new Set(normWords(candidate).filter((w) => w.length >= 3 && !said.has(w))).size;
}

/** The text contains a stop word/phrase that Anam did not just say itself. Pure. */
export function hasStopWord(candidate: string, spoken: string): boolean {
  const c = ` ${normWords(candidate).join(" ")} `;
  const sp = ` ${normWords(spoken).join(" ")} `;
  return STOP_PHRASES.some((p) => c.includes(` ${p} `) && !sp.includes(` ${p} `));
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  idleCloseMs: 150_000,
  contextTimeoutMs: 1200,
  speechMarginMs: 350,
  speechStartLatencyMs: 700,
  anamPollMs: 1000,
  speechPollMs: 400,
  maxSpeechExtendMs: 10_000,
  selectionMaxAgeMs: 60_000,
  anamConnectGraceMs: 25_000,
  anamQueueMaxAgeMs: 30_000,
  offerNoAnswerMs: 15_000,
  offerDelayMs: 1200,
  memoryMaxAgeMs: 20 * 60_000,
  memoryMaxChars: 6000,
  recentSpokenMs: 30_000,
  doublePressMs: 600,
  echoWindowMs: 15_000,
  echoOverlap: 0.5,
  bargeCutMs: 700,
  bargeNovelWords: 2,
  maxDrawingsPerAnswer: 2,
};

/** Tools that put something new on screen (clear, move_avatar and advance_step do not count against the drawing budget). */
const DRAWING_TOOLS = new Set(["highlight", "point_at", "label_parts", "show_steps", "show_explainer"]);
const BUDGET_SKIP_ERROR = "skipped: drawing budget reached — explain in words or clear first";
/** Keep at most this many text stubs (left in place of deleted image items) in the conversation. */
const MAX_STUBS = 6;
/** Wait at most this long for a barge-in candidate's transcript before dropping it as noise. */
const CANDIDATE_TRANSCRIPT_WAIT_MS = 15_000;
/** After talking over the answer, how long to wait for the rest of the sentence before answering what was heard. */
const BARGE_REST_WAIT_MS = 6000;

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
  /** Compact "[overlays] ..." description of what is drawn right now; added to every drawing tool's output. */
  overlayState?(): string;
  /** Rects that cards and label_parts title chips must keep clear for this turn (the user's selection, the pointer close-up). Called with [] when none. */
  setTurnAvoid?(rects: Rect[]): void;
  clock: Clock;
  /** POINTY_BARGE_IN (default guarded). */
  bargeIn?: BargeInMode;
  /** Say a short greeting when a call opens. */
  greet?: boolean;
  /**
   * The model speaks in its own voice (audio output, played by the transport) instead of the avatar reading its text.
   * The spoken transcript is then the answer, playback is known from the model's own audio events, and the avatar is not sent text.
   */
  ownVoice?: boolean;
  /**
   * Called with true when an ANSWER (not the short offer) starts being spoken and false when speaking ends / is interrupted / the
   * assistant closes. Production sets the gesture session INACTIVE on true (so an open hand yields wake_requested) and ACTIVE on
   * false (only while the assistant is open). wake_requested while open + answering interrupts.
   */
  onAnswerSpeaking?(speaking: boolean): void;
  /** True while work started by this conversation is still running elsewhere (a background task): the assistant stays open for its result. */
  backgroundWork?(): boolean;
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
  /** Short description for the "[earlier offer about ...]" stub. */
  desc: string;
}

interface MemoryEntry {
  t: number;
  role: "user" | "assistant";
  text: string;
}

/** A speech_started while Anam was speaking (guarded mode): not a turn until its transcript says it is the user. */
interface Candidate {
  text: string;
  committed: boolean;
  state: "pending" | "echo" | "genuine";
  /** When its speech_started arrived (a short one that began after Anam's speech ended is the user, not an echo). */
  startedAt: number;
  /** The transcription failed (no text will come). */
  failed?: boolean;
  /** Cut off by us while Anam was speaking, not by a pause: it is the start of an utterance, not all of it. */
  cut?: boolean;
}

/** The [offer] note. No default safety question: that wording used to be copied into every offer. */
export const OFFER_TEXT =
  "[offer] The user just selected this on purpose and has not said anything yet. In ONE short sentence, say what was selected and ask a fitting open question: " +
  "for a button or control something like \"want to know what it does?\"; for a chart, table or text \"want me to explain it?\"; for a photo or file \"curious what this is?\". " +
  "Offer a safety check ONLY if it looks like an email, message, link, pop-up, download, login or payment, or if something seems off; otherwise do not mention safety at all. " +
  "Vary the wording every time and never reuse the wording of an earlier offer. Do not draw anything and do not call any tool yet.";

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
  private bargeCutTimer: TimerHandle | null = null;
  /** Cuts we asked for whose `committed` has not come back yet. */
  private cutPending = 0;
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
  private micWanted = true;
  /** For the latency log: when the user stopped talking, and when the answer was requested. */
  private speechStoppedAt: number | null = null;
  private requestedAt: number | null = null;
  private micApplied = true;
  /** The Mute button in the avatar window. */
  private userMuted = false;
  /** ownVoice: the model's audio is being heard right now (output_audio_buffer.started .. stopped/cleared). */
  private audioPlaying = false;
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
  private readonly bargeIn: BargeInMode;
  /** Rolling in-RAM conversation memory (never persisted; survives close/open, cleared by clearMemory()). */
  private memory: MemoryEntry[] = [];
  /** What Anam was told to say recently (echo guard). */
  private spokenLog: Array<{ end: number; text: string }> = [];
  /** Chunks of the current response sent to Anam, with their estimated start offset (for "what was actually spoken"). */
  private respChunks: Array<{ text: string; offsetMs: number }> = [];
  private respEstMs = 0;
  private respSpeakStart = 0;
  private respIsOffer = false;
  private answerSpeaking = false;
  private lastSpokenAt = Number.NEGATIVE_INFINITY;
  private lastHotkeyAt = Number.NEGATIVE_INFINITY;
  private readonly candidates = new Map<string, Candidate>();
  private candSeq = 0;
  private offerDelayTimer: TimerHandle | null = null;
  /** Text stubs left in place of deleted image items. */
  private readonly stubs = new Map<string, string>();
  private stubSeq = 0;
  private stubIds: string[] = [];
  /** A selection captured while the assistant was still opening: offered once it is open (cleared if the open fails). */
  private pendingSelection: SelectionSnapshot | null = null;
  /** Global rect of the pointer close-up in the latest [screen] (avoided by cards this turn). */
  private turnCloseup: Rect | null = null;
  /** Drawing tool calls executed for the current answer. */
  private drawingsUsed = 0;
  /** Anam /talk requests currently in flight (an /interrupt that lands before one of them can be overtaken by it). */
  private talksInFlight = 0;
  /** The current response chain continues after its tool calls (do not record the answer yet). */
  private chainOpen = false;
  private noteSeq = 0;
  /** "<app>, window <window>" of the latest [screen] context (for stubs). */
  private screenDesc = "";

  constructor(private readonly deps: AssistantDeps) {
    this.cfg = { ...DEFAULT_ASSISTANT_CONFIG, ...deps.config };
    this.bargeIn = deps.bargeIn ?? "guarded";
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

  /** Wake gesture: opens when closed; while open and an ANSWER is being spoken it is the open-hand interrupt. Never closes. */
  wake(): Promise<void> {
    if (this.phase === "open") return this.answerSpeaking ? this.interrupt() : Promise.resolve();
    return this.open("wake");
  }

  /** Forget the conversation memory ("start over"). */
  clearMemory(): void {
    this.memory = [];
    if (this.phase === "open") void this.resetConversation();
  }

  /**
   * "Start over" while open: the live Realtime conversation (messages, [memory]) still holds the history, so drop the answer in progress
   * and reconnect Realtime for a fresh conversation (the Anam call stays up).
   */
  private async resetConversation(): Promise<void> {
    this.phase = "opening"; // blocks server events and offers while reconnecting
    const my = ++this.epoch;
    this.log("start over: resetting the conversation");
    this.interruptAnam();
    this.resetState();
    this.memory = []; // resetState records what was said so far: forget that too
    try {
      this.deps.transport.disconnect();
      await this.deps.transport.connect();
    } catch (e) {
      if (my !== this.epoch) return;
      this.log(`reset failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.teardown("error");
      return;
    }
    if (my !== this.epoch) return;
    this.phase = "open";
    this.status.set("listening");
    this.armIdle();
    this.armPoll();
  }

  /**
   * Hotkey: closed -> open; two presses within doublePressMs -> close; otherwise interrupt when anything is active or something
   * was spoken within recentSpokenMs (it never closes a recent conversation); else nothing.
   */
  async hotkey(): Promise<void> {
    const now = this.deps.clock.now();
    const dbl = now - this.lastHotkeyAt <= this.cfg.doublePressMs;
    this.lastHotkeyAt = dbl ? Number.NEGATIVE_INFINITY : now;
    if (this.phase === "closed") return this.open("hotkey");
    if (this.phase === "opening") return dbl ? this.close("hotkey double-press") : undefined; // a single press while opening is ignored (the first press already asked to open)
    if (this.phase !== "open") return;
    if (dbl) return this.close("hotkey double-press");
    const s = this.status.get();
    if (this.busy() || s === "speaking" || s === "thinking" || now - this.lastSpokenAt <= this.cfg.recentSpokenMs) return this.interrupt();
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
    this.userMuted = false; // every call starts with the microphone live
    this.deps.gestures.setSessionActive(true);
    this.setMic(true); // a previous half-duplex mute must not survive into the new session (the renderer re-applies its flag on connect)
    try {
      await Promise.all([this.deps.anam.startSession(), this.deps.transport.connect()]);
    } catch (e) {
      if (my !== this.epoch) return; // closed while opening: close() already cleaned up
      this.log(`open failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.teardown("error");
      return;
    }
    if (my !== this.epoch) return;
    this.injectMemory();
    this.phase = "open";
    this.status.set("listening");
    this.armIdle();
    this.armPoll();
    const queued = this.pendingSelection;
    this.pendingSelection = null;
    if (queued) void this.onSelection(queued); // selected while opening: offer now instead of freezing the mouse until the outline's safety cap
    else if (this.deps.greet) this.greet();
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

  /**
   * The user (hotkey / tray / open hand) cancels the current answer. Order: mic back on FIRST, then response.cancel, then Anam
   * /interrupt (fired, not awaited), then an [interrupted] note so the model knows what the user actually heard.
   */
  async interrupt(): Promise<void> {
    if (this.phase !== "open") return;
    this.interruptCore();
  }

  private interruptCore(): void {
    const inFlight = this.responseRequested || this.activeResponseId !== null || this.toolsRunning > 0 || this.micGated || this.speechEndsAt > this.deps.clock.now();
    const offerish = this.respIsOffer || this.offerCreatePending || this.pendingOfferCreate;
    const spoken = this.recordAnswer("interrupted");
    this.pendingCreate = false;
    this.pendingOfferCreate = false;
    if (this.turn && !this.midUtterance()) this.turn.createRequested = true; // do not answer this turn after an explicit interrupt (but never block a turn the user is saying right now)
    this.speechEndsAt = 0;
    this.speechEstMs = 0;
    this.speakingSeenAt = null;
    this.releaseMic(); // un-mute first: the user's next words must not be lost
    this.cancelResponse();
    this.interruptAnam();
    if (spoken || (inFlight && !offerish)) {
      const what = spoken ? ` after: '${spoken}'.` : " before you said anything.";
      this.deps.transport.send({
        type: "conversation.item.create",
        item: { id: `int_${++this.noteSeq}`, type: "message", role: "user", content: [{ type: "input_text", text: `[interrupted] The user stopped you${what} Do not continue that answer unless they ask.` }] },
      });
    }
  }

  /**
   * A note from outside the conversation (a background task ended): put it in front of the model and have it spoken.
   * It waits for a quiet moment, so it never cuts across the user or an answer. While closed it only goes to memory.
   */
  notify(text: string): void {
    this.remember("user", text);
    if (this.phase !== "open") return;
    const my = this.epoch;
    const attempt = (): void => {
      if (my !== this.epoch || this.phase !== "open") return;
      if (this.busy()) {
        this.deps.clock.setTimeout(attempt, 400);
        return;
      }
      this.deps.transport.send({
        type: "conversation.item.create",
        item: { id: `note_${++this.noteSeq}`, type: "message", role: "user", content: [{ type: "input_text", text }] },
      });
      this.requestResponse();
    };
    attempt();
  }

  /** The call just opened: have the model say hello. The note is not kept in memory. */
  private greet(): void {
    this.deps.transport.send({
      type: "conversation.item.create",
      item: { id: `note_${++this.noteSeq}`, type: "message", role: "user", content: [{ type: "input_text", text: "[call started] Greet the user in one short sentence, such as 'Hi, how can I help you today?'. Say nothing else." }] },
    });
    this.requestResponse();
  }

  /** Anam reported the call ended (e.g. end-call button). */
  notifyAnamEnded(): void {
    void this.close("anam call ended");
  }

  /** Drop all per-session / per-answer state (timers, turn, offer, queued speech, mic). */
  private resetState(): void {
    this.clearAllTimers();
    if (this.bargeCutTimer !== null) this.deps.clock.clearTimeout(this.bargeCutTimer);
    this.bargeCutTimer = null;
    this.cutPending = 0;
    this.talkGen++;
    this.batcher.reset();
    this.turn = null;
    this.responseRequested = false;
    this.activeResponseId = null;
    this.cancelOnCreate = false;
    this.cancelled.clear();
    this.pendingCreate = false;
    this.toolsRunning = 0;
    this.recordAnswer("closed"); // what was actually said before the close still goes to memory
    if (this.micGated) this.setMic(true); // the renderer keeps its mic flag across sessions: never leave it muted
    this.micGated = false;
    this.audioPlaying = false;
    this.pendingSelection = null;
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
    this.candidates.clear();
    this.stubs.clear();
    this.stubIds = [];
    this.turnCloseup = null;
    try {
      this.deps.setTurnAvoid?.([]);
    } catch {
      /* ignore */
    }
    this.chainOpen = false;
    this.drawingsUsed = 0;
    this.respChunks = [];
    this.respIsOffer = false;
    this.spokenLog = [];
    this.setAnswerSpeaking(false);
    this.lastHotkeyAt = Number.NEGATIVE_INFINITY;
    this.clearOutline();
  }

  private async teardown(final: AssistantStatus): Promise<void> {
    this.phase = "closing";
    this.epoch++;
    this.resetState();
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
        return this.onSpeechStarted(ev);
      case "input_audio_buffer.speech_stopped":
        this.speechStoppedAt = this.deps.clock.now() - SILENCE_MS; // the event arrives once the silence has lasted this long
        if (this.turn) this.turn.speaking = false;
        // A barge-in that never commits (cough / VAD false positive) must not leave the offer without its no-answer timer.
        if (!this.busy()) {
          this.maybeStartOfferTimer();
          this.maybeStartOutlineTimer();
        }
        return;
      case "input_audio_buffer.committed":
        return this.onCommitted(ev);
      case "response.created": {
        const id = (ev.response as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") this.onResponseCreated(id);
        return;
      }
      case "output_audio_buffer.started":
        this.audioPlaying = true;
        if (this.requestedAt !== null) {
          // Where the wait after the user stops talking goes: detecting the silence and gathering context, then the model.
          const now = this.deps.clock.now();
          const before = this.speechStoppedAt === null ? "" : `end of speech -> request ${Math.round(this.requestedAt - this.speechStoppedAt)} ms, `;
          this.log(`latency: ${before}request -> first audio ${Math.round(now - this.requestedAt)} ms`);
          this.requestedAt = null;
          this.speechStoppedAt = null;
        }
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.audioPlaying = false;
        if (this.deps.ownVoice && this.releaseTimer !== null) this.releaseMic(); // the answer was already complete: it has now been heard in full
        return;
      case "response.output_audio_transcript.delta": // ownVoice: what the model is saying
      case "response.output_text.delta": {
        const id = ev.response_id;
        if (typeof id !== "string" || id !== this.activeResponseId || this.cancelled.has(id)) return; // late delta
        if (typeof ev.delta === "string") for (const chunk of this.batcher.push(ev.delta)) this.speak(chunk, false);
        return;
      }
      case "response.done":
        return void this.onResponseDone(ev);
      case "conversation.item.input_audio_transcription.delta":
        return this.onTranscript(ev.item_id, ev.delta, false);
      case "conversation.item.input_audio_transcription.completed":
        if (typeof ev.transcript === "string" && ev.transcript.trim()) this.log(`you: ${ev.transcript.trim()}`);
        return this.onTranscript(ev.item_id, ev.transcript, true);
      case "conversation.item.input_audio_transcription.failed":
        return this.onTranscriptFailed(ev.item_id);
      case "error": {
        const msg = (ev.error as { message?: string } | undefined)?.message ?? JSON.stringify(ev);
        // A cut with nothing in the buffer is refused: nobody was speaking, which is fine.
        if (/buffer (is )?(too small|empty)|commit/i.test(msg) && this.cutPending > 0) {
          this.cutPending--;
          return;
        }
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

  private onSpeechStarted(ev: RealtimeServerEvent): void {
    let handled = false;
    if (this.micGated) {
      if (this.bargeIn === "off") {
        this.ignoreCommit = true; // our own speech leaking: not the user
        return;
      }
      if (this.bargeIn === "guarded") {
        // Candidate only: no turn, no capture. The transcript decides (echo of Anam vs. the user).
        const id = typeof ev.item_id === "string" ? ev.item_id : `cand_${++this.candSeq}`;
        this.candidates.set(id, { text: "", committed: false, state: "pending", startedAt: this.deps.clock.now() });
        if (this.candidates.size > 8) this.candidates.delete(this.candidates.keys().next().value as string);
        this.armBargeCut();
        return;
      }
      this.interruptCore(); // open: any speech interrupts at once
      handled = true;
    }
    this.clearIdle();
    if (!handled && (this.activeResponseId || this.responseRequested || this.toolsRunning > 0)) {
      // Barge-in while thinking (or while tools run: cancelResponse bumps talkGen so the tool loop stops): stop the stale answer (cancel first, then speech).
      this.recordAnswer("interrupted");
      this.cancelResponse();
      this.interruptAnam();
    } else if (!handled && this.speechEndsAt > this.deps.clock.now()) {
      this.interruptAnam();
    }
    this.startUserTurn(true);
  }

  /** A real user turn begins (speech start, or an adopted barge-in candidate). */
  private startUserTurn(speaking: boolean): void {
    this.pendingCreate = false;
    this.pendingOfferCreate = false;
    if (this.offerDelayTimer != null) this.offerTaken = true; // the offer was skipped: the late-attach path carries the selection; the outline waits for the answer
    this.cancelOfferDelay();
    this.cancelOfferTimer();
    this.cancelOutlineTimer();
    this.clearRelease();
    this.ignoreCommit = false;
    this.startTurn(speaking);
    this.status.set("listening");
  }

  // ------------------------------------------------------------------ barge-in candidates (guarded mode)

  private recentSpoken(): string {
    const now = this.deps.clock.now();
    // Entries are stamped with their estimated playback END: a long answer is still "recent" for echoWindowMs after it stops playing.
    // While the mic is gated the speech is still queued or playing (Anam may connect late), so it always counts; releaseMic re-stamps it to the real end.
    return this.spokenLog.filter((e) => this.micGated || now <= e.end + this.cfg.echoWindowMs).map((e) => e.text).join(" ");
  }

  private onTranscript(itemId: unknown, text: unknown, final: boolean): void {
    if (typeof text !== "string") return;
    const id = typeof itemId === "string" ? itemId : undefined;
    const cand = id !== undefined ? this.candidates.get(id) : undefined;
    if (!cand || !id) {
      if (final && text.trim()) this.remember("user", text.trim());
      return;
    }
    cand.text = final ? text : cand.text + text;
    if (cand.state === "pending") {
      const recent = this.recentSpoken();
      const words = normWords(cand.text).length;
      // A couple of words Anam never said are enough: the user is talking over it.
      if (hasStopWord(cand.text, recent) || novelWords(cand.text, recent) >= this.cfg.bargeNovelWords) this.adoptCandidate(id, cand);
      else if (final) {
        const overlapping = wordOverlap(cand.text, recent) >= this.cfg.echoOverlap;
        // A short phrase that only repeats Anam's words ("explain it" after "want me to explain it?") is the user answering when it
        // began after Anam's speech was estimated to be over: it cannot be an echo of audio that had already stopped.
        const afterSpeech = words <= 3 && cand.startedAt >= this.speechEndsAt + this.cfg.speechMarginMs;
        if (words === 0 || (overlapping && !afterSpeech)) this.dismissEcho(id, cand);
        else this.adoptCandidate(id, cand);
      } else if (words >= 4 && wordOverlap(cand.text, recent) < this.cfg.echoOverlap) this.adoptCandidate(id, cand);
    }
    if (final && cand.state === "genuine") {
      if (cand.text.trim()) this.remember("user", cand.text.trim());
      if (cand.committed) this.candidates.delete(id);
    }
  }

  private onTranscriptFailed(itemId: unknown): void {
    const id = typeof itemId === "string" ? itemId : undefined;
    const cand = id !== undefined ? this.candidates.get(id) : undefined;
    if (!cand || !id || cand.state !== "pending") return;
    cand.failed = true;
    this.dismissEcho(id, cand); // no text will ever come: treat as noise
  }

  /** It is the user talking over Anam: stop the answer and make this item the new user turn. */
  private adoptCandidate(id: string, cand: Candidate): void {
    cand.state = "genuine";
    this.log("barge-in: user spoke over the assistant");
    this.interruptCore();
    if (cand.cut) {
      // We cut this off mid-sentence. Keep listening: the rest arrives as the next item when the user pauses.
      this.candidates.delete(id);
      this.startUserTurn(true);
      const turn = this.turn;
      const my = this.epoch;
      // If they had already finished speaking there is no rest to wait for: answer what was heard.
      this.deps.clock.setTimeout(() => {
        if (my === this.epoch && this.turn === turn && turn && !turn.committed) this.commitTurn();
      }, BARGE_REST_WAIT_MS);
      return;
    }
    this.startUserTurn(!cand.committed);
    if (cand.committed) {
      this.candidates.delete(id);
      this.commitTurn();
    }
  }

  /** While Anam speaks, keep cutting what the microphone heard so it gets transcribed without waiting for silence. */
  private armBargeCut(): void {
    if (this.bargeCutTimer !== null || this.cfg.bargeCutMs <= 0 || this.bargeIn !== "guarded") return;
    const my = this.epoch;
    this.bargeCutTimer = this.deps.clock.setTimeout(() => {
      this.bargeCutTimer = null;
      if (my !== this.epoch || this.phase !== "open" || !this.micGated) return;
      this.cutPending++;
      this.deps.transport.send({ type: "input_audio_buffer.commit" });
      this.armBargeCut();
    }, this.cfg.bargeCutMs);
  }

  /** Anam's own voice picked up by the mic: delete the item and keep speaking. */
  private dismissEcho(id: string, cand: Candidate): void {
    cand.state = "echo";
    this.log("barge-in: ignored (echo of the assistant)");
    if (cand.committed) {
      this.deps.transport.send({ type: "conversation.item.delete", item_id: id });
      this.candidates.delete(id);
    }
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
    this.turnCloseup = ctx?.pointerCloseupRect ?? null;
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
      const m = /Frontmost app: (.*?)\. Window: (.*?)\.(?:\n|$)/.exec(ctx.text);
      if (m) this.screenDesc = `${m[1]}, window ${m[2]}`;
      this.stubs.set(sid, `[earlier screen: ${this.screenDesc || "an earlier screenshot"}]`);
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
          if (i === 0) this.stubs.set(id, this.selectionStub(sel));
        });
        this.lastSelectionId = sel.id;
      }
    }
    // The previous turn's screen/selection items are stale (old ids, old pixels): drop them.
    for (const old of this.prevItemIds) this.dropItem(old);
    // The offer's items are NOT taken over here: speech start may never commit (VAD false positive). They are handed over in maybeRespond.
    this.prevItemIds = ids;
    for (const e of events) this.deps.transport.send(e);
    this.applyTurnAvoid();
    this.maybeRespond(turn);
  }

  /** Cards and label_parts title chips keep clear of what the user selected and of the pointer close-up for this turn. */
  private applyTurnAvoid(): void {
    const rects: Rect[] = [];
    const sel = this.offer?.sel ?? this.deps.selection.latest();
    if (sel && this.deps.clock.now() - sel.capturedAt <= this.cfg.selectionMaxAgeMs) rects.push(sel.regionGlobal);
    if (this.turnCloseup) rects.push(this.turnCloseup);
    try {
      this.deps.setTurnAvoid?.(rects);
    } catch (e) {
      this.log(`set turn avoid failed: ${String(e)}`);
    }
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

  private onCommitted(ev: RealtimeServerEvent): void {
    const cid = typeof ev.item_id === "string" ? ev.item_id : this.candidates.size > 0 ? [...this.candidates.keys()].pop() : undefined;
    let cand = cid !== undefined ? this.candidates.get(cid) : undefined;
    if (this.cutPending > 0) {
      this.cutPending--;
      // Our own cut. The server may give the piece a new item id: treat it as a candidate either way.
      if (!cand && cid) {
        cand = { text: "", committed: false, state: "pending", startedAt: this.deps.clock.now() };
        this.candidates.set(cid, cand);
      }
      if (cand) cand.cut = true;
    }
    if (cand && cid) {
      cand.committed = true;
      if (cand.state === "genuine") {
        this.candidates.delete(cid);
        this.commitTurn();
      } else if (cand.state === "echo") {
        this.deps.transport.send({ type: "conversation.item.delete", item_id: cid });
        this.candidates.delete(cid);
      } else {
        // Wait for the transcript (completed or failed) so real speech is not lost; only a transcript that never comes is dropped as noise/echo.
        const my = this.epoch;
        this.deps.clock.setTimeout(() => {
          if (my === this.epoch && this.candidates.get(cid) === cand && cand.state === "pending") this.dismissEcho(cid, cand);
        }, CANDIDATE_TRANSCRIPT_WAIT_MS);
      }
      return;
    }
    this.commitTurn();
  }

  private commitTurn(): void {
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
          for (const old of this.prevItemIds) this.dropItem(old);
          const nid = `scr_${t.n}`;
          this.prevItemIds = [nid, ...kept];
          this.deps.transport.send({
            type: "conversation.item.create",
            item: { id: nid, type: "message", role: "user", content: [{ type: "input_text", text: "[screen] The current screen could not be captured in time. You cannot see the screen right now; do not rely on earlier screenshots or control ids." }] },
          });
        } else {
          this.prevItemIds = kept;
        }
        this.turnCloseup = null;
        this.applyTurnAvoid();
        this.maybeRespond(t);
      }, this.cfg.contextTimeoutMs);
    }
    this.maybeRespond(turn);
  }

  private maybeRespond(turn: Turn): void {
    if (this.turn !== turn || !turn.committed || turn.createRequested) return;
    if (!turn.contextSettled && !turn.gaveUp) return;
    turn.createRequested = true;
    this.drawingsUsed = 0; // a new answer: fresh drawing budget
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
      if (i === 0) this.stubs.set(id, this.selectionStub(sel));
    });
    this.lastSelectionId = sel.id;
    this.applyTurnAvoid();
  }

  // ------------------------------------------------------------------ responses

  /** The single place response.create is sent; never while a response is active or pending. */
  private requestResponse(opts?: { offer?: boolean }): void {
    this.requestedAt = this.deps.clock.now();
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
    // The previous answer is complete unless this response continues its tool loop: keep what was said until playback ends or the user interrupts.
    if (!this.chainOpen) this.recordAnswer("full");
    this.chainOpen = false;
    const wasOffer = this.offerCreatePending;
    const cancelling = this.cancelOnCreate; // this response is about to be cancelled: it must neither own the offer nor clear the outline
    if (this.offerCreatePending) {
      this.offerCreatePending = false;
      if (!cancelling) this.offerResponseId = id;
    } else if (this.outlineActive && !cancelling) {
      this.clearOutline(); // the AI starts answering a user turn: the selection outline has done its job
    }
    this.activeResponseId = id;
    this.respIsOffer = wasOffer;
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
      // The assistant's own offer wording must not stay in the history (the model copies it next time): replace it with a stub.
      const desc = this.offer?.desc ?? this.screenDesc ?? "the selection";
      for (const o of (response?.output ?? []) as Array<{ type?: string; id?: unknown }>) {
        if (o?.type !== "message" || typeof o.id !== "string") continue;
        this.stubs.set(o.id, `[earlier offer about ${desc}]`);
        this.dropItem(o.id);
      }
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
      this.chainOpen = true; // the follow-up response continues this answer
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
          const drawing = DRAWING_TOOLS.has(call.name);
          if (drawing && this.drawingsUsed >= this.cfg.maxDrawingsPerAnswer) {
            output = { ok: false, visible: false, reason: "budget", error: BUDGET_SKIP_ERROR };
          } else if (originTurn && (this.deps.contextRevision?.() ?? 0) !== originTurn.revision && usesCoordinateTargets(args)) {
            // The desktop changed after the screenshot this answer is based on: coordinates would land in the wrong place.
            output = { ok: false, visible: false, reason: "stale_context", error: "The screen changed since you last looked, so these screen positions are out of date. Nothing was drawn. Use element ids from the latest [screen] list, or tell the user you need to look again." };
          } else {
            output = await this.deps.overlay.handleTool(call.name, args);
            const res = output as { ok?: boolean; visible?: boolean } | null;
            if (drawing && res?.ok && res.visible !== false) this.drawingsUsed++;
          }
        } catch (e) {
          output = { ok: false, visible: false, reason: "invalid_input", error: String(e) };
        }
        if (my !== this.epoch) return;
        output = this.withOverlayState(call.name, output);
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

  /** Drawing tools (and clear) also report what is on screen now, so the model knows before it draws again. */
  private withOverlayState(name: string, output: unknown): unknown {
    if (!(DRAWING_TOOLS.has(name) || name === "clear") || typeof output !== "object" || output === null) return output;
    try {
      const summary = this.deps.overlayState?.();
      return summary ? { ...(output as object), overlays: summary } : output;
    } catch (e) {
      this.log(`overlay state failed: ${String(e)}`);
      return output;
    }
  }

  /** Anam /interrupt (fired, not awaited). Queued talk chunks are dropped; an in-flight /talk that lands after it is interrupted again. */
  private interruptAnam(): void {
    this.talkGen++;
    if (this.deps.ownVoice) this.deps.transport.send({ type: "output_audio_buffer.clear" }); // stop the voice itself; the avatar call below stops the lips
    const fire = () => void this.deps.anam.interrupt().catch((e: unknown) => this.log(`anam interrupt failed: ${String(e)}`));
    fire();
    if (this.talksInFlight > 0) {
      const my = this.epoch;
      void this.talkChain.then(() => {
        if (my === this.epoch) fire();
      });
    }
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
    if (this.phase === "opening") {
      // Keep it until the open finishes (a failed/closed open clears it): ignoring it would freeze the real mouse until the outline's safety cap.
      this.pendingSelection = sel;
      this.selRevisions.set(sel.id, this.deps.contextRevision?.() ?? 0);
      return Promise.resolve();
    }
    if (this.phase !== "open") return Promise.resolve();
    if (sel.id === this.lastSelectionId) return Promise.resolve();
    if (!this.selRevisions.has(sel.id)) this.selRevisions.set(sel.id, this.deps.contextRevision?.() ?? 0);
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
    // Wait a moment: if the user starts talking in this window the offer is skipped and their question carries the selection.
    this.cancelOfferDelay();
    this.offerDelayTimer = this.deps.clock.setTimeout(() => {
      this.offerDelayTimer = null;
      if (my !== this.epoch || tok !== this.offerTok || this.phase !== "open") return;
      if (this.midUtterance() || this.candidates.size > 0) {
        this.offerTaken = true;
        return;
      }
      this.sendOffer(sel, revision);
    }, this.cfg.offerDelayMs);
  }

  private cancelOfferDelay(): void {
    if (this.offerDelayTimer != null) this.deps.clock.clearTimeout(this.offerDelayTimer);
    this.offerDelayTimer = null;
  }

  private selectionStub(sel: SelectionSnapshot): string {
    return `[earlier selection: ${sel.kind === "point" ? "a spot the user pointed at" : "an area the user circled"}${this.screenDesc ? ` in ${this.screenDesc}` : ""}]`;
  }

  /** Delete an old conversation item; if it had images, leave a short text stub in its place first. */
  private dropItem(id: string): void {
    const stub = this.stubs.get(id);
    if (stub) {
      this.stubs.delete(id);
      const stubId = `stub_${++this.stubSeq}`;
      this.deps.transport.send({
        type: "conversation.item.create",
        previous_item_id: id,
        item: { id: stubId, type: "message", role: "user", content: [{ type: "input_text", text: stub }] },
      });
      this.stubIds.push(stubId);
      // Stubs would otherwise pile up for the whole session: keep only the newest few.
      while (this.stubIds.length > MAX_STUBS) this.deps.transport.send({ type: "conversation.item.delete", item_id: this.stubIds.shift() });
    }
    this.deps.transport.send({ type: "conversation.item.delete", item_id: id });
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
    for (const old of this.prevItemIds) this.dropItem(old);
    this.prevItemIds = [];
    const { events, note } = selectionItems(sel, { maxMessageBytes: this.deps.transport.maxMessageBytes() });
    this.log(`offer: selection attached: ${note}`);
    const seq = ++this.selSeq;
    const itemIds: string[] = [];
    events.forEach((e, i) => {
      const id = `sel_${n}_${seq}_${i}`;
      this.deps.transport.send({ ...e, item: { ...(e as { item: object }).item, id } });
      itemIds.push(id);
      if (i === 0) this.stubs.set(id, this.selectionStub(sel));
    });
    const oid = `offer_${n}`;
    this.deps.transport.send({
      type: "conversation.item.create",
      item: {
        id: oid,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: OFFER_TEXT }],
      },
    });
    itemIds.push(oid);
    this.lastSelectionId = sel.id;
    this.offer = { sel, itemIds, asked: false, timer: null, revision: turn.revision, desc: this.screenDesc || "the selection" };
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
      if (this.phase === "open") for (const id of o.itemIds) this.dropItem(id);
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
      this.setMic(false);
    }
    if (text.trim()) {
      const t0 = this.deps.clock.now();
      this.lastSpokenAt = t0;
      if (!this.respIsOffer) {
        if (this.respChunks.length === 0) this.respSpeakStart = t0;
        this.respChunks.push({ text, offsetMs: this.respEstMs });
        this.respEstMs += estimateSpeakMs(text);
        this.setAnswerSpeaking(true);
      }
    }
    this.clearRelease();
    this.clearIdle();
    this.status.set("speaking");
    this.talkStarted = !final;
    const now = this.deps.clock.now();
    this.speechEndsAt = Math.max(this.speechEndsAt, now + (this.speechEndsAt > now ? 0 : this.cfg.speechStartLatencyMs)) + estimateSpeakMs(text);
    this.speechEstMs += estimateSpeakMs(text);
    this.speakingSeenAt = null;
    if (text.trim()) {
      // Stamped with the estimated playback END so the echo guard still covers a long answer's early sentences while they are being heard.
      this.spokenLog.push({ end: this.speechEndsAt, text });
      this.spokenLog = this.spokenLog.filter((e) => this.micGated || now <= e.end + this.cfg.echoWindowMs);
    }
    if (this.deps.ownVoice) return; // the model's own audio is the speech: nothing to send to the avatar
    this.talkChain = this.talkChain.then(async () => {
      if (gen !== this.talkGen || my !== this.epoch) return; // interrupted / closed meanwhile
      this.talksInFlight++;
      try {
        await this.deps.anam.talk({ turnId, text, final });
      } catch (e) {
        this.log(`anam talk failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.talksInFlight--;
      }
    });
  }

  private scheduleRelease(): void {
    this.clearRelease();
    const my = this.epoch;
    const rg = this.releaseGen;
    const now = this.deps.clock.now();
    if (this.deps.ownVoice) {
      // Playback is known exactly from the audio events; the estimate only bounds the wait if one is lost.
      const deadline = Math.max(now, this.speechEndsAt) + this.cfg.maxSpeechExtendMs;
      const poll = (): void => {
        this.releaseTimer = null;
        if (my !== this.epoch || rg !== this.releaseGen || !this.micGated) return;
        if (this.audioPlaying && this.deps.clock.now() < deadline) this.releaseTimer = this.deps.clock.setTimeout(poll, this.cfg.speechPollMs);
        else this.releaseMic();
      };
      this.releaseTimer = this.deps.clock.setTimeout(poll, this.cfg.speechPollMs);
      return;
    }
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
      this.setMic(true);
    }
    this.recordAnswer("full"); // playback is over: the whole answer was heard
    const t = this.deps.clock.now();
    for (const e of this.spokenLog) e.end = Math.max(e.end, t); // the echo window runs from the real end of playback (delayed playback included)
    this.setAnswerSpeaking(false);
    if (this.phase === "open") {
      this.status.set("listening");
      this.armIdle();
      this.maybeStartOfferTimer();
    }
  }

  /** Only half-duplex (off) actually mutes the mic; guarded/open keep it open so the user can talk over Anam. */
  /** Half-duplex (barge-in off) closes the mic while the assistant speaks; the user's own Mute closes it in every mode. */
  private setMic(on: boolean): void {
    if (this.bargeIn === "off") this.micWanted = on;
    const enabled = this.micWanted && !this.userMuted;
    if (this.bargeIn !== "off" && enabled === this.micApplied) return; // nothing changed: only half-duplex re-sends its state
    this.micApplied = enabled;
    this.deps.transport.setMicEnabled(enabled);
  }

  private setAnswerSpeaking(on: boolean): void {
    if (this.answerSpeaking === on) return;
    this.answerSpeaking = on;
    try {
      this.deps.onAnswerSpeaking?.(on);
    } catch (e) {
      this.log(`onAnswerSpeaking failed: ${String(e)}`);
    }
  }

  // ------------------------------------------------------------------ memory

  private remember(role: MemoryEntry["role"], text: string): void {
    const now = this.deps.clock.now();
    this.memory.push({ t: now, role, text: text.length > 600 ? `${text.slice(0, 599)}…` : text });
    this.pruneMemory(now);
  }

  private pruneMemory(now: number): void {
    this.memory = this.memory.filter((m) => now - m.t <= this.cfg.memoryMaxAgeMs);
    let total = 0;
    let keep = this.memory.length;
    for (let i = this.memory.length - 1; i >= 0; i--) {
      total += this.memory[i]!.text.length + 12;
      if (total > this.cfg.memoryMaxChars) break;
      keep = i;
    }
    this.memory = this.memory.slice(keep);
  }

  /**
   * Records the answer chain's spoken text into memory and resets it: all of it ("full": playback finished / the next response begins),
   * only the chunks Anam likely got to say ("interrupted", with a marker) or ("closed", no marker). Returns the recorded text.
   */
  private recordAnswer(mode: "full" | "interrupted" | "closed"): string {
    const chunks = this.respChunks;
    const start = this.respSpeakStart;
    this.respChunks = [];
    this.respEstMs = 0;
    this.respSpeakStart = 0;
    this.chainOpen = false;
    if (chunks.length === 0) return "";
    const used = mode === "full" ? chunks : chunks.filter((c) => c.offsetMs + this.cfg.speechStartLatencyMs <= this.deps.clock.now() - start);
    const text = used.map((c) => c.text).join("").trim();
    if (text) this.remember("assistant", mode === "interrupted" ? `${text} [the user interrupted here]` : text);
    return text;
  }

  /** One [memory] item at the start of each new Realtime session. */
  private injectMemory(): void {
    this.pruneMemory(this.deps.clock.now());
    if (this.memory.length === 0) return;
    const lines = this.memory.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`);
    const text = `[memory] Earlier in this conversation with the same user (oldest first). Use it only to remember what was said; the screen may have changed since.\n${lines.join("\n")}`;
    this.deps.transport.send({ type: "conversation.item.create", item: { id: "memory_1", type: "message", role: "user", content: [{ type: "input_text", text }] } });
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
      if (this.busy() || this.deps.backgroundWork?.()) return this.armIdle();
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
          if ((st.muted === true) !== this.userMuted) {
            this.userMuted = st.muted === true;
            this.log(this.userMuted ? "microphone muted by the user" : "microphone unmuted by the user");
            this.setMic(this.micWanted);
          }
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
    this.cancelOfferDelay();
    if (this.pollTimer != null) this.deps.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.turn?.timer != null) this.deps.clock.clearTimeout(this.turn.timer);
  }
}
