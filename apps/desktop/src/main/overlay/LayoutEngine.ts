/**
 * LayoutEngine (spec §5.6). Pure functions, no Electron. All rects in global DIP.
 * STUB (Phase 0): implemented by the logic track.
 *
 * placeBeside algorithm:
 *  1. Try right, left, below, above the target, each separated by `gap` (default theme.edgeMargin).
 *     Each candidate is centred on the target along the cross axis, then slid (clamped) to stay
 *     inside the work area along that axis.
 *  2. Pick the first candidate fully inside the work area that overlaps neither the target nor any
 *     avoid rect.
 *  3. If none fits (and allowShrink), shrink the size to 80% and retry 1–2.
 *  4. Fall back to the work-area corner (inset by `gap`) farthest from the target centre, preferring
 *     corners that don't overlap avoid rects; use the shrunk size if shrinking was allowed.
 *  The connector runs from the midpoint of the box edge nearest the target to the nearest point on
 *  the target bounds.
 */
import type { Point, Rect, Segment, Size } from "@pointy/shared/overlay";

const todo = (name: string): never => {
  throw new Error(`not implemented: LayoutEngine.${name}`);
};

export type Placement = "right" | "left" | "below" | "above" | "corner";

export interface LayoutInput {
  target: Rect;
  size: Size;
  workArea: Rect;
  avoid?: Rect[];
  /** Gap between target and box. Default theme.edgeMargin (24). */
  gap?: number;
  /** Allow the 80% shrink step. Default true. */
  allowShrink?: boolean;
}

export interface LayoutResult {
  rect: Rect;
  placement: Placement;
  /** 1, or 0.8 when shrunk. `rect` already has the scaled size. */
  scale: number;
  connector: Segment;
}

export function placeBeside(_input: LayoutInput): LayoutResult {
  return todo("placeBeside");
}

/** From the midpoint of the box edge nearest the target to the nearest point on the target. */
export function connectorBetween(_box: Rect, _target: Rect): Segment {
  return todo("connectorBetween");
}

/**
 * Placement for an explainer card with no anchor: "centred-right of the screen" — vertically
 * centred, right-aligned `gap` from the work area's right edge, sliding left/up to avoid avoid-rects
 * if possible. Same shrink rule. connector is null.
 */
export function placeCentredRight(
  _size: Size,
  _workArea: Rect,
  _avoid?: Rect[],
  _gap?: number,
): Omit<LayoutResult, "connector"> & { connector: null } {
  return todo("placeCentredRight");
}

export interface PointerPlacement {
  /** Tip start position: just beyond the display edge nearest to the target centre. */
  entry: Point;
  /** Tip position while tapping: target centre. */
  tap: Point;
  /** Tip position at rest: on the line entry→tap, `restGap` (8 DIP) outside the target bounds. */
  rest: Point;
  /** Degrees clockwise from "pointing right": direction from entry to tap. */
  angle: number;
  /** Approximate rect occupied by the resting pointer body (pointerSize square behind the tip), for label avoidance. */
  body: Rect;
}

/**
 * Where the pointer enters, taps and rests. `displayBounds` is the full display (entry is just
 * outside it, by pointerSize), `pointerSize` defaults to theme.pointerSize.
 */
export function pointerPlacement(_target: Rect, _displayBounds: Rect, _pointerSize?: number): PointerPlacement {
  return todo("pointerPlacement");
}

/**
 * Centre for a numbered step badge pinned beside (never on top of) the target: left of the target
 * (vertically centred, 8 DIP gap) if it fits in the work area, else right, else above, else below.
 */
export function badgePlacement(_target: Rect, _workArea: Rect, _badgeSize?: number): Point {
  return todo("badgePlacement");
}
