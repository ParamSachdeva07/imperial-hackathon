/**
 * Coordinate conversions (pure). Global DIP ↔ display-local DIP ↔ physical pixels.
 * Global DIP: top-left origin of the primary display (Electron `screen`); other displays may have
 * negative origins. `local = global - display.bounds.{x,y}`. Pixels = DIP × scaleFactor.
 */
import type { DisplayInfo, Point, Rect } from "@pointy/shared/overlay";
import { bottomOf, center, intersection, intersects, rightOf } from "./geometry";

/** Structural subset of Electron's `Display`, so this module stays Electron-free. */
export interface DisplayLike {
  id: number | string;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
}

/** Normalise an Electron display (numeric id) to DisplayInfo (string id). */
export function toDisplayInfo(d: DisplayLike): DisplayInfo {
  return { id: String(d.id), bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
}

export function globalToLocal(p: Point, display: DisplayInfo): Point {
  return { x: p.x - display.bounds.x, y: p.y - display.bounds.y };
}

export function localToGlobal(p: Point, display: DisplayInfo): Point {
  return { x: p.x + display.bounds.x, y: p.y + display.bounds.y };
}

export function rectGlobalToLocal(r: Rect, display: DisplayInfo): Rect {
  return { ...r, x: r.x - display.bounds.x, y: r.y - display.bounds.y };
}

export function rectLocalToGlobal(r: Rect, display: DisplayInfo): Rect {
  return { ...r, x: r.x + display.bounds.x, y: r.y + display.bounds.y };
}

/** DIP rect → integer physical-pixel rect, rounding outward (floor left/top, ceil right/bottom). */
export function dipToPx(r: Rect, scaleFactor: number): Rect {
  const left = Math.floor(r.x * scaleFactor);
  const top = Math.floor(r.y * scaleFactor);
  const right = Math.ceil(rightOf(r) * scaleFactor);
  const bottom = Math.ceil(bottomOf(r) * scaleFactor);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Global DIP rect → physical-pixel rect relative to the display's top-left, clamped to the display.
 * This is what `nativeImage.crop` needs for a full-display capture. Returns null if the rect does
 * not overlap the display.
 */
export function globalDipToDisplayPx(r: Rect, display: DisplayInfo): Rect | null {
  const clipped = intersection(r, display.bounds);
  if (!clipped) return null;
  const px = dipToPx(rectGlobalToLocal(clipped, display), display.scaleFactor);
  const maxW = Math.round(display.bounds.width * display.scaleFactor);
  const maxH = Math.round(display.bounds.height * display.scaleFactor);
  const x = Math.min(Math.max(px.x, 0), maxW);
  const y = Math.min(Math.max(px.y, 0), maxH);
  const width = Math.min(px.width, maxW - x);
  const height = Math.min(px.height, maxH - y);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function findDisplay(id: string, displays: DisplayInfo[]): DisplayInfo | null {
  return displays.find((d) => d.id === id) ?? null;
}

/** Display whose bounds contain p (edges: left/top inclusive, right/bottom exclusive). */
export function displayContaining(p: Point, displays: DisplayInfo[]): DisplayInfo | null {
  return (
    displays.find(
      (d) =>
        p.x >= d.bounds.x && p.x < rightOf(d.bounds) && p.y >= d.bounds.y && p.y < bottomOf(d.bounds),
    ) ?? null
  );
}

/** Display containing the rect's centre; otherwise the display with the largest overlap; else null. */
export function displayForRect(r: Rect, displays: DisplayInfo[]): DisplayInfo | null {
  const byCentre = displayContaining(center(r), displays);
  if (byCentre) return byCentre;
  let best: DisplayInfo | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const o = intersection(r, d.bounds);
    const area = o ? o.width * o.height : 0;
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  return best;
}

/** True when r overlaps at least one display. */
export function isOnAnyDisplay(r: Rect, displays: DisplayInfo[]): boolean {
  return displays.some((d) => intersects(r, d.bounds));
}
