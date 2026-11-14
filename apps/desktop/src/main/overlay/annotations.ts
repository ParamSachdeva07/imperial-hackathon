/**
 * Per-tool behaviour of the four drawing tools, in one place each ("annotation kinds"):
 * which targets a call has (slots), which must resolve, which ones the drawing can't live without,
 * which target is its "primary" one, how a selection affects it, and how it is laid out.
 * OverlayService owns the shared lifecycle (resolve → manager rules → expiry/anchors → publish → exit)
 * and asks the kind for everything tool-specific — no tool-name branching elsewhere.
 */
import {
  COMPACT_IMAGE_SCALE,
  measureCard,
  theme,
  type DisplayInfo,
  type ExplainerBody,
  type HighlightInput,
  type ItemState,
  type PointAtInput,
  type Rect,
  type RenderItem,
  type RenderLabel,
  type RenderStep,
  type ShowExplainerInput,
  type ShowStepsInput,
  type Target,
  type Tone,
} from "@pointy/shared/overlay";
import type { TimerHandle } from "./clock";
import type { ExplainerState } from "./explainer/ExplainerService";
import { center } from "./geometry";
import { hintPlacement, placeCard, pointerPlacement } from "./LayoutEngine";
import { statusOf, type StepsState } from "./steps";
import type { ResolvedTarget } from "./TargetResolver";

// ------------------------------------------------------------------ live state

export type StepSlot = `step:${number}`;
/** A named target of a tool call. "region" is the anatomy crop region (avoided by the card, never required). */
export type Slot = "target" | "dragTo" | "anchor" | "region" | StepSlot;
export const stepSlot = (index: number): StepSlot => `step:${index}`;

interface LiveBase {
  id: string;
  slots: Map<Slot, Target>;
  resolved: Map<Slot, ResolvedTarget | null>;
  /** Element id → slots that use it. */
  elements: Map<string, Slot[]>;
  item: RenderItem | null;
  shown: boolean;
  exitTimer: TimerHandle | null;
  /** Pending "current step never appeared" check (step guides). */
  graceTimer: TimerHandle | null;
  /** Exiting or removed: ignore late async results. */
  ended: boolean;
}

/** Service-side state for one annotation, discriminated by tool. */
export type Live =
  | (LiveBase & { toolName: "highlight"; input: HighlightInput })
  | (LiveBase & { toolName: "point_at"; input: PointAtInput })
  | (LiveBase & { toolName: "show_steps"; input: ShowStepsInput; steps: StepsState })
  | (LiveBase & { toolName: "show_explainer"; input: ShowExplainerInput; explainer: ExplainerState });

export type DrawTool = Live["toolName"];
export type LiveOf<T extends DrawTool> = Extract<Live, { toolName: T }>;
export type InputOf<T extends DrawTool> = LiveOf<T>["input"];

/** What a kind needs from the service to lay itself out. */
export interface LayoutContext {
  state: ItemState;
  /** Other annotations' drawings + the avatar window (computed on first use). */
  avoid(): Rect[];
  displayOf(r: ResolvedTarget | null): DisplayInfo;
  otherDisplayBounds(display: DisplayInfo): Rect[];
  placeLabel(text: string | undefined, tone: Tone | undefined, around: Rect, display: DisplayInfo, avoid: Rect[]): RenderLabel | null;
  explainerBody(state: ExplainerState): ExplainerBody;
}

export interface AnnotationKind<T extends DrawTool> {
  /** Overlay id prefix ("hl_3"). */
  idPrefix: string;
  slots(input: InputOf<T>): Map<Slot, Target>;
  /** Slots that must resolve for the call to show anything (else visible:false + reason). */
  required(input: InputOf<T>, slot: Slot): boolean;
  /** Losing this (previously resolved) slot means the drawing can't stand → fade + target_lost. */
  critical(l: LiveOf<T>, slot: Slot): boolean;
  /** The target the annotation is "about" (ToolResult.resolvedBounds, manager bookkeeping). */
  primary(l: LiveOf<T>): ResolvedTarget | null;
  /** Keep watching elements that weren't found yet (later steps may appear). */
  watchUnresolved: boolean;
  /** Element ids registered for `on_target_selected` expiry. */
  selectionElementIds(l: LiveOf<T>): string[];
  /** The user selected one of its elements: report it, advance it (guides), or ignore it. */
  onSelected(l: LiveOf<T>, elementId: string): "emit" | "advance" | "ignore";
  /** The render item, or null to keep the previous geometry (target gone while fading). */
  layout(l: LiveOf<T>, ctx: LayoutContext): RenderItem | null;
}

const renderTarget = (r: ResolvedTarget | null | undefined) => (r ? { bounds: r.bounds, shape: r.shape } : null);
const elementSlots = (l: Live, elementId: string): Slot[] => l.elements.get(elementId) ?? [];

// ------------------------------------------------------------------ kinds

const highlight: AnnotationKind<"highlight"> = {
  idPrefix: "hl",
  slots: (input) => new Map<Slot, Target>([["target", input.target]]),
  required: (_input, slot) => slot === "target",
  critical: (_l, slot) => slot === "target",
  primary: (l) => l.resolved.get("target") ?? null,
  watchUnresolved: false,
  selectionElementIds: (l) => [...l.elements.keys()],
  onSelected: () => "emit",
  layout(l, ctx) {
    const r = l.resolved.get("target") ?? null;
    const t = renderTarget(r);
    if (!t) return null;
    return {
      kind: "highlight",
      id: l.id,
      state: ctx.state,
      style: l.input.style,
      tone: l.input.tone,
      target: t,
      label: ctx.placeLabel(l.input.label, l.input.tone, t.bounds, ctx.displayOf(r), ctx.avoid()),
    };
  },
};

const pointAt: AnnotationKind<"point_at"> = {
  idPrefix: "pt",
  slots(input) {
    const slots = new Map<Slot, Target>([["target", input.target]]);
    if (input.motion === "drag_to" && input.dragTo) slots.set("dragTo", input.dragTo);
    return slots;
  },
  required: (_input, slot) => slot === "target" || slot === "dragTo",
  critical: (_l, slot) => slot === "target" || slot === "dragTo",
  primary: (l) => l.resolved.get("target") ?? null,
  watchUnresolved: false,
  selectionElementIds: (l) => [...l.elements.keys()],
  onSelected: () => "emit",
  layout(l, ctx) {
    const r = l.resolved.get("target") ?? null;
    const t = renderTarget(r);
    if (!t) return null;
    const display = ctx.displayOf(r);
    const p = pointerPlacement(t.bounds, display.bounds, theme.pointerSize, ctx.otherDisplayBounds(display));
    const drag = l.input.motion === "drag_to" ? renderTarget(l.resolved.get("dragTo")) : null;
    return {
      kind: "pointer",
      id: l.id,
      state: ctx.state,
      motion: drag ? "drag_to" : l.input.motion === "drag_to" ? "tap" : l.input.motion,
      target: t,
      dragTo: drag,
      entry: p.entry,
      tap: p.tap,
      dragEnd: drag ? center(drag.bounds) : null,
      rest: p.rest,
      angle: p.angle,
      label: ctx.placeLabel(l.input.label, undefined, p.body, display, [...ctx.avoid(), t.bounds]),
    };
  },
};

const currentStepSlot = (l: LiveOf<"show_steps">): StepSlot | null => (l.steps.completed ? null : stepSlot(l.steps.current));

const steps: AnnotationKind<"show_steps"> = {
  idPrefix: "st",
  slots: (input) => new Map<Slot, Target>(input.steps.map((s, i) => [stepSlot(i), s.target])),
  required: (input, slot) => slot === stepSlot(Math.min(input.startAt, input.steps.length - 1)),
  // Losing a later step is fine (it may only appear once the current one is done).
  critical: (l, slot) => slot === currentStepSlot(l),
  primary: (l) => l.resolved.get(stepSlot(Math.min(l.steps.current, l.steps.total - 1))) ?? null,
  watchUnresolved: true,
  // A guide advances on selection; "on_target_selected" for a guide means "when completed".
  selectionElementIds: () => [],
  onSelected(l, elementId) {
    const current = currentStepSlot(l);
    return current && elementSlots(l, elementId).includes(current) ? "advance" : "ignore";
  },
  layout(l, ctx) {
    // One step at a time: a ring + "Step i of n · label" on the current control, a small faint
    // hint on the NEXT control, nothing for the others. Completed: "All done" on the last one.
    const { input, steps: st } = l;
    const n = input.steps.length;
    const focusIdx = st.completed ? n - 1 : st.current;
    const hintIdx = st.completed ? -1 : st.current + 1;
    const resolvedStep = (i: number) => l.resolved.get(stepSlot(i)) ?? null;
    const otherTargets = (idx: number) =>
      input.steps.flatMap((_, j) => {
        const o = j === idx ? null : resolvedStep(j);
        return o ? [o.bounds] : [];
      });
    const hintTarget = hintIdx >= 0 && hintIdx < n ? resolvedStep(hintIdx) : null;
    const hint = hintTarget ? hintPlacement(hintTarget.bounds, ctx.displayOf(hintTarget).workArea, theme.stepHintSize, otherTargets(hintIdx)) : null;
    const hintRect = hint ? squareAt(hint, theme.stepHintSize) : null;
    const rendered: RenderStep[] = input.steps.map((s, idx) => {
      const r = resolvedStep(idx);
      let labelBox: RenderLabel | null = null;
      if (r && idx === focusIdx) {
        const text = st.completed ? "All done" : `Step ${idx + 1} of ${n} · ${s.label}`;
        const tone: Tone = st.completed ? "success" : "info";
        // Never cover the guide's other controls or the next-step hint.
        const avoid = [...ctx.avoid(), ...otherTargets(idx), ...(hintRect ? [hintRect] : [])];
        labelBox = ctx.placeLabel(text, tone, r.bounds, ctx.displayOf(r), avoid);
      }
      return { index: idx, label: s.label, status: statusOf(st, idx), target: renderTarget(r), hint: idx === hintIdx ? hint : null, labelBox };
    });
    return { kind: "steps", id: l.id, state: ctx.state, current: st.current, completed: st.completed, steps: rendered };
  },
};

const hasImages = (spec: ShowExplainerInput["spec"]): boolean =>
  spec.kind === "concept" || spec.kind === "anatomy" || (spec.kind === "compare" && Boolean(spec.left.imagePrompt || spec.right.imagePrompt));

const explainer: AnnotationKind<"show_explainer"> = {
  idPrefix: "ex",
  slots(input) {
    const slots = new Map<Slot, Target>();
    if (input.anchor) slots.set("anchor", input.anchor);
    if (input.spec.kind === "anatomy") slots.set("region", input.spec.region);
    return slots;
  },
  // The anchor is optional: a card whose anchor isn't found is shown centred-right instead.
  required: () => false,
  // …but a card that WAS beside its anchor fades when that anchor goes away (spec §5.4).
  critical: (_l, slot) => slot === "anchor",
  primary: (l) => l.resolved.get("anchor") ?? null,
  watchUnresolved: false,
  selectionElementIds: (l) => [...l.elements.keys()],
  onSelected: () => "emit",
  layout(l, ctx) {
    const anchorResolved = l.resolved.get("anchor") ?? null;
    const region = l.resolved.get("region") ?? null;
    const display = ctx.displayOf(anchorResolved ?? region);
    const placed = placeCard({
      anchor: anchorResolved?.bounds ?? null,
      measure: (imageScale) => measureCard(l.input.title, l.input.spec, imageScale),
      hasImages: hasImages(l.input.spec),
      workArea: display.workArea,
      // Never cover the thing being explained: an anatomy card also avoids its crop region.
      avoid: region ? [...ctx.avoid(), region.bounds] : ctx.avoid(),
      compactImageScale: COMPACT_IMAGE_SCALE,
    });
    return {
      kind: "explainer",
      id: l.id,
      state: ctx.state,
      title: l.input.title,
      anchor: renderTarget(anchorResolved),
      designSize: placed.designSize,
      imageScale: placed.imageScale,
      scale: placed.scale,
      card: placed.rect,
      connector: placed.connector,
      body: ctx.explainerBody(l.explainer),
    };
  },
};

const KINDS: { [T in DrawTool]: AnnotationKind<T> } = {
  highlight,
  point_at: pointAt,
  show_steps: steps,
  show_explainer: explainer,
};

/** The kind for a tool (typed for its own Live/Input). */
export function kindOf<T extends DrawTool>(tool: T): AnnotationKind<T> {
  return KINDS[tool];
}

/** The kind for a live annotation (loosely typed: callers pass the matching Live). */
export function kindOfLive(l: Live): AnnotationKind<DrawTool> {
  return KINDS[l.toolName] as unknown as AnnotationKind<DrawTool>;
}

export const squareAt = (c: { x: number; y: number }, size: number): Rect => ({
  x: c.x - size / 2,
  y: c.y - size / 2,
  width: size,
  height: size,
});

/** Targets that go stale on a context change: placement slots plus anatomy callouts (a snapshot). */
export function contextTargets(tool: DrawTool, input: InputOf<DrawTool>, slots: Map<Slot, Target>): Target[] {
  const callouts = tool === "show_explainer" && (input as ShowExplainerInput).spec.kind === "anatomy"
    ? ((input as ShowExplainerInput).spec as Extract<ShowExplainerInput["spec"], { kind: "anatomy" }>).callouts.map((c) => c.target)
    : [];
  return [...slots.values(), ...callouts];
}
