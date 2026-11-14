/**
 * OverlayService (spec §5): the OverlayControl the session controller calls.
 * Validates tool input, resolves targets, applies the OverlayManager rules, lays out labels/cards,
 * tracks anchors and expiry, builds the render scene, and emits OverlayEvents.
 *
 * Electron-free: windows and displays come in through the SceneSink / ScreenSource ports.
 */
import {
  DEFAULT_EXPIRY,
  COMPACT_IMAGE_SCALE,
  measureCard,
  measureLabel,
  parseToolInput,
  theme,
  type AvoidRectsProvider,
  type BoundsProvider,
  type DisplayInfo,
  type ElementBounds,
  type Expiry,
  type ExplainerItem,
  type HighlightInput,
  type OverlayControl,
  type OverlayEvent,
  type PointAtInput,
  type Rect,
  type RenderItem,
  type RenderLabel,
  type RenderStep,
  type ScreenCaptureProvider,
  type ShowExplainerInput,
  type ShowStepsInput,
  type Size,
  type Target,
  type ToolResult,
  type Tone,
} from "@pointy/shared/overlay";
import { AnchorTracker } from "./AnchorTracker";
import { realClock, type Clock, type TimerHandle } from "./clock";
import { displayForRect, findDisplay } from "./coords";
import { ExpiryManager, type ExpireCause } from "./ExpiryManager";
import { ExplainerService, type ExplainerState } from "./explainer/ExplainerService";
import type { ImageSource } from "./explainer/falClient";
import { center, union } from "./geometry";
import { badgePlacement, placeBeside, placeCentredRight, pointerPlacement } from "./LayoutEngine";
import { OverlayManager, type Dismissal } from "./OverlayManager";
import type { SceneSink, ScreenSource } from "./ports";
import { advanceSteps, startSteps, statusOf, type StepsState } from "./steps";
import { isCoordinateOnly, TargetResolver, type ResolvedTarget } from "./TargetResolver";

export interface OverlayServiceDeps {
  boundsProvider: BoundsProvider;
  captureProvider: ScreenCaptureProvider;
  screen: ScreenSource;
  sink: SceneSink;
  avoidRects?: AvoidRectsProvider;
  imageSource?: ImageSource;
  clock?: Clock;
  reduceMotion?: () => boolean;
  /** Anchor polling interval (spec: ~300 ms). */
  anchorIntervalMs?: number;
  /** How long a completed step guide stays (all ✓) before fading. */
  stepsCompletedHoldMs?: number;
  /** Hide overlay windows during anatomy capture (when content protection doesn't exclude them). */
  hideDuringCapture?: boolean;
}

/** Placement slots + "region" (anatomy crop region: avoided by the card, never required). */
type Slot = "target" | "dragTo" | "anchor" | "region" | `step:${number}`;

/** Service-side state for one annotation. */
interface Live {
  id: string;
  toolName: "point_at" | "highlight" | "show_steps" | "show_explainer";
  input: PointAtInput | HighlightInput | ShowStepsInput | ShowExplainerInput;
  slots: Map<Slot, Target>;
  resolved: Map<Slot, ResolvedTarget | null>;
  /** Element id → slots that use it. */
  elements: Map<string, Slot[]>;
  item: RenderItem | null;
  steps?: StepsState;
  explainer?: ExplainerState;
  shownAt: number | null;
  createdAt: number;
  exitTimer: TimerHandle | null;
  /** Pending "current step never appeared" check. */
  graceTimer: TimerHandle | null;
  /** Ended (exiting or removed): ignore late async results. */
  ended: boolean;
}

const EXIT_MARGIN_MS = 50;

type Caller = "user" | "model" | "controller";
type ResolveFailureReason = "target_not_found" | "target_offscreen" | "display_not_found";

/** How long a step that isn't on screen yet may take to appear after the guide advances to it. */
const STEP_APPEAR_GRACE_MS = 2000;

/** The resting pointer's body: a pointerSize square behind the tip, opposite the pointing direction. */
function pointerBodyRect(rest: { x: number; y: number }, angle: number): Rect {
  const size = theme.pointerSize;
  const rad = (angle * Math.PI) / 180;
  const cx = rest.x - (Math.cos(rad) * size) / 2;
  const cy = rest.y - (Math.sin(rad) * size) / 2;
  return { x: cx - size / 2, y: cy - size / 2, width: size, height: size };
}

const hasImages = (spec: ShowExplainerInput["spec"]): boolean =>
  spec.kind === "concept" || spec.kind === "anatomy" || (spec.kind === "compare" && Boolean(spec.left.imagePrompt || spec.right.imagePrompt));

const lastStepElement = (input: ShowStepsInput): string[] => {
  const last = input.steps[input.steps.length - 1]?.target;
  return last?.kind === "element" ? [last.elementId] : [];
};
export interface ToolCallOptions {
  caller?: Caller;
}

const ok = (overlayId: string, bounds: Rect | undefined, extra: Partial<ToolResult> = {}): ToolResult => ({
  ok: true,
  overlayId,
  visible: true,
  ...(bounds ? { resolvedBounds: bounds } : {}),
  ...extra,
});

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
  /** Bumped by clear("all") and new turns: tool calls still resolving targets are then dropped. */
  private epoch = 0;
  /** Bumped on context change: calls with coordinate targets still resolving are then stale. */
  private contextEpoch = 0;

  constructor(private readonly deps: OverlayServiceDeps) {
    this.clock = deps.clock ?? realClock;
    this.manager = new OverlayManager({ now: () => this.clock.now() });
    this.resolver = new TargetResolver({ boundsProvider: deps.boundsProvider, getDisplays: () => this.displays() });
    this.expiry = new ExpiryManager({ clock: this.clock, onExpire: (id, cause) => this.handleExpire(id, cause) });
    this.anchors = new AnchorTracker({
      boundsProvider: deps.boundsProvider,
      clock: this.clock,
      intervalMs: deps.anchorIntervalMs ?? 300,
      onMoved: (id, el, b) => this.handleAnchorMoved(id, el, b),
      onLost: (id, el) => this.handleAnchorLost(id, el),
    });
    this.explainers = new ExplainerService({
      captureProvider: deps.captureProvider,
      ...(deps.imageSource ? { imageSource: deps.imageSource } : {}),
      getDisplays: () => this.displays(),
      hideDuringCapture: deps.hideDuringCapture ?? false,
    });
    this.anchors.start();
    this.disposers.push(deps.sink.onPainted((ids) => this.handlePainted(ids)));
    this.disposers.push(deps.screen.onDisplaysChanged(() => void this.relayoutAll()));
  }

  dispose(): void {
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

  /**
   * @param opts.caller who issued the call (default "model"): reported as `by` on
   *   overlay.dismissed for `clear` (e.g. the controller's clear("all") on stop/cancel).
   */
  async handleTool(name: string, input: unknown, opts: ToolCallOptions = {}): Promise<ToolResult> {
    const parsed = parseToolInput(name, input);
    if (!parsed.success) return { ok: false, visible: false, reason: "invalid_input" };
    switch (parsed.name) {
      case "clear":
        return this.clear((parsed.data as { overlayId: string }).overlayId, opts.caller ?? "model");
      case "advance_step":
        return this.advance((parsed.data as { stepsId: string }).stepsId);
      case "highlight":
      case "point_at":
      case "show_steps":
      case "show_explainer":
        return this.show(parsed.name, parsed.data as Live["input"]);
      default:
        // Stretch tools are not enabled yet.
        return { ok: false, visible: false, reason: "invalid_input" };
    }
  }

  onTurnStart(turnId: string): void {
    this.epoch += 1;
    this.expiry.onTurnStart(turnId);
    for (const id of this.manager.endTurn()) this.endLive(id);
  }

  onContextChange(): void {
    this.contextEpoch += 1;
    this.expiry.onContextChange();
  }

  onTargetSelected(elementId: string): void {
    for (const l of [...this.live.values()]) {
      if (l.ended || !l.elements.has(elementId)) continue;
      if (l.steps) {
        // A guide is only "selected" through its current step (which also advances it).
        const current = l.steps.completed ? undefined : l.slots.get(`step:${l.steps.current}`);
        if (current?.kind !== "element" || current.elementId !== elementId) continue;
        this.emit({ type: "overlay.target_selected", overlayId: l.id });
        this.advance(l.id);
        continue;
      }
      this.emit({ type: "overlay.target_selected", overlayId: l.id });
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

  /** Dev/debug: the data URL of an explainer's anatomy crop (or null), to verify capture exclusion. */
  debugAnatomyImage(id: string): string | null {
    const item = this.live.get(id)?.item;
    if (item?.kind !== "explainer" || item.body.kind !== "anatomy" || item.body.image.status !== "ready") return null;
    return item.body.image.src;
  }

  /** Debug snapshot (dev server). */
  debugState() {
    return [...this.live.values()].map((l) => ({
      id: l.id,
      tool: l.toolName,
      state: this.manager.get(l.id)?.state ?? "removed",
      bounds: this.primaryBounds(l) ?? null,
      steps: l.steps ?? null,
    }));
  }

  // ---------------------------------------------------------------- show

  private async show(toolName: Live["toolName"], input: Live["input"]): Promise<ToolResult> {
    const slots = this.slotsFor(toolName, input);
    const resolved = new Map<Slot, ResolvedTarget | null>();
    const failures = new Map<Slot, ResolveFailureReason>();
    const epoch = this.epoch;
    const contextEpoch = this.contextEpoch;
    const results = await Promise.all([...slots].map(async ([slot, t]) => [slot, await this.resolver.resolve(t)] as const));
    // clear("all") or a new turn arrived while we were resolving: this call is stale.
    if (epoch !== this.epoch) return { ok: false, visible: false, reason: "replaced" };
    // A context change mid-resolution makes coordinate targets stale (spec §5.4).
    if (contextEpoch !== this.contextEpoch && [...slots.values()].some(isCoordinateOnly)) {
      return { ok: false, visible: false, reason: "replaced" };
    }
    for (const [slot, r] of results) {
      if (r.ok) {
        resolved.set(slot, r.target);
      } else {
        resolved.set(slot, null);
        failures.set(slot, r.reason);
        if (this.isRequired(toolName, slot, input)) return { ok: true, visible: false, reason: r.reason };
      }
    }

    const prefix = { highlight: "hl", point_at: "pt", show_steps: "st", show_explainer: "ex" }[toolName];
    const id = this.manager.nextId(prefix);
    const elements = new Map<string, Slot[]>();
    for (const [slot, target] of slots) {
      if (target.kind !== "element") continue;
      elements.set(target.elementId, [...(elements.get(target.elementId) ?? []), slot]);
    }
    const l: Live = {
      id,
      toolName,
      input,
      slots,
      resolved,
      elements,
      item: null,
      shownAt: null,
      createdAt: this.clock.now(),
      exitTimer: null,
      graceTimer: null,
      ended: false,
    };
    if (toolName === "show_steps") {
      const si = input as ShowStepsInput;
      l.steps = startSteps(si.steps.length, si.startAt);
    }
    if (toolName === "show_explainer") {
      l.explainer = this.explainers.create((input as ShowExplainerInput).spec);
    }

    const { dismissed } = this.manager.add({
      id,
      toolName,
      input,
      resolvedBounds: this.primaryBounds(l) ?? null,
      displayId: this.primaryResolved(l)?.displayId ?? null,
      turnId: (input as { turnId?: string }).turnId,
    });
    this.live.set(id, l);
    this.handleDismissals(dismissed);

    this.layout(l);
    this.expiry.track({
      id,
      expires: this.expiryFor(toolName, input),
      // Step guides advance on selection instead of expiring on it.
      // A step guide "selected" means its LAST step was selected (earlier selections advance it).
      elementIds: toolName === "show_steps" ? lastStepElement(input as ShowStepsInput) : [...elements.keys()],
      // Any coordinate target goes stale on a context change (spec §5.4), even next to element targets.
      // (includes an anatomy region: its crop and callouts are a snapshot of that context)
      coordinateOnly: [...slots.values()].some(isCoordinateOnly),
    });
    if (elements.size) {
      const initial = new Map<string, ElementBounds>();
      for (const [el, ss] of elements) {
        const r = resolved.get(ss[0]!);
        if (r) initial.set(el, { rect: r.bounds, displayId: r.displayId });
      }
      // Step guides also watch elements that aren't on screen yet (later steps may appear). Other
      // annotations only follow what they actually attached to: an explainer shown unanchored
      // (anchor not found) must not later fade because that anchor "was lost".
      const tracked = toolName === "show_steps" ? [...elements.keys()] : [...initial.keys()];
      if (tracked.length) this.anchors.track(id, tracked, initial);
    }
    this.publish();

    if (l.explainer) this.loadExplainerAsync(l);

    // A card whose anchor can't be resolved is still shown (centred-right); report why it's unanchored.
    const anchorFailure = toolName === "show_explainer" ? failures.get("anchor") : undefined;
    return ok(id, this.primaryBounds(l), anchorFailure ? { reason: anchorFailure } : {});
  }

  private slotsFor(toolName: Live["toolName"], input: Live["input"]): Map<Slot, Target> {
    const slots = new Map<Slot, Target>();
    if (toolName === "highlight" || toolName === "point_at") {
      const i = input as HighlightInput | PointAtInput;
      slots.set("target", i.target);
      if (toolName === "point_at") {
        const p = input as PointAtInput;
        if (p.motion === "drag_to" && p.dragTo) slots.set("dragTo", p.dragTo);
      }
    } else if (toolName === "show_steps") {
      (input as ShowStepsInput).steps.forEach((s, i) => slots.set(`step:${i}`, s.target));
    } else {
      const e = input as ShowExplainerInput;
      if (e.anchor) slots.set("anchor", e.anchor);
      if (e.spec.kind === "anatomy") slots.set("region", e.spec.region);
    }
    return slots;
  }

  /** Slots that must resolve for the tool call to show anything. */
  private isRequired(toolName: Live["toolName"], slot: Slot, input: Live["input"]): boolean {
    if (toolName === "highlight" || toolName === "point_at") return slot === "target" || slot === "dragTo";
    if (toolName === "show_steps") {
      const s = input as ShowStepsInput;
      const start = Math.min(s.startAt, s.steps.length - 1);
      return slot === `step:${start}`;
    }
    return false; // explainer: anchor optional (card falls back to centred-right)
  }

  private expiryFor(toolName: Live["toolName"], input: Live["input"]): Expiry {
    const given = (input as { expires?: Expiry }).expires;
    if (given) return given;
    // A step guide spans several turns (advance_step comes in a later turn), so by default it
    // lasts until it is completed or cleared.
    return toolName === "show_steps" ? "manual" : DEFAULT_EXPIRY;
  }

  // ---------------------------------------------------------------- clear / steps

  private clear(overlayId: string, by: Caller): ToolResult {
    if (overlayId === "all") {
      this.epoch += 1;
      for (const l of [...this.live.values()]) if (!l.ended) this.dismiss(l.id, by, "cleared");
      return { ok: true, visible: false };
    }
    const l = this.live.get(overlayId);
    if (!l || l.ended) return { ok: false, visible: false, reason: "unknown_overlay" };
    this.dismiss(overlayId, by, "cleared");
    return { ok: true, overlayId, visible: false };
  }

  private advance(stepsId: string): ToolResult {
    const l = this.live.get(stepsId);
    if (!l || l.ended || !l.steps) return { ok: false, visible: false, reason: "unknown_overlay" };
    if (l.steps.completed) return ok(stepsId, this.primaryBounds(l));
    l.steps = advanceSteps(l.steps);
    if (l.steps.completed) {
      this.emit({ type: "steps.completed", stepsId });
      this.layout(l);
      this.publish();
      // Show all ✓ briefly, then end — unless the caller explicitly asked for a manual or timed lifetime.
      const explicit = (l.input as ShowStepsInput).expires;
      if (explicit !== "manual" && typeof explicit !== "object") {
        const hold = this.deps.stepsCompletedHoldMs ?? 1200;
        this.expiry.untrack(stepsId);
        this.expiry.track({ id: stepsId, expires: { ms: Math.max(500, hold) }, elementIds: [], coordinateOnly: false });
      }
      return ok(stepsId, this.primaryBounds(l), { visible: true });
    }
    this.emit({ type: "steps.advanced", stepsId, index: l.steps.current });
    this.layout(l);
    this.publish();
    this.checkCurrentStepAppears(l);
    return ok(stepsId, this.primaryBounds(l), { visible: !!l.resolved.get(`step:${l.steps.current}`) });
  }

  /**
   * After advancing to a step whose element isn't on screen yet (it may appear once the previous
   * step is done), give it a grace period; if it still hasn't appeared, the guide is lost.
   */
  private checkCurrentStepAppears(l: Live): void {
    if (!l.steps || l.steps.completed || l.resolved.get(`step:${l.steps.current}`)) return;
    const index = l.steps.current;
    if (l.graceTimer) this.clock.clearTimeout(l.graceTimer);
    l.graceTimer = this.clock.setTimeout(() => {
      l.graceTimer = null;
      if (l.ended || !l.steps || l.steps.current !== index || l.resolved.get(`step:${index}`)) return;
      this.emit({ type: "overlay.target_lost", overlayId: l.id });
      this.fadeOut(l.id);
    }, STEP_APPEAR_GRACE_MS);
  }

  // ---------------------------------------------------------------- lifecycle

  private handleDismissals(dismissed: Dismissal[]): void {
    for (const d of dismissed) {
      this.emit({ type: "overlay.dismissed", overlayId: d.id, by: "model", reason: d.reason });
      this.beginExit(d.id);
    }
  }

  private dismiss(id: string, by: "user" | "model" | "controller", reason: "cleared"): void {
    if (!this.manager.beginExit(id)) return;
    this.emit({ type: "overlay.dismissed", overlayId: id, by, reason });
    this.afterExitStarted(id);
  }

  /** The manager already moved it to "exiting" (replaced/evicted). */
  private beginExit(id: string): void {
    this.afterExitStarted(id);
  }

  private afterExitStarted(id: string): void {
    const l = this.live.get(id);
    this.expiry.untrack(id);
    this.anchors.untrack(id);
    if (!l) return;
    l.ended = true;
    this.refreshItem(l);
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

  private fadeOut(id: string): void {
    if (this.manager.beginExit(id)) this.afterExitStarted(id);
  }

  private handleExpire(id: string, _cause: ExpireCause): void {
    if (!this.live.has(id)) return;
    this.emit({ type: "overlay.expired", overlayId: id });
    this.fadeOut(id);
  }

  private handlePainted(ids: string[]): void {
    for (const id of ids) {
      const l = this.live.get(id);
      if (!l || l.shownAt !== null || l.ended) continue;
      l.shownAt = this.clock.now();
      this.emit({ type: "overlay.shown", overlayId: id });
    }
  }

  private handleAnchorMoved(id: string, elementId: string, bounds: ElementBounds): void {
    const l = this.live.get(id);
    if (!l || l.ended) return;
    // Same rules as TargetResolver: the display is the one containing the element; an element
    // moved fully off every display counts as lost.
    const display = displayForRect(bounds.rect, this.displays());
    if (!display) return this.handleAnchorLost(id, elementId);
    for (const slot of l.elements.get(elementId) ?? []) {
      l.resolved.set(slot, { bounds: bounds.rect, displayId: display.id, shape: { kind: "rect" }, elementId });
    }
    this.manager.update(id, { resolvedBounds: this.primaryBounds(l) ?? null, displayId: this.primaryResolved(l)?.displayId ?? null });
    this.layout(l);
    this.publish();
  }

  private handleAnchorLost(id: string, elementId: string): void {
    const l = this.live.get(id);
    if (!l || l.ended) return;
    const slots = l.elements.get(elementId) ?? [];
    // Steps survive the loss of a non-current step (it may only appear later).
    const critical =
      l.steps !== undefined
        ? !l.steps.completed && slots.includes(`step:${l.steps.current}`)
        : slots.some((s) => s === "target" || s === "dragTo" || s === "anchor");
    if (critical) {
      // Keep the last geometry so the whole annotation fades out together (spec §5.4).
      this.emit({ type: "overlay.target_lost", overlayId: id });
      this.fadeOut(id);
    } else {
      for (const s of slots) l.resolved.set(s, null);
      this.layout(l);
      this.publish();
    }
  }

  private async relayoutAll(): Promise<void> {
    for (const l of this.live.values()) {
      if (l.ended) continue;
      for (const [slot, target] of l.slots) {
        if (target.kind === "element") {
          // Element bounds may be unchanged while their display went away: re-check the display.
          const cur = l.resolved.get(slot);
          if (!cur) continue;
          const d = displayForRect(cur.bounds, this.displays());
          l.resolved.set(slot, d ? { ...cur, displayId: d.id } : null);
          continue;
        }
        const r = await this.resolver.resolve(target);
        l.resolved.set(slot, r.ok ? r.target : null);
      }
      const primary = this.primaryResolved(l);
      if (!primary && l.toolName !== "show_explainer") {
        this.emit({ type: "overlay.target_lost", overlayId: l.id });
        this.fadeOut(l.id);
        continue;
      }
      this.layout(l);
    }
    this.publish();
  }

  // ---------------------------------------------------------------- explainer async

  private loadExplainerAsync(l: Live): void {
    const input = l.input as ShowExplainerInput;
    this.explainers.load(l.explainer!, input.spec, {
      withHidden: (fn) => this.deps.sink.withHidden(fn),
      onUpdate: () => {
        if (l.ended) return;
        this.refreshItem(l);
        this.publish();
      },
      onImage: (panel, ok) => {
        if (l.ended) return;
        this.emit({ type: ok ? "explainer.image_ready" : "explainer.image_failed", overlayId: l.id, panel });
      },
      resolveCallouts: async (targets) => Promise.all(targets.map(async (t) => {
        const r = await this.resolver.resolve(t);
        return r.ok ? r.target : null;
      })),
      resolveRegion: async (t) => {
        const r = await this.resolver.resolve(t);
        return r.ok ? r.target : null;
      },
    });
  }

  // ---------------------------------------------------------------- layout → render items

  private displays(): DisplayInfo[] {
    return this.deps.screen.getDisplays();
  }

  private displayOf(r: ResolvedTarget | null | undefined): DisplayInfo {
    const ds = this.displays();
    return (r && findDisplay(r.displayId, ds)) || findDisplay(this.deps.screen.getPrimaryDisplayId(), ds) || ds[0]!;
  }

  private primaryResolved(l: Live): ResolvedTarget | null {
    if (l.steps) {
      const idx = Math.min(l.steps.current, l.steps.total - 1);
      return l.resolved.get(`step:${idx}`) ?? null;
    }
    return l.resolved.get(l.toolName === "show_explainer" ? "anchor" : "target") ?? null;
  }

  private primaryBounds(l: Live): Rect | undefined {
    if (l.toolName === "show_explainer" && l.item?.kind === "explainer") return l.item.anchor?.bounds ?? l.item.card;
    return this.primaryResolved(l)?.bounds;
  }

  /** Rects of other visible annotations' drawings + the avatar, for placement avoidance. */
  private avoidFor(exceptId: string): Rect[] {
    const rects: Rect[] = [...(this.deps.avoidRects?.getAvoidRects() ?? [])];
    for (const l of this.live.values()) {
      if (l.id === exceptId || l.ended || !l.item) continue;
      const it = l.item;
      if (it.kind === "explainer") rects.push(it.card);
      if ((it.kind === "highlight" || it.kind === "pointer") && it.label) rects.push(it.label.rect);
      if (it.kind === "highlight" || it.kind === "pointer") rects.push(it.target.bounds);
      if (it.kind === "pointer") rects.push(pointerBodyRect(it.rest, it.angle));
      if (it.kind === "steps") {
        const half = theme.stepBadgeSize / 2;
        for (const s of it.steps) {
          if (s.target) rects.push(s.target.bounds);
          if (s.badge) rects.push({ x: s.badge.x - half, y: s.badge.y - half, width: theme.stepBadgeSize, height: theme.stepBadgeSize });
          if (s.labelBox) rects.push(s.labelBox.rect);
        }
      }
    }
    return rects;
  }

  private placeLabel(text: string | undefined, tone: Tone | undefined, around: Rect, display: DisplayInfo, avoid: Rect[]): RenderLabel | null {
    if (!text) return null;
    const size = measureLabel(text, tone !== undefined);
    const res = placeBeside({ target: around, size, workArea: display.workArea, avoid, allowShrink: false });
    return {
      text,
      rect: res.rect,
      ...(tone ? { tone } : {}),
      connector: res.placement === "corner" ? res.connector : null,
    };
  }

  private layout(l: Live): void {
    this.refreshItem(l);
  }

  private refreshItem(l: Live): void {
    const state = l.ended ? "exiting" : "visible";
    const avoid = this.avoidFor(l.id);
    const target = (slot: Slot) => {
      const r = l.resolved.get(slot);
      return r ? { bounds: r.bounds, shape: r.shape } : null;
    };

    if (l.toolName === "highlight") {
      const i = l.input as HighlightInput;
      const t = target("target");
      if (!t) return this.keepGeometry(l, state);
      const display = this.displayOf(l.resolved.get("target"));
      l.item = {
        kind: "highlight",
        id: l.id,
        state,
        style: i.style,
        tone: i.tone,
        target: t,
        label: this.placeLabel(i.label, i.tone, t.bounds, display, avoid),
      };
      return;
    }

    if (l.toolName === "point_at") {
      const i = l.input as PointAtInput;
      const t = target("target");
      if (!t) return this.keepGeometry(l, state);
      const display = this.displayOf(l.resolved.get("target"));
      const others = this.displays().filter((d) => d.id !== display.id).map((d) => d.bounds);
      const p = pointerPlacement(t.bounds, display.bounds, theme.pointerSize, others);
      const drag = i.motion === "drag_to" ? target("dragTo") : null;
      l.item = {
        kind: "pointer",
        id: l.id,
        state,
        motion: drag ? "drag_to" : i.motion === "drag_to" ? "tap" : i.motion,
        target: t,
        dragTo: drag,
        entry: p.entry,
        tap: p.tap,
        dragEnd: drag ? center(drag.bounds) : null,
        rest: p.rest,
        angle: p.angle,
        label: this.placeLabel(i.label, undefined, p.body, display, [...avoid, t.bounds]),
      };
      return;
    }

    if (l.toolName === "show_steps" && l.steps) {
      const i = l.input as ShowStepsInput;
      const steps: RenderStep[] = i.steps.map((s, idx) => {
        const r = l.resolved.get(`step:${idx}`) ?? null;
        const status = statusOf(l.steps!, idx);
        if (!r) return { index: idx, label: s.label, status, target: null, badge: null, labelBox: null };
        const display = this.displayOf(r);
        const badge = badgePlacement(r.bounds, display.workArea, theme.stepBadgeSize);
        const half = theme.stepBadgeSize / 2;
        const badgeRect = { x: badge.x - half, y: badge.y - half, width: theme.stepBadgeSize, height: theme.stepBadgeSize };
        // The current step's label must not cover the guide's other steps either.
        const ownOthers = i.steps.flatMap((_, j) => {
          const o = j === idx ? null : l.resolved.get(`step:${j}`);
          return o ? [o.bounds] : [];
        });
        const labelBox =
          status === "current"
            ? this.placeLabel(s.label, undefined, union(r.bounds, badgeRect), display, [...avoid, ...ownOthers])
            : null;
        return { index: idx, label: s.label, status, target: { bounds: r.bounds, shape: r.shape }, badge, labelBox };
      });
      l.item = { kind: "steps", id: l.id, state, current: l.steps.current, completed: l.steps.completed, steps };
      return;
    }

    if (l.toolName === "show_explainer" && l.explainer) {
      const i = l.input as ShowExplainerInput;
      const anchorResolved = l.resolved.get("anchor") ?? null;
      const region = l.resolved.get("region") ?? null;
      const designSize = measureCard(i.title, i.spec);
      const display = this.displayOf(anchorResolved ?? region);
      // Never cover the thing being explained: an anatomy card also avoids its crop region.
      const cardAvoid = region ? [...avoid, region.bounds] : avoid;
      const anchor = anchorResolved ? { bounds: anchorResolved.bounds, shape: anchorResolved.shape } : null;
      const prev = l.item?.kind === "explainer" ? l.item : null;
      const place = (size: Size) => {
        if (anchor) {
          const res = placeBeside({ target: anchor.bounds, size, workArea: display.workArea, avoid: cardAvoid });
          return { rect: res.rect, scale: res.scale, connector: res.connector as ExplainerItem["connector"] };
        }
        const res = placeCentredRight(size, display.workArea, cardAvoid);
        return { rect: res.rect, scale: res.scale, connector: null };
      };
      let placement: { rect: Rect; scale: number; connector: ExplainerItem["connector"] };
      let imageScale = 1;
      let size = designSize;
      if (prev && l.ended) {
        placement = { rect: prev.card, scale: prev.scale, connector: prev.connector };
        imageScale = prev.imageScale;
        size = prev.designSize;
      } else {
        placement = place(designSize);
        // Reflow before shrinking text: retry with smaller pictures at full text size (fontMin).
        if (placement.scale < 1 && hasImages(i.spec)) {
          const compact = measureCard(i.title, i.spec, COMPACT_IMAGE_SCALE);
          const retry = place(compact);
          if (retry.scale >= placement.scale) {
            placement = retry;
            imageScale = COMPACT_IMAGE_SCALE;
            size = compact;
          }
        }
        // Still shrunk? Text must stay ≥ fontMin for older eyes: a full-size card in a corner (with a
        // connector to its anchor) beats a smaller card beside it.
        if (placement.scale < 1 && anchor) {
          const full = placeBeside({ target: anchor.bounds, size, workArea: display.workArea, avoid: cardAvoid, allowShrink: false });
          if (full.scale === 1) placement = { rect: full.rect, scale: 1, connector: full.connector };
        }
      }
      l.item = {
        kind: "explainer",
        id: l.id,
        state,
        title: i.title,
        anchor,
        designSize: size,
        imageScale,
        scale: placement.scale,
        card: placement.rect,
        connector: placement.connector,
        body: this.explainers.body(l.explainer),
      };
    }
  }

  /** Target gone but still fading: keep the last geometry, just update state. */
  private keepGeometry(l: Live, state: "visible" | "exiting"): void {
    if (l.item) l.item = { ...l.item, state } as RenderItem;
  }

  private publish(): void {
    const items: RenderItem[] = [];
    for (const a of this.manager.all()) {
      if (a.state === "pending") continue;
      const l = this.live.get(a.id);
      if (!l?.item) continue;
      items.push(l.item);
    }
    // Spotlight dims render underneath everything else, so pointers, labels and cards stay bright.
    const isSpotlight = (i: RenderItem) => i.kind === "highlight" && i.style === "spotlight";
    items.sort((a, b) => Number(isSpotlight(b)) - Number(isSpotlight(a)));
    const reduceMotion = this.deps.reduceMotion?.() ?? theme.reduceMotion;
    this.deps.sink.publish(items, { reduceMotion });
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
