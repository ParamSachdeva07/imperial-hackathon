/**
 * Anatomy crop math (spec §7.2). Pure.
 * STUB (Phase 0): implemented by the logic track.
 *
 *  1. planCrop: pad the region by `padFraction` (15%) of its width/height on every side, clamp to
 *     the display bounds, and compute the physical-pixel crop rect relative to the display origin
 *     (DIP × scaleFactor, rounded outward, clamped to the display's pixel size).
 *  2. fitSize: scale content to fit inside a box, preserving aspect ratio (upscaling allowed).
 *  3. normaliseInCrop: map a global-DIP rect into the crop as 0..1 fractions of the crop's DIP
 *     region, clipped to the crop; `inside` is false when it doesn't overlap the crop at all.
 */
import type { DisplayInfo, Rect, Size } from "@pointy/shared/overlay";

export interface CropPlan {
  displayId: string;
  scaleFactor: number;
  /** Padded, clamped region in global DIP. */
  region: Rect;
  /** Physical pixels relative to the display's top-left. */
  px: Rect;
}

export interface NormalisedRect {
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  inside: boolean;
}

export function planCrop(_region: Rect, _display: DisplayInfo, _padFraction = 0.15): CropPlan {
  throw new Error("not implemented: anatomyCrop.planCrop");
}

export function fitSize(_content: Size, _box: Size): Size & { scale: number } {
  throw new Error("not implemented: anatomyCrop.fitSize");
}

export function normaliseInCrop(_target: Rect, _plan: CropPlan): NormalisedRect {
  throw new Error("not implemented: anatomyCrop.normaliseInCrop");
}
