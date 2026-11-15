/**
 * Anatomy crop math (spec §7.2). Pure.
 *
 *  1. planCrop: pad the region by `padFraction` (15%) of its width/height on every side, clamp to
 *     the display bounds, and compute the physical-pixel crop rect relative to the display origin
 *     (DIP × scaleFactor, rounded outward, clamped to the display's pixel size).
 *  2. fitSize: scale content to fit inside a box, preserving aspect ratio (upscaling allowed).
 *  3. normaliseInCrop: map a global-DIP rect into the crop as 0..1 fractions of the crop's DIP
 *     region, clipped to the crop; `inside` is false when it doesn't overlap the crop at all.
 */
import type { DisplayInfo, Rect, Size } from "@pointy/shared/overlay";
import { globalDipToDisplayPx } from "../coords";
import { inflate, intersection } from "../geometry";

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

export function planCrop(region: Rect, display: DisplayInfo, padFraction = 0.15): CropPlan {
  const padded = inflate(region, region.width * padFraction, region.height * padFraction);
  const clamped = intersection(padded, display.bounds) ?? { ...display.bounds };
  const px = globalDipToDisplayPx(clamped, display) ?? { x: 0, y: 0, width: 0, height: 0 };
  return { displayId: display.id, scaleFactor: display.scaleFactor, region: clamped, px };
}

export function fitSize(content: Size, box: Size): Size & { scale: number } {
  if (content.width <= 0 || content.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(box.width / content.width, box.height / content.height);
  return { width: content.width * scale, height: content.height * scale, scale };
}

export function normaliseInCrop(target: Rect, plan: CropPlan): NormalisedRect {
  const clipped = intersection(target, plan.region);
  if (!clipped) return { nx: 0, ny: 0, nw: 0, nh: 0, inside: false };
  const { region } = plan;
  return {
    nx: (clipped.x - region.x) / region.width,
    ny: (clipped.y - region.y) / region.height,
    nw: clipped.width / region.width,
    nh: clipped.height / region.height,
    inside: true,
  };
}
