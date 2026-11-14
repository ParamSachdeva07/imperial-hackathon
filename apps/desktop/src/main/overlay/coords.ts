/**
 * Coordinate conversions (pure). Global DIP ↔ display-local DIP ↔ physical pixels.
 * Global DIP: top-left origin of the primary display (Electron `screen`); other displays may have
 * negative origins. `local = global - display.bounds.{x,y}`. Pixels = DIP × scaleFactor.
 * STUB (Phase 0): implemented by the logic track.
 */
import type { DisplayInfo, Point, Rect } from "@pointy/shared/overlay";

const todo = (name: string): never => {
  throw new Error(`not implemented: coords.${name}`);
};

/** Structural subset of Electron's `Display`, so this module stays Electron-free. */
export interface DisplayLike {
  id: number | string;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
}

/** Normalise an Electron display (numeric id) to DisplayInfo (string id). */
export function toDisplayInfo(_d: DisplayLike): DisplayInfo {
  return todo("toDisplayInfo");
}

export function globalToLocal(_p: Point, _display: DisplayInfo): Point {
  return todo("globalToLocal");
}

export function localToGlobal(_p: Point, _display: DisplayInfo): Point {
  return todo("localToGlobal");
}

export function rectGlobalToLocal(_r: Rect, _display: DisplayInfo): Rect {
  return todo("rectGlobalToLocal");
}

export function rectLocalToGlobal(_r: Rect, _display: DisplayInfo): Rect {
  return todo("rectLocalToGlobal");
}

/** DIP rect → integer physical-pixel rect, rounding outward (floor left/top, ceil right/bottom). */
export function dipToPx(_r: Rect, _scaleFactor: number): Rect {
  return todo("dipToPx");
}

/**
 * Global DIP rect → physical-pixel rect relative to the display's top-left, clamped to the display.
 * This is what `nativeImage.crop` needs for a full-display capture. Returns null if the rect does
 * not overlap the display.
 */
export function globalDipToDisplayPx(_r: Rect, _display: DisplayInfo): Rect | null {
  return todo("globalDipToDisplayPx");
}

export function findDisplay(_id: string, _displays: DisplayInfo[]): DisplayInfo | null {
  return todo("findDisplay");
}

/** Display whose bounds contain p (edges: left/top inclusive, right/bottom exclusive). */
export function displayContaining(_p: Point, _displays: DisplayInfo[]): DisplayInfo | null {
  return todo("displayContaining");
}

/** Display containing the rect's centre; otherwise the display with the largest overlap; else null. */
export function displayForRect(_r: Rect, _displays: DisplayInfo[]): DisplayInfo | null {
  return todo("displayForRect");
}

/** True when r overlaps at least one display. */
export function isOnAnyDisplay(_r: Rect, _displays: DisplayInfo[]): boolean {
  return todo("isOnAnyDisplay");
}
