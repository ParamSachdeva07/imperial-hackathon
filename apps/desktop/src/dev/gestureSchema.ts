/**
 * Validation for POST /gesture bodies. Mirrors the GestureEvent union in packages/gestures/src/events.ts
 * (the package exports no runtime validation). The type check at the bottom is bidirectional: adding,
 * removing or changing an event in the package fails typecheck until this schema follows.
 */
import { z } from "zod";
import type { GestureEvent } from "@pointy/gestures";

const hand = z.enum(["Left", "Right"]);
const num = z.number().finite();
const base = { hand, t: num };
const xy = { x: num, y: num, displayId: z.number().int() };
const phase = z.enum(["start", "move", "end"]);

export const GestureEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wake_requested"), source: z.literal("open_palm"), hand, heldForMs: num, t: num }),
  z.object({ type: z.literal("wake_progress"), ...base, progress: num.min(0).max(1), ...xy }),
  z.object({ type: z.literal("cursor_moved"), ...base, ...xy }),
  z.object({ type: z.literal("dwell_progress"), ...base, progress: num.min(0).max(1), ...xy }),
  z.object({ type: z.literal("point_selected"), ...base, ...xy, heldForMs: num }),
  z.object({
    type: z.literal("region_selected"),
    ...base,
    polygon: z.array(z.tuple([num, num])).min(3).max(2000),
    bbox: z.object({ x: num, y: num, width: num, height: num }),
    displayId: z.number().int(),
  }),
  z.object({ type: z.literal("scroll"), ...base, phase, dx: num, dy: num }),
  z.object({ type: z.literal("mouse"), ...base, phase, ...xy }),
  z.object({ type: z.literal("click_progress"), ...base, progress: num.min(0).max(1), ...xy }),
  z.object({ type: z.literal("click"), ...base, button: z.literal("left"), ...xy }),
  z.object({ type: z.literal("hand_lost"), ...base, reason: z.enum(["absent", "pose_changed"]) }),
]);

export const GestureBody = z.object({
  events: z.array(GestureEventSchema).min(1).max(5000),
  intervalMs: z.number().finite().min(0).max(1000).optional(),
});
/**
 * The gesture layer (and its feedback window) maps to ONE display, so events for another display
 * would be drawn on the wrong monitor. Throws a ZodError (-> HTTP 400) naming the unsupported ids.
 */
export function assertEventsForDisplay(events: readonly GestureEvent[], displayId: number): void {
  const bad = [...new Set(events.flatMap((e) => ("displayId" in e && e.displayId !== displayId ? [e.displayId] : [])))];
  if (bad.length === 0) return;
  throw new z.ZodError([
    { code: "custom", path: ["events"], input: events, message: `displayId ${bad.join(", ")} is not supported: gestures run on display ${displayId} only` },
  ]);
}

export const GestureSessionBody = z.object({ active: z.boolean() });

type Parsed = z.infer<typeof GestureEventSchema>;
/** Exact type equality (not just assignability), so extra or missing members/fields on either side fail. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compile-time only: errors when the schema and the package's GestureEvent union differ. */
export const _schemaMatchesContract: Equal<Parsed, GestureEvent> = true;
