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


/** Signed scroll amounts in the OS mouse library's units: up > 0 = wheel up, left > 0 = scroll left. */
export interface ScrollAmount {
  up: number;
  left: number;
}

/**
 * Turns fist-drag movement (DIP, drag semantics) into OS scroll amounts, keeping the remainder
 * between calls so slow drags still scroll. Units differ per platform in nut-js/libnut:
 * Windows = wheel delta (120 per notch), macOS = pixels, Linux = notches.
 * `pxPerNotch`: how many DIP of hand movement make one wheel notch (Windows/Linux).
 */
export function createScrollConverter(platform: NodeJS.Platform, pxPerNotch = 100) {
  const unitsPerDip = platform === "win32" ? 120 / pxPerNotch : platform === "darwin" ? 1 : 1 / pxPerNotch;
  let accX = 0;
  let accY = 0;
  return (dx: number, dy: number): ScrollAmount => {
    // Drag semantics: hand down (dy > 0) moves content down = scroll up.
    accY += dy * unitsPerDip;
    accX += dx * unitsPerDip;
    // Small epsilon: summing e.g. 0.3 ten times gives 2.9999…, which must count as 3.
    const up = Math.trunc(accY + Math.sign(accY) * 1e-9);
    const left = Math.trunc(accX + Math.sign(accX) * 1e-9);
    accY -= up;
    accX -= left;
    return { up, left };
  };
}
