/**
 * OverlayService (spec §5): the OverlayControl the session controller calls.
 * Owns the shared lifecycle of every annotation —
 *   validate → resolve targets → OverlayManager rules → expiry + anchor tracking → publish → fade/exit
 * and delegates everything tool-specific (targets, required/critical targets, selection, layout) to
 * the per-tool kinds in annotations.ts.
 *
 * Electron-free: windows and displays come in through the SceneSink / ScreenSource ports.
 */
import {
  DEFAULT_EXPIRY,
  measureLabel,
  parseToolInput,
  theme,
  type AvatarController,
  type AvoidRectsProvider,
  type BoundsProvider,
  type Caller,
  type DisplayInfo,
  type ElementBounds,
  type Expiry,
  type MoveAvatarInput,
  type OverlayControl,
  type OverlayEvent,
  type Rect,
  type RenderItem,
  type RenderLabel,
  type ScreenCaptureProvider,
  type ShowStepsInput,
  type ToolCallOptions,
  type ToolResult,
  type Tone,
} from "@pointy/shared/overlay";
import { AnchorTracker } from "./AnchorTracker";
import {
  contextTargets,
  kindOf,
  kindOfLive,
  squareAt,
  stepSlot,
  type DrawTool,
  type InputOf,
  type LayoutContext,
  type Live,
  type Slot,
} from "./annotations";
import { realClock, type Clock, type TimerHandle } from "./clock";
import { displayForRect, findDisplay } from "./coords";
import { ExpiryManager, expiresAtTurnStart, expiresOnContextChange } from "./ExpiryManager";
import { ExplainerService } from "./explainer/ExplainerService";
import type { ImageSource } from "./explainer/falClient";
import { chooseAvatarPosition } from "./avatar/avatarPlacement";
import { inflate, intersects, rectsEqual } from "./geometry";
import { placeBeside, pointerBody, type Placement } from "./LayoutEngine";
import { OverlayManager } from "./OverlayManager";
import type { OverlayDebug, SceneSink, ScreenSource } from "./ports";
import { advanceSteps, startSteps } from "./steps";
import { isCoordinateOnly, TargetResolver, type ResolvedTarget } from "./TargetResolver";

export interface OverlayServiceDeps {
  boundsProvider: BoundsProvider;
  captureProvider: ScreenCaptureProvider;
  screen: ScreenSource;
  sink: SceneSink;
  avoidRects?: AvoidRectsProvider;
  /** The voice avatar window, when there is one: enables `move_avatar` and auto-dodge. */
  avatar?: AvatarController;
  imageSource?: ImageSource;
  clock?: Clock;
  reduceMotion?: () => boolean;
  /** Anchor polling interval (spec: ~300 ms). */
  anchorIntervalMs?: number;
  /** How long a completed step guide shows "✓ All done" before fading. */
  stepsCompletedHoldMs?: number;
  /** Hide overlay windows during anatomy capture (when content protection doesn't exclude them). */
  hideDuringCapture?: boolean;
}

const EXIT_MARGIN_MS = 50;
/** Auto-dodge: at most one automatic avatar move per this long (the avatar must not dart around). */
const AUTO_DODGE_MIN_INTERVAL_MS = 1500;
/** Auto-dodge triggers when the avatar comes within this distance of what a drawing points at. */
const AUTO_DODGE_MARGIN = 16;
/** How long a step that isn't on screen yet may take to appear after the guide advances to it. */
const STEP_APPEAR_GRACE_MS = 2000;

/** A show() call still resolving its targets; cancelled by the same rules that would expire it. */
interface InFlight {
  expires: Expiry;
  coordinateOnly: boolean;
  cancelled: boolean;
}

type StepsLive = Extract<Live, { toolName: "show_steps" }>;
type ExplainerLive = Extract<Live, { toolName: "show_explainer" }>;

const ok = (overlayId: string, bounds: Rect | undefined, extra: Partial<ToolResult> = {}): ToolResult => ({
  ok: true,
  overlayId,
  visible: true,
  ...(bounds ? { resolvedBounds: bounds } : {}),
  ...extra,
});
const AVATAR_UNAVAILABLE: ToolResult = { ok: false, visible: false, reason: "avatar_unavailable" };
const CANCELLED: ToolResult = { ok: false, visible: false, reason: "cancelled" };

/** The parts of a drawing that can be moved out of the way (labels and cards, not targets). */
function movableBoxes(item: RenderItem): Rect[] {
  switch (item.kind) {
    case "highlight":
    case "pointer":
      return item.label ? [item.label.rect] : [];
    case "parts":
      return [...item.parts.flatMap((p) => (p.label ? [p.label.rect] : [])), ...(item.title ? [item.title.rect] : [])];
    case "steps":
      return item.steps.flatMap((s) => (s.labelBox ? [s.labelBox.rect] : []));
    case "explainer":
      return [item.card];
  }
}

const expiryOf = (input: { expires?: Expiry | undefined }): Expiry => input.expires ?? DEFAULT_EXPIRY;

export class OverlayService implements OverlayControl {
  private readonly clock: Clock;
  private readonly manager: OverlayManager;
  private readonly resolver: TargetResolver;
  private readonly expiry: ExpiryManager;
  private readonly anchors: AnchorTracker;
  private readonly explainers: ExplainerService;
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<(e: OverlayEvent) => void>();
  private readonly disposers: (() => void)[] = [];
  private readonly inflight = new Set<InFlight>();
  /** Cached display list (invalidated when displays change). */
  private displayCache: DisplayInfo[] | null = null;
  /** Bumped per display-change relayout; an older relayout's results are discarded. */
  private relayoutGen = 0;
  /** Anchors moved during the current check (published once when it completes). */
  private anchorsMoved = false;
  /** Avatar moves (explicit and automatic) run one at a time. */
  private avatarChain: Promise<unknown> = Promise.resolve();
  /** Time of the last SUCCESSFUL automatic move (failed or no-op attempts don't consume the rate limit). */
  private lastAutoDodgeAt = Number.NEGATIVE_INFINITY;
  /** The one pending trailing auto-dodge check (scheduled when a check lands inside the rate window). */
  private dodgeTimer: TimerHandle | null = null;
  private disposed = false;

  constructor(private readonly deps: OverlayServiceDeps) {
    this.clock = deps.clock ?? realClock;
    this.manager = new OverlayManager({ now: () => this.clock.now() });
    this.resolver = new TargetResolver({ boundsProvider: deps.boundsProvider, getDisplays: () => this.displays() });
    this.expiry = new ExpiryManager({ clock: this.clock, onExpire: (id) => this.fade(id, { type: "overlay.expired", overlayId: id }) });
    this.anchors = new AnchorTracker({
      boundsProvider: deps.boundsProvider,
      clock: this.clock,
      intervalMs: deps.anchorIntervalMs ?? 300,
      onMoved: (id, el, b) => this.handleAnchorMoved(id, el, b),
      onLost: (id, el) => this.handleAnchorLost(id, el),
      // One redraw per check, however many anchors moved in it.
      onCheckDone: () => {
        if (!this.anchorsMoved) return;
        this.anchorsMoved = false;
        this.publish();
      },
    });
    this.explainers = new ExplainerService({
      captureProvider: deps.captureProvider,
      ...(deps.imageSource ? { imageSource: deps.imageSource } : {}),
      getDisplays: () => this.displays(),
      hideDuringCapture: deps.hideDuringCapture ?? false,
    });
    this.anchors.start();
    this.disposers.push(deps.sink.onPainted((ids) => this.handlePainted(ids)));
    this.disposers.push(deps.sink.onImageFailed((id, panel) => this.handleImageFailed(id, panel)));
    this.disposers.push(
      deps.screen.onDisplaysChanged(() => {
        this.displayCache = null;
        void this.relayoutAll();
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.dodgeTimer !== null) this.clock.clearTimeout(this.dodgeTimer);
    this.dodgeTimer = null;
    this.anchors.stop();
    this.expiry.dispose();
    for (const d of this.disposers) d();
    for (const l of this.live.values()) {
      l.ended = true;
      if (l.exitTimer) this.clock.clearTimeout(l.exitTimer);
      if (l.graceTimer) this.clock.clearTimeout(l.graceTimer);
    }
    this.live.clear();
  }

  // ---------------------------------------------------------------- OverlayControl

  async handleTool(name: string, input: unknown, opts: ToolCallOptions = {}): Promise<ToolResult> {
    const parsed = parseToolInput(name, input);
    if (!parsed.success) return { ok: false, visible: false, reason: "invalid_input" };
    switch (parsed.name) {
      case "clear":
        return this.clear((parsed.data as { overlayId: string }).overlayId, opts.caller ?? "model");
      case "advance_step":
        return this.advance((parsed.data as { stepsId: string }).stepsId);
      case "move_avatar":
        return this.moveAvatar(parsed.data as MoveAvatarInput);
      case "highlight":
      case "label_parts":
      case "point_at":
      case "show_steps":
      case "show_explainer":
        return this.show(parsed.name, parsed.data as InputOf<DrawTool>);
      default:
        return { ok: false, visible: false, reason: "invalid_input" }; // stretch tools aren't enabled yet
    }
  }

  onTurnStart(turnId: string): void {
    this.cancelInFlight(expiresAtTurnStart);
    this.expiry.onTurnStart(turnId);
    for (const id of this.manager.endTurn()) this.endLive(id);
  }

  onContextChange(): void {
    this.cancelInFlight(expiresOnContextChange);
    this.expiry.onContextChange();
  }

  onTargetSelected(elementId: string): void {
    for (const l of [...this.live.values()]) {
      if (l.ended || !l.elements.has(elementId)) continue;
      const action = kindOfLive(l).onSelected(l, elementId);
      if (action === "ignore") continue;
      this.emit({ type: "overlay.target_selected", overlayId: l.id });
      if (action === "advance") this.advance(l.id);
    }
    this.expiry.onTargetSelected(elementId);
  }

  cue(_cueId: string): void {
    // Stretch (speech-synced cues): not enabled in the MVP.
  }

  onEvent(cb: (e: OverlayEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getOverlayWindowIds(): number[] {
    return this.deps.sink.getWindowIds();
  }

  withOverlayHidden<T>(fn: () => Promise<T>): Promise<T> {
    return this.deps.sink.withHidden(fn);
  }

  /** Dev-only introspection, handed to the dev server separately from the OverlayControl contract. */
  createDebug(): OverlayDebug {
    return {
      state: () =>
        [...this.live.values()].map((l) => ({
          id: l.id,
          tool: l.toolName,
          state: this.manager.get(l.id)?.state ?? "removed",
          bounds: this.primaryBounds(l) ?? null,
          steps: l.toolName === "show_steps" ? l.steps : null,
        })),
      anatomyImage: (id) => {
        const item = this.live.get(id)?.item;
        if (item?.kind !== "explainer" || item.body.kind !== "anatomy" || item.body.image.status !== "ready") return null;
        return item.body.image.src;
      },
    };
  }

  // ---------------------------------------------------------------- show

  private async show<T extends DrawTool>(tool: T, input: InputOf<T>): Promise<ToolResult> {
    const kind = kindOf(tool);
    if (kind.invalid?.(input)) return { ok: false, visible: false, reason: "invalid_input" };
    const slots = kind.slots(input);
    const displayGen = this.relayoutGen;
    const call: InFlight = {
      expires: expiryOf(input),
      // Any coordinate target (incl. anatomy callouts: the crop is a snapshot) goes stale on a context change.
      coordinateOnly: contextTargets(tool, input, slots).some(isCoordinateOnly),
      cancelled: false,
    };
    this.inflight.add(call);
    let results: (readonly [Slot, Awaited<ReturnType<TargetResolver["resolve"]>>])[];
    try {
      results = await Promise.all([...slots].map(async ([slot, t]) => [slot, await this.resolver.resolve(t)] as const));
    } finally {
      this.inflight.delete(call);
    }
    // clear("all"), a new turn or a context change arrived while resolving and would have removed it.
    if (call.cancelled) return CANCELLED;

    const resolved = new Map<Slot, ResolvedTarget | null>();
    let anchorFailure: ToolResult["reason"];
    let firstFailure: ToolResult["reason"];
    for (const [slot, r] of results) {
      if (r.ok) {
        resolved.set(slot, r.target);
        continue;
      }
      resolved.set(slot, null);
      firstFailure ??= r.reason;
      if (kind.required(input, slot)) return { ok: true, visible: false, reason: r.reason };
      if (slot === "anchor") anchorFailure = r.reason;
    }

    if (kind.drawable && !kind.drawable(input, resolved)) return { ok: true, visible: false, reason: firstFailure ?? "target_not_found" };

    const elements = new Map<string, Slot[]>();
    for (const [slot, target] of slots) {
      if (target.kind === "element") elements.set(target.elementId, [...(elements.get(target.elementId) ?? []), slot]);
    }
    const l = this.createLive(tool, input, { id: this.manager.nextId(kind.idPrefix), slots, resolved, elements });

    const { dismissed } = this.manager.add({
      id: l.id,
      toolName: tool,
      input,
      resolvedBounds: this.primaryBounds(l) ?? null,
      displayId: kindOfLive(l).primary(l)?.displayId ?? null,
      turnId: input.turnId,
    });
    this.live.set(l.id, l);
    for (const d of dismissed) this.startExit(d.id, { type: "overlay.dismissed", overlayId: d.id, by: "model", reason: d.reason });

    this.refresh(l);
    this.reflowCovering(l);
    this.expiry.track({ id: l.id, expires: call.expires, elementIds: kindOfLive(l).selectionElementIds(l), coordinateOnly: call.coordinateOnly });
    this.trackAnchors(l);
    this.publish();
    if (l.toolName === "show_explainer") this.loadExplainerAsync(l);
    // Displays changed while we were resolving: re-check this annotation against the new layout.
    if (this.relayoutGen !== displayGen) void this.relayoutAll();

    this.requestAutoDodge();

    // A card whose anchor can't be resolved is still shown (centred-right); report why it's unanchored.
    return ok(l.id, this.primaryBounds(l), anchorFailure ? { reason: anchorFailure } : {});
  }

  private createLive<T extends DrawTool>(tool: T, input: InputOf<T>, base: Pick<Live, "id" | "slots" | "resolved" | "elements">): Live {
    const common = { ...base, item: null, shown: false, exitTimer: null, graceTimer: null, ended: false, placements: new Map() };
    switch (tool) {
      case "show_steps": {
        const s = input as ShowStepsInput;
        return { ...common, toolName: "show_steps", input: s, steps: startSteps(s.steps.length, s.startAt) };
      }
      case "show_explainer": {
        const e = input as InputOf<"show_explainer">;
        return { ...common, toolName: "show_explainer", input: e, explainer: this.explainers.create(e.spec) };
      }
      default:
        return { ...common, toolName: tool, input } as Live;
    }
  }

  /**
   * Never cover the thing being explained: an older label or card that sits on a control this new
   * annotation points at is re-laid out (it now avoids that control; its side is kept if possible).
   */
  private reflowCovering(l: Live): void {
    const targets = [...l.resolved.values()].flatMap((r) => (r ? [r.bounds] : []));
    if (targets.length === 0) return;
    for (const other of this.live.values()) {
      if (other === l || other.ended || !other.item) continue;
      if (movableBoxes(other.item).some((b) => targets.some((t) => intersects(b, t)))) this.refresh(other);
    }
  }

  /** Follow element targets — only what resolved, unless the kind watches for elements to appear. */
  private trackAnchors(l: Live): void {
    const initial = new Map<string, ElementBounds>();
    for (const [el, slots] of l.elements) {
      const r = l.resolved.get(slots[0]!);
      if (r) initial.set(el, { rect: r.bounds, displayId: r.displayId });
    }
    const tracked = kindOfLive(l).watchUnresolved ? [...l.elements.keys()] : [...initial.keys()];
    if (tracked.length) this.anchors.track(l.id, tracked, initial);
  }

  // ---------------------------------------------------------------- avatar

  private moveAvatar(input: MoveAvatarInput): Promise<ToolResult> {
    return this.serializeAvatar(() => this.performAvatarMove(input.position, input.avoid, input.displayId, []));
  }

  /**
   * Something on screen changed (a drawing was shown, a step guide moved on, a target appeared):
   * ask for an auto-dodge check. Fire-and-forget (never delays or changes a tool result). The check
   * itself runs serialized on the avatar chain and works from the CURRENT drawings and avatar bounds.
   */
  private requestAutoDodge(): void {
    if (this.disposed || !this.deps.avatar) return;
    void this.serializeAvatar(() => this.runAutoDodgeCheck());
  }

  private async runAutoDodgeCheck(): Promise<ToolResult> {
    const avatar = this.deps.avatar;
    if (this.disposed || !avatar) return AVATAR_UNAVAILABLE;
    const bounds = avatar.getBounds();
    if (!bounds || !avatar.isMovable()) return AVATAR_UNAVAILABLE;
    // A step guide shows one control at a time; the other drawings every target they use.
    const near: Rect[] = [];
    for (const l of this.live.values()) {
      if (l.ended) continue;
      const targets =
        l.toolName === "show_steps"
          ? [this.primaryBounds(l)].flatMap((b) => (b ? [b] : []))
          : [...l.resolved.values()].flatMap((r) => (r ? [r.bounds] : []));
      for (const t of targets) near.push(inflate(t, AUTO_DODGE_MARGIN));
    }
    if (!near.some((t) => intersects(t, bounds))) return { ok: true, visible: true, resolvedBounds: bounds };
    const wait = this.lastAutoDodgeAt + AUTO_DODGE_MIN_INTERVAL_MS - this.clock.now();
    if (wait > 0) {
      // Too soon after the last move: one trailing check at the end of the window instead of dropping it.
      if (this.dodgeTimer === null) {
        this.dodgeTimer = this.clock.setTimeout(() => {
          this.dodgeTimer = null;
          this.requestAutoDodge();
        }, wait);
      }
      return AVATAR_UNAVAILABLE;
    }
    const result = await this.performAvatarMove("auto", undefined, undefined, near);
    const after = avatar.getBounds();
    if (!this.disposed && result.ok && after && (after.x !== bounds.x || after.y !== bounds.y)) {
      this.lastAutoDodgeAt = this.clock.now();
    }
    return result;
  }

  private serializeAvatar(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    const run = this.avatarChain.then(fn, fn).catch((): ToolResult => AVATAR_UNAVAILABLE);
    this.avatarChain = run;
    return run;
  }

  private async performAvatarMove(
    position: MoveAvatarInput["position"],
    avoidTarget: MoveAvatarInput["avoid"],
    displayId: string | undefined,
    extraAvoid: Rect[],
  ): Promise<ToolResult> {
    const avatar = this.deps.avatar;
    if (this.disposed || !avatar || !avatar.isMovable() || !avatar.getBounds()) return AVATAR_UNAVAILABLE;
    const avoid = [...extraAvoid];
    if (avoidTarget) {
      const r = await this.resolver.resolve(avoidTarget);
      if (r.ok) avoid.push(r.target.bounds); // an avoid target that can't be resolved is ignored
    }
    const current = avatar.getBounds();
    if (this.disposed || !current || !avatar.isMovable()) return AVATAR_UNAVAILABLE; // disposed, collapsed or grabbed while resolving
    const displays = this.displays();
    const own = displayForRect(current, displays);
    const display = displayId ? findDisplay(displayId, displays) : (own ?? findDisplay(this.deps.screen.getPrimaryDisplayId(), displays) ?? displays[0]);
    if (!display) return { ok: false, visible: false, reason: "display_not_found" };
    // Everything on screen the avatar should stay off, but not the avatar itself.
    avoid.push(...this.avoidFor("").filter((a) => !rectsEqual(a, current)));
    const to = chooseAvatarPosition({ avatar: current, workArea: display.workArea, position, avoid, relocate: display.id !== own?.id });
    if (to.x === current.x && to.y === current.y) return { ok: true, visible: true, resolvedBounds: current };
    const moved = await avatar.moveTo(to);
    if (!moved || this.disposed) return AVATAR_UNAVAILABLE;
    // The avatar is an avoid rect for every label and card: lay them out again around its new spot.
    for (const l of this.live.values()) if (!l.ended && l.item) this.refresh(l);
    this.publish();
    return { ok: true, visible: true, resolvedBounds: moved };
  }

  // ---------------------------------------------------------------- clear / steps

  private clear(overlayId: string, by: Caller): ToolResult {
    if (overlayId === "all") {
      this.cancelInFlight(() => true);
      for (const l of [...this.live.values()]) {
        if (!l.ended) this.fade(l.id, { type: "overlay.dismissed", overlayId: l.id, by, reason: "cleared" });
      }
      return { ok: true, visible: false };
    }
    const l = this.live.get(overlayId);
    if (!l || l.ended) return { ok: false, visible: false, reason: "unknown_overlay" };
    this.fade(overlayId, { type: "overlay.dismissed", overlayId, by, reason: "cleared" });
    return { ok: true, overlayId, visible: false };
  }

  private advance(stepsId: string): ToolResult {
    const l = this.live.get(stepsId);
    if (!l || l.ended || l.toolName !== "show_steps") return { ok: false, visible: false, reason: "unknown_overlay" };
    if (l.steps.completed) return ok(stepsId, this.primaryBounds(l));
    l.steps = advanceSteps(l.steps);
    if (l.steps.completed) {
      this.emit({ type: "steps.completed", stepsId });
      this.refresh(l);
      this.publish();
      // "✓ All done" briefly, then end — unless the caller asked for a manual or timed lifetime.
      const explicit = l.input.expires;
      if (explicit !== "manual" && typeof explicit !== "object") {
        const hold = { ms: Math.max(500, this.deps.stepsCompletedHoldMs ?? 1500) };
        this.expiry.track({ id: stepsId, expires: hold, elementIds: [], coordinateOnly: false });
      }
      return ok(stepsId, this.primaryBounds(l));
    }
    this.emit({ type: "steps.advanced", stepsId, index: l.steps.current });
    this.refresh(l);
    this.publish();
    this.checkCurrentStepAppears(l);
    this.requestAutoDodge(); // the new current step's control may be under the avatar
    return ok(stepsId, this.primaryBounds(l), { visible: !!l.resolved.get(stepSlot(l.steps.current)) });
  }

  /**
   * After advancing to a step whose element isn't on screen yet (it may appear once the previous
   * step is done), give it a grace period; if it still hasn't appeared, the guide is lost.
   */
  private checkCurrentStepAppears(l: StepsLive): void {
    const slot = stepSlot(l.steps.current);
    if (l.resolved.get(slot)) return;
    if (l.graceTimer) this.clock.clearTimeout(l.graceTimer);
    l.graceTimer = this.clock.setTimeout(() => {
      l.graceTimer = null;
      if (l.ended || l.steps.completed || stepSlot(l.steps.current) !== slot || l.resolved.get(slot)) return;
      this.fade(l.id, { type: "overlay.target_lost", overlayId: l.id });
    }, STEP_APPEAR_GRACE_MS);
  }

  // ---------------------------------------------------------------- lifecycle

  private cancelInFlight(shouldCancel: (c: InFlight) => boolean): void {
    for (const c of this.inflight) if (shouldCancel(c)) c.cancelled = true;
  }

  /** Begin fading an annotation (unless it's already leaving), announcing why. */
  private fade(id: string, event: OverlayEvent): void {
    if (this.manager.beginExit(id)) this.startExit(id, event);
  }

  /** The manager has it as "exiting": announce, stop tracking, draw it fading, remove it after. */
  private startExit(id: string, event: OverlayEvent): void {
    this.emit(event);
    this.expiry.untrack(id);
    this.anchors.untrack(id);
    const l = this.live.get(id);
    if (!l) return;
    l.ended = true;
    this.refresh(l);
    this.publish();
    l.exitTimer = this.clock.setTimeout(() => this.endLive(id), theme.anim.exitMs + EXIT_MARGIN_MS);
  }

  /** Remove after the fade (or immediately for pending ones). */
  private endLive(id: string): void {
    const l = this.live.get(id);
    if (l?.exitTimer) this.clock.clearTimeout(l.exitTimer);
    if (l?.graceTimer) this.clock.clearTimeout(l.graceTimer);
    this.expiry.untrack(id);
    this.anchors.untrack(id);
    this.manager.remove(id);
    this.live.delete(id);
    this.publish();
  }

  private handlePainted(ids: string[]): void {
    for (const id of ids) {
      const l = this.live.get(id);
      if (!l || l.shown || l.ended) continue;
      l.shown = true;
      this.emit({ type: "overlay.shown", overlayId: id });
    }
  }

  /** A picture the renderer couldn't decode: fall back to its icon everywhere and tell the controller. */
  private handleImageFailed(id: string, panel: number): void {
    const l = this.live.get(id);
    if (!l || l.ended || l.toolName !== "show_explainer") return;
    if (!this.explainers.markFailed(l.explainer, panel)) return; // another window already reported it
    this.refresh(l);
    this.publish();
    this.emit({ type: "explainer.image_failed", overlayId: id, panel });
  }

  private handleAnchorMoved(id: string, elementId: string, bounds: ElementBounds): void {
    const l = this.live.get(id);
    if (!l || l.ended) return;
    // Same rules as TargetResolver: the display is the one containing the element; an element moved
    // fully off every display counts as lost.
    const display = displayForRect(bounds.rect, this.displays());
    if (!display) return this.handleAnchorLost(id, elementId);
    const appeared = (l.elements.get(elementId) ?? []).some((slot) => !l.resolved.get(slot));
    for (const slot of l.elements.get(elementId) ?? []) {
      l.resolved.set(slot, { bounds: bounds.rect, displayId: display.id, shape: { kind: "rect" }, elementId });
    }
    this.manager.update(id, { resolvedBounds: this.primaryBounds(l) ?? null, displayId: kindOfLive(l).primary(l)?.displayId ?? null });
    this.refresh(l);
    this.anchorsMoved = true; // published when the anchor check completes
    if (appeared) this.requestAutoDodge(); // a previously unresolved target just showed up
  }

  private handleAnchorLost(id: string, elementId: string): void {
    const l = this.live.get(id);
    if (!l || l.ended) return;
    this.applyLostSlots(l, l.elements.get(elementId) ?? []);
    if (!l.ended) this.anchorsMoved = true; // re-laid out without it; published after the check
  }

  /**
   * These slots just went away. If the kind can't draw without one of them: fade with target_lost,
   * keeping the last geometry so the whole drawing fades together (spec §5.4). Otherwise forget them
   * and re-lay out.
   */
  private applyLostSlots(l: Live, lost: Slot[]): void {
    const kind = kindOfLive(l);
    if (lost.some((s) => kind.critical(l, s, lost))) {
      this.fade(l.id, { type: "overlay.target_lost", overlayId: l.id });
      return;
    }
    for (const s of lost) l.resolved.set(s, null);
    this.refresh(l);
  }

  /** Displays changed: re-resolve every target (elements too — their display may be gone or back). */
  private async relayoutAll(): Promise<void> {
    const gen = ++this.relayoutGen;
    const lives = [...this.live.values()].filter((l) => !l.ended);
    const results = await Promise.all(
      lives.map(async (l) => [l, await Promise.all([...l.slots].map(async ([slot, t]) => [slot, await this.resolver.resolve(t)] as const))] as const),
    );
    if (gen !== this.relayoutGen) return; // a newer display change superseded this one
    for (const [l, rs] of results) {
      if (l.ended) continue;
      const lost: Slot[] = [];
      for (const [slot, r] of rs) {
        if (r.ok) l.resolved.set(slot, r.target);
        else if (l.resolved.get(slot)) lost.push(slot);
      }
      this.applyLostSlots(l, lost);
    }
    this.publish();
  }

  // ---------------------------------------------------------------- explainer async

  private loadExplainerAsync(l: ExplainerLive): void {
    const resolveOrNull = async (t: Parameters<TargetResolver["resolve"]>[0]) => {
      const r = await this.resolver.resolve(t);
      return r.ok ? r.target : null;
    };
    this.explainers.load(l.explainer, l.input.spec, {
      withHidden: (fn) => this.deps.sink.withHidden(fn),
      onUpdate: () => {
        if (l.ended) return;
        this.refresh(l);
        this.publish();
      },
      onImage: (panel, success) => {
        if (l.ended) return;
        this.emit({ type: success ? "explainer.image_ready" : "explainer.image_failed", overlayId: l.id, panel });
      },
      resolveCallouts: (targets) => Promise.all(targets.map(resolveOrNull)),
      resolveRegion: resolveOrNull,
    });
  }

  // ---------------------------------------------------------------- layout → render items

  private displays(): DisplayInfo[] {
    return (this.displayCache ??= this.deps.screen.getDisplays());
  }

  private displayOf(r: ResolvedTarget | null): DisplayInfo {
    const ds = this.displays();
    return (r && findDisplay(r.displayId, ds)) || findDisplay(this.deps.screen.getPrimaryDisplayId(), ds) || ds[0]!;
  }

  /** The target the annotation is about (ToolResult.resolvedBounds); none for an unanchored card. */
  private primaryBounds(l: Live): Rect | undefined {
    return kindOfLive(l).primary(l)?.bounds;
  }

  /**
   * Other annotations' drawings + everything they are about (every resolved slot: targets, step
   * controls, explainer anchors and anatomy regions, drag targets) + the avatar window.
   */
  private avoidFor(exceptId: string): Rect[] {
    const rects: Rect[] = [...(this.deps.avoidRects?.getAvoidRects() ?? [])];
    for (const l of this.live.values()) {
      if (l.id === exceptId || l.ended || !l.item) continue;
      for (const r of l.resolved.values()) if (r) rects.push(r.bounds);
      const it = l.item;
      if (it.kind === "explainer") rects.push(it.card);
      if ((it.kind === "highlight" || it.kind === "pointer") && it.label) rects.push(it.label.rect);
      if (it.kind === "parts") {
        for (const p of it.parts) if (p.label) rects.push(p.label.rect);
        if (it.title) rects.push(it.title.rect);
      }
      if (it.kind === "pointer") rects.push(pointerBody(it.rest, it.angle));
      if (it.kind === "steps") {
        for (const s of it.steps) {
          if (s.hint) rects.push(squareAt(s.hint, theme.stepHintSize));
          if (s.labelBox) rects.push(s.labelBox.rect);
        }
      }
    }
    return rects;
  }

  private placeLabel(
    l: Live,
    key: string,
    text: string | undefined,
    tone: Tone | undefined,
    around: Rect,
    display: DisplayInfo,
    avoid: Rect[],
    opts?: { prefer?: Placement; gap?: number },
  ): RenderLabel | null {
    if (!text) return null;
    const prefer = l.placements.get(key) ?? opts?.prefer;
    const res = placeBeside({
      target: around,
      size: measureLabel(text, tone !== undefined),
      workArea: display.workArea,
      avoid,
      allowShrink: false,
      ...(opts?.gap !== undefined ? { gap: opts.gap } : {}),
      ...(prefer ? { prefer } : {}),
    });
    l.placements.set(key, res.placement);
    return { text, rect: res.rect, ...(tone ? { tone } : {}), connector: res.placement === "corner" ? res.connector : null };
  }

  /**
   * Recompute an annotation's render item. A leaving annotation keeps its last geometry (it fades
   * exactly where it was), as does one whose target is gone.
   */
  private refresh(l: Live): void {
    if (l.ended && l.item) {
      l.item = { ...l.item, state: "exiting" } as RenderItem;
      return;
    }
    let avoid: Rect[] | null = null;
    const ctx: LayoutContext = {
      state: l.ended ? "exiting" : "visible",
      avoid: () => (avoid ??= this.avoidFor(l.id)),
      displayOf: (r) => this.displayOf(r),
      otherDisplayBounds: (d) => this.displays().filter((o) => o.id !== d.id).map((o) => o.bounds),
      placeLabel: (key, text, tone, around, display, rects, opts) => this.placeLabel(l, key, text, tone, around, display, rects, opts),
      previousSide: (key) => l.placements.get(key),
      rememberSide: (key, side) => void l.placements.set(key, side),
      explainerBody: (state) => this.explainers.body(state),
    };
    const item = kindOfLive(l).layout(l, ctx);
    if (item) l.item = item;
    else if (l.item) l.item = { ...l.item, state: ctx.state } as RenderItem;
  }

  private publish(): void {
    const items: RenderItem[] = [];
    for (const a of this.manager.all()) {
      if (a.state === "pending") continue;
      const item = this.live.get(a.id)?.item;
      if (item) items.push(item);
    }
    // Spotlight dims render underneath everything else, so pointers, labels and cards stay bright.
    const isSpotlight = (i: RenderItem) => i.kind === "highlight" && i.style === "spotlight";
    items.sort((a, b) => Number(isSpotlight(b)) - Number(isSpotlight(a)));
    this.deps.sink.publish(items, { reduceMotion: this.deps.reduceMotion?.() ?? theme.reduceMotion });
  }

  private emit(e: OverlayEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        // A listener failure must never break the overlay.
      }
    }
  }
}
