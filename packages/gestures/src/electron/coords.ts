/** Pure coordinate helpers (no Electron import, so they can be unit-tested in Node). */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Gesture coordinates (DIP, relative to the display) → absolute OS mouse coordinates.
 * Windows mouse APIs use physical pixels; macOS uses points (= DIP).
 */
export function toMousePoint(
  bounds: Rect,
  x: number,
  y: number,
  platform: NodeJS.Platform,
  dipToScreen: (p: ScreenPoint) => ScreenPoint,
): ScreenPoint {
  const dip = {
    x: bounds.x + Math.min(Math.max(x, 0), bounds.width - 1),
    y: bounds.y + Math.min(Math.max(y, 0), bounds.height - 1),
  };
  const p = platform === "win32" ? dipToScreen(dip) : dip;
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

