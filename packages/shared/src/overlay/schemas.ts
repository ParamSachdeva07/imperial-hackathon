/**
 * Pointy overlay tools: shared contract (POINTY_OVERLAY_SPEC.md §4).
 *
 * THIS FILE IS THE TEAM CONTRACT. Ask before changing a field another teammate depends on.
 *
 * All coordinates are global DIP (points), top-left origin of the primary display,
 * matching Electron's `screen` module. Convert to physical pixels only when cropping
 * screenshots (× display.scaleFactor).
 *
 * Additive changes vs. the spec's §4 listing (no field renamed or removed):
 *   1. `ReplayLastInput` (stretch tool `replay_last` had no input schema).
 *   2. `overlay.dismissed` gains an optional `reason` ("replaced" | "evicted" | "cleared"), so the
 *      "replaced" reason from §5.2 has an event to ride on.
 *   3. `ToolResult.reason` gains "unknown_overlay" (clear/advance_step called with an id that
 *      doesn't exist).
 *   4. `PreviewActionInput` gains an optional `expires` (default "manual"), consistent with the
 *      other tools.
 *   5. `ToolResult.reason` gains "cancelled": the call was overtaken before it could draw
 *      (`clear` all, a new turn, or a context change arrived while its targets were resolving).
 *      "replaced" keeps its §5.2 meaning: a drawing that was shown and then superseded.
 *   6. `MoveAvatarInput` (new MVP tool `move_avatar`) and `ToolResult.reason` "avatar_unavailable"
 *      (no avatar window to move: no call in progress, collapsed, being dragged, or not running).
 *
 * Lifetime note: for `show_steps`, `expires: "on_target_selected"` means "until the guide is
 * completed" (each selected step advances it; the last one ends it after a brief "All done"),
 * not "after the first click".
 */
import { z } from "zod";

// ---------- Geometry ----------
export const Point = z.object({ x: z.number(), y: z.number() });
export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

// ---------- Targets ----------
// Prefer `element`: it follows the element when windows move or scroll.
export const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("element"), elementId: z.string(), snapshotRevision: z.number().int().optional() }),
  z.object({ kind: z.literal("rect"), displayId: z.string(), rect: Rect }),
  z.object({ kind: z.literal("point"), displayId: z.string(), point: Point }),
  z.object({ kind: z.literal("polygon"), displayId: z.string(), points: z.array(Point).min(3) }),
]);

// ---------- Lifetime ----------
// "on_target_selected" on a step guide: until the guide is completed (see the header note).
export const Expiry = z.union([
  z.enum(["next_turn", "on_target_selected", "context_change", "manual"]),
  z.object({ ms: z.number().int().min(500).max(120_000) }),
]);
// Default: "next_turn"
export const DEFAULT_EXPIRY = "next_turn" as const;

const Common = {
  label: z.string().max(60).optional(),
  expires: Expiry.optional(),
  cue: z.string().optional(), // stretch: speech-synced reveal
  turnId: z.string().optional(), // filled by the controller, not the model
};

export const Tone = z.enum(["info", "warning", "success"]);

// ---------- Tool inputs ----------
export const PointAtInput = z.object({
  target: Target,
  motion: z.enum(["tap", "double_tap", "drag_to"]).default("tap"),
  dragTo: Target.optional(),
  ...Common,
});

export const HighlightInput = z.object({
  target: Target,
  style: z.enum(["ring", "spotlight", "underline"]).default("ring"),
  tone: Tone.default("info"),
  ...Common,
});

export const ShowStepsInput = z.object({
  steps: z
    .array(z.object({ target: Target, label: z.string().max(40) }))
    .min(1)
    .max(5),
  startAt: z.number().int().min(0).default(0),
  expires: Expiry.optional(),
  turnId: z.string().optional(),
});

export const AdvanceStepInput = z.object({ stepsId: z.string() });

// Additive: moves the voice avatar window out of the way. "auto" picks the corner farthest from
// whatever is on screen (plus `avoid`, if given).
export const MoveAvatarInput = z.object({
  position: z.enum(["auto", "top_left", "top_right", "bottom_left", "bottom_right"]).default("auto"),
  avoid: Target.optional(), // keep the avatar clear of this target
  displayId: z.string().optional(), // default: the display the avatar is on
  turnId: z.string().optional(),
});

// Fixed icon set for templates (render locally as SVG).
export const IconName = z.enum([
  "click",
  "type",
  "folder",
  "file",
  "photo",
  "email",
  "attach",
  "send",
  "search",
  "settings",
  "wifi",
  "cloud",
  "lock",
  "warning",
  "check",
  "trash",
  "download",
  "printer",
  "phone",
  "video",
  "person",
]);

export const ConceptSpec = z.object({
  kind: z.literal("concept"),
  panels: z
    .array(
      z.object({
        caption: z.string().max(90),
        imagePrompt: z.string().max(300), // describe a picture; NO text in it
      }),
    )
    .min(1)
    .max(3),
});

export const SequenceSpec = z.object({
  kind: z.literal("sequence"),
  steps: z
    .array(z.object({ icon: IconName, caption: z.string().max(60) }))
    .min(2)
    .max(5),
});

export const CompareSide = z.object({
  title: z.string().max(30),
  points: z.array(z.string().max(60)).max(4),
  imagePrompt: z.string().optional(),
});

export const CompareSpec = z.object({
  kind: z.literal("compare"),
  left: CompareSide,
  right: CompareSide,
});

export const AnatomySpec = z.object({
  kind: z.literal("anatomy"),
  region: Target, // the part of the screen to crop (often the user's circled polygon)
  callouts: z
    .array(z.object({ target: Target, label: z.string().max(40) }))
    .min(1)
    .max(6),
});

export const ExplainerSpec = z.discriminatedUnion("kind", [ConceptSpec, SequenceSpec, CompareSpec, AnatomySpec]);

export const ShowExplainerInput = z.object({
  anchor: Target.optional(), // card is placed beside this; if absent, centred-right of the screen
  title: z.string().max(50),
  expires: Expiry.optional(),
  cue: z.string().optional(),
  turnId: z.string().optional(),
  spec: ExplainerSpec,
});

export const ClearInput = z.object({ overlayId: z.union([z.string(), z.literal("all")]) });

// Stretch
export const MagnifyInput = z.object({
  target: Target,
  zoom: z.number().min(2).max(4).default(2.5),
  expires: Expiry.optional(),
});
export const PreviewActionInput = z.object({
  target: Target,
  actionLabel: z.string().max(30),
  expires: Expiry.optional(), // additive (default "manual": the controller removes it when the action runs/cancels)
});
export const ReplayLastInput = z.object({}); // additive

// ---------- Tool result (returned to the model) ----------
export const ToolResultReason = z.enum([
  "target_not_found",
  "target_offscreen",
  "invalid_input",
  "display_not_found",
  "replaced",
  "unknown_overlay", // additive
  "cancelled", // additive: overtaken (clear all / new turn / context change) before it drew
  "avatar_unavailable", // additive: move_avatar with no movable avatar window (no call, collapsed, dragging)
]);

export const ToolResult = z.object({
  ok: z.boolean(),
  overlayId: z.string().optional(),
  visible: z.boolean(), // false if target is off-screen/not found
  resolvedBounds: Rect.optional(),
  reason: ToolResultReason.optional(),
});

// ---------- Events (sent back to the controller → AI) ----------
export const DismissReason = z.enum(["replaced", "evicted", "cleared"]); // additive

export const OverlayEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("overlay.shown"), overlayId: z.string() }),
  z.object({ type: z.literal("overlay.target_lost"), overlayId: z.string() }),
  z.object({ type: z.literal("overlay.target_selected"), overlayId: z.string() }),
  z.object({
    type: z.literal("overlay.dismissed"),
    overlayId: z.string(),
    by: z.enum(["user", "model", "controller"]),
    reason: DismissReason.optional(), // additive
  }),
  z.object({ type: z.literal("overlay.expired"), overlayId: z.string() }),
  z.object({ type: z.literal("steps.advanced"), stepsId: z.string(), index: z.number().int() }),
  z.object({ type: z.literal("steps.completed"), stepsId: z.string() }),
  z.object({ type: z.literal("explainer.image_ready"), overlayId: z.string(), panel: z.number().int() }),
  z.object({ type: z.literal("explainer.image_failed"), overlayId: z.string(), panel: z.number().int() }),
]);

// ---------- Inferred types ----------
export type Point = z.infer<typeof Point>;
export type Rect = z.infer<typeof Rect>;
export type Target = z.infer<typeof Target>;
export type ElementTarget = Extract<Target, { kind: "element" }>;
export type Expiry = z.infer<typeof Expiry>;
export type Tone = z.infer<typeof Tone>;
export type IconName = z.infer<typeof IconName>;
export type PointAtInput = z.infer<typeof PointAtInput>;
export type HighlightInput = z.infer<typeof HighlightInput>;
export type ShowStepsInput = z.infer<typeof ShowStepsInput>;
export type AdvanceStepInput = z.infer<typeof AdvanceStepInput>;
export type MoveAvatarInput = z.infer<typeof MoveAvatarInput>;
export type ExplainerSpec = z.infer<typeof ExplainerSpec>;
export type ConceptSpec = z.infer<typeof ConceptSpec>;
export type SequenceSpec = z.infer<typeof SequenceSpec>;
export type CompareSpec = z.infer<typeof CompareSpec>;
export type CompareSide = z.infer<typeof CompareSide>;
export type AnatomySpec = z.infer<typeof AnatomySpec>;
export type ShowExplainerInput = z.infer<typeof ShowExplainerInput>;
export type ClearInput = z.infer<typeof ClearInput>;
export type MagnifyInput = z.infer<typeof MagnifyInput>;
export type PreviewActionInput = z.infer<typeof PreviewActionInput>;
export type ReplayLastInput = z.infer<typeof ReplayLastInput>;
export type ToolResultReason = z.infer<typeof ToolResultReason>;
export type ToolResult = z.infer<typeof ToolResult>;
export type DismissReason = z.infer<typeof DismissReason>;
export type OverlayEvent = z.infer<typeof OverlayEvent>;
