/**
 * INTERNAL contract between the overlay main process and the overlay renderer windows.
 * (Not part of the team contract; free to evolve.)
 *
 * Main resolves targets, runs layout and sends one RenderScene per display window over IPC.
 * Every geometric value in a RenderItem is in **global DIP**. The renderer translates by
 * `-scene.display.bounds.{x,y}` so items that span displays (spotlight dim, step paths) clip
 * naturally in each window.
 *
 * Lifecycle: an item appears in the scene with `state: "visible"` (renderer plays the entry
 * animation on mount), changes geometry in place (renderer animates over theme.anim.moveMs),
 * switches to `state: "exiting"` (renderer fades out over theme.anim.exitMs), then main drops it.
 */
import type { IconName, Point, Rect, Tone } from "./schemas";

export interface Size {
  width: number;
  height: number;
}

export type TargetShape =
  | { kind: "rect" }
  | { kind: "point"; point: Point }
  | { kind: "polygon"; points: Point[] };

/** A resolved target: layout bounds plus the true shape for drawing (polygon path, point). */
export interface RenderTarget {
  bounds: Rect;
  shape: TargetShape;
}

export interface Segment {
  from: Point;
  to: Point;
}

/** A caption box placed by the LayoutEngine. */
export interface RenderLabel {
  text: string;
  rect: Rect;
  /** Tone glyph shown before the text (colour is never the only signal). */
  tone?: Tone;
  /** Drawn only when the label had to fall back to a corner. */
  connector: Segment | null;
}

export type ItemState = "visible" | "exiting";

interface ItemBase {
  id: string;
  state: ItemState;
}

export interface HighlightItem extends ItemBase {
  kind: "highlight";
  style: "ring" | "spotlight" | "underline";
  tone: Tone;
  target: RenderTarget;
  label: RenderLabel | null;
}

export interface PointerItem extends ItemBase {
  kind: "pointer";
  motion: "tap" | "double_tap" | "drag_to";
  target: RenderTarget;
  dragTo: RenderTarget | null;
  /** Where the pointer tip starts (just outside the nearest display edge). */
  entry: Point;
  /** Tip position while tapping (target centre). */
  tap: Point;
  /** Tip position at the end of a drag (dragTo centre); only for `drag_to`. */
  dragEnd: Point | null;
  /** Tip position while resting beside the target (just outside its edge). */
  rest: Point;
  /**
   * Direction the pointer points, in degrees, measured clockwise from "pointing right" (screen
   * coordinates). The pointer body extends away from the tip in the opposite direction.
   */
  angle: number;
  label: RenderLabel | null;
}

export type StepStatus = "past" | "current" | "future";

export interface RenderStep {
  index: number;
  label: string;
  status: StepStatus;
  /** null while the step's element is not found (e.g. it only appears after the previous step). */
  target: RenderTarget | null;
  /**
   * Centre of the small faint "next step" hint (global DIP). Only the step right after the current
   * one has it (one step at a time); null for every other step.
   */
  badge: Point | null;
  /**
   * The step label ("Step i of n · …", tone info) — only on the current step; when the guide is
   * completed, "All done" (tone success) on the last step.
   */
  labelBox: RenderLabel | null;
}

export interface StepsItem extends ItemBase {
  kind: "steps";
  current: number;
  completed: boolean;
  steps: RenderStep[];
}

export type ImageSlot =
  | { status: "loading"; fallbackIcon: IconName }
  | { status: "ready"; src: string; /** shown if the image fails to decode */ fallbackIcon?: IconName }
  | { status: "failed"; fallbackIcon: IconName };

export interface CompareSideBody {
  title: string;
  points: string[];
  image: ImageSlot | null;
}

export interface AnatomyCallout {
  n: number;
  label: string;
  /** Callout bounds normalised to the crop image (0..1). */
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  /** False when the callout target lies outside the cropped region (legend only, no dot). */
  inside: boolean;
}

export type ExplainerBody =
  | { kind: "sequence"; steps: { icon: IconName; caption: string }[] }
  | { kind: "compare"; left: CompareSideBody; right: CompareSideBody }
  | {
      kind: "anatomy";
      image: ImageSlot;
      /** Crop width / height, so the panel can be sized before the image arrives. */
      aspect: number;
      callouts: AnatomyCallout[];
    }
  | { kind: "concept"; panels: { caption: string; image: ImageSlot }[] };

export interface ExplainerItem extends ItemBase {
  kind: "explainer";
  title: string;
  anchor: RenderTarget | null;
  /** Card content is laid out at this size... */
  designSize: Size;
  /** Image heights relative to normal (1, or COMPACT_IMAGE_SCALE when re-laid out to fit at full text size). */
  imageScale: number;
  /** ...then scaled by `scale` (1, or 0.8 when the LayoutEngine had to shrink it)... */
  scale: number;
  /** ...to occupy this on-screen rect (global DIP). */
  card: Rect;
  connector: Segment | null;
  body: ExplainerBody;
}

export type RenderItem = HighlightItem | PointerItem | StepsItem | ExplainerItem;

export interface RenderScene {
  /** Monotonic; the renderer echoes it in `overlay:painted`. */
  seq: number;
  display: { id: string; bounds: Rect; scaleFactor: number };
  reduceMotion: boolean;
  items: RenderItem[];
}

/** Renderer → main after the first paint that contains these item ids. */
export interface PaintedMessage {
  seq: number;
  ids: string[];
}

export const IPC = {
  /** main → overlay renderer: RenderScene */
  render: "overlay:render",
  /** overlay renderer → main: PaintedMessage */
  painted: "overlay:painted",
  /** overlay renderer → main: ready to receive scenes */
  ready: "overlay:ready",
  /** main → overlay renderer: { key, src } — image bytes, sent once per window (see sceneImages.ts) */
  image: "overlay:image",
  /** main → overlay renderer: { keys } — images no longer referenced */
  imageDrop: "overlay:image-drop",
  /** fixture renderer → main: FixtureBoundsMessage */
  fixtureBounds: "fixture:bounds",
} as const;

/** Fixture window → main: element rects relative to the window's content (viewport) origin, DIP. */
export interface FixtureBoundsMessage {
  elements: { id: string; rect: Rect }[];
}
