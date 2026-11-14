/**
 * Where to put the voice avatar window (pure). The window keeps its size; only its top-left moves.
 * "auto" picks the corner of the work area with the least overlap with what is on screen.
 */
import type { Point, Rect } from "@pointy/shared/overlay";
import { bottomOf, center, clamp, distance, intersection, rightOf } from "../geometry";

export type AvatarPosition = "auto" | "top_left" | "top_right" | "bottom_left" | "bottom_right";
export type AvatarCorner = Exclude<AvatarPosition, "auto">;

export const AVATAR_MARGIN = 24;

export interface ChooseAvatarPositionInput {
  /** The avatar window's current bounds (its size is kept). */
  avatar: Rect;
  workArea: Rect;
  position: AvatarPosition;
  /** What the avatar should stay off: drawings, their targets, the `avoid` target. */
  avoid: Rect[];
  /** Gap kept to the work-area edges (default AVATAR_MARGIN). */
  margin?: number;
  /** The avatar is being brought to this work area from elsewhere: "auto" must not stay put. */
  relocate?: boolean;
}

/** Top-left of the avatar in one corner of the work area, inset by `margin` (never outside it). */
export function cornerTopLeft(avatar: Rect, workArea: Rect, corner: AvatarCorner, margin: number): Point {
  const left = workArea.x + margin;
  const top = workArea.y + margin;
  const right = rightOf(workArea) - margin - avatar.width;
  const bottom = bottomOf(workArea) - margin - avatar.height;
  const x = corner === "top_left" || corner === "bottom_left" ? left : right;
  const y = corner === "top_left" || corner === "top_right" ? top : bottom;
  return { x: clamp(x, workArea.x, rightOf(workArea) - avatar.width), y: clamp(y, workArea.y, bottomOf(workArea) - avatar.height) };
}

const overlapArea = (r: Rect, rects: Rect[]): number =>
  rects.reduce((sum, a) => {
    const o = intersection(r, a);
    return sum + (o ? o.width * o.height : 0);
  }, 0);

const CORNERS: AvatarCorner[] = ["top_right", "bottom_right", "top_left", "bottom_left"];

export function chooseAvatarPosition(input: ChooseAvatarPositionInput): Point {
  const { avatar, workArea, position, avoid } = input;
  const margin = input.margin ?? AVATAR_MARGIN;
  if (position !== "auto") return cornerTopLeft(avatar, workArea, position, margin);

  const current = { x: avatar.x, y: avatar.y };
  if (!input.relocate && overlapArea(avatar, avoid) === 0) return current; // already clear: stay put

  const centroid: Point | null = avoid.length
    ? {
        x: avoid.reduce((s, r) => s + center(r).x, 0) / avoid.length,
        y: avoid.reduce((s, r) => s + center(r).y, 0) / avoid.length,
      }
    : null;
  const scored = CORNERS.map((corner, order) => {
    const p = cornerTopLeft(avatar, workArea, corner, margin);
    const rect = { ...avatar, ...p };
    return { p, order, overlap: overlapArea(rect, avoid), far: centroid ? distance(center(rect), centroid) : 0 };
  });
  // Least overlap, then farthest from what is on screen, then the fixed corner order (top-right first,
  // where the avatar normally lives).
  scored.sort((a, b) => a.overlap - b.overlap || b.far - a.far || a.order - b.order);
  return scored[0]!.p;
}
