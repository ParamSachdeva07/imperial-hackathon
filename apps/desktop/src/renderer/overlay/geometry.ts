/** Pure geometry helpers for building SVG paths from global-DIP targets. */
import type { Point, Rect } from "@pointy/shared/overlay/schemas";
import type { RenderTarget } from "@pointy/shared/overlay/render";

const f = (n: number) => Math.round(n * 100) / 100;

export function inflateRect(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

/** Rounded rectangle path. Always the same command structure so CSS can interpolate `d`. */
export function roundedRectPath(r: Rect, radius: number): string {
  const rad = Math.max(0, Math.min(radius, r.width / 2, r.height / 2));
  const { x, y, width: w, height: h } = r;
  return [
    `M${f(x + rad)} ${f(y)}`,
    `H${f(x + w - rad)}`,
    `A${f(rad)} ${f(rad)} 0 0 1 ${f(x + w)} ${f(y + rad)}`,
    `V${f(y + h - rad)}`,
    `A${f(rad)} ${f(rad)} 0 0 1 ${f(x + w - rad)} ${f(y + h)}`,
    `H${f(x + rad)}`,
    `A${f(rad)} ${f(rad)} 0 0 1 ${f(x)} ${f(y + h - rad)}`,
    `V${f(y + rad)}`,
    `A${f(rad)} ${f(rad)} 0 0 1 ${f(x + rad)} ${f(y)}`,
    "Z",
  ].join(" ");
}

export function circlePath(c: Point, r: number): string {
  return `M${f(c.x - r)} ${f(c.y)} A${f(r)} ${f(r)} 0 1 0 ${f(c.x + r)} ${f(c.y)} A${f(r)} ${f(r)} 0 1 0 ${f(c.x - r)} ${f(c.y)} Z`;
}

function signedArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Offsets a polygon outward by `d` (mitered, miter length capped). Good for the blobs users circle. */
export function offsetPolygon(pts: Point[], d: number): Point[] {
  const n = pts.length;
  if (n < 3) return pts;
  const sign = signedArea(pts) >= 0 ? 1 : -1;
  const norm = (a: Point, b: Point): Point => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: (sign * dy) / len, y: (-sign * dx) / len };
  };
  return pts.map((p, i) => {
    const prev = pts[(i + n - 1) % n]!;
    const next = pts[(i + 1) % n]!;
    const n1 = norm(prev, p);
    const n2 = norm(p, next);
    let mx = n1.x + n2.x;
    let my = n1.y + n2.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) return { x: p.x + n1.x * d, y: p.y + n1.y * d };
    mx /= ml;
    my /= ml;
    const cos = Math.max(0.35, mx * n1.x + my * n1.y); // cap the miter at ~2.9x
    return { x: p.x + (mx * d) / cos, y: p.y + (my * d) / cos };
  });
}

export function polygonPath(pts: Point[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`).join(" ") + " Z";
}

/** Radius used when a `point` target is drawn as a circle. */
export const POINT_TARGET_RADIUS = 28;

/** Path that hugs the target's true shape, `inflate` px outside it. */
export function targetPath(target: RenderTarget, inflate: number, cornerRadius: number): string {
  const { shape, bounds } = target;
  if (shape.kind === "polygon") return polygonPath(offsetPolygon(shape.points, inflate));
  if (shape.kind === "point") return circlePath(shape.point, POINT_TARGET_RADIUS + inflate);
  return roundedRectPath(inflateRect(bounds, inflate), cornerRadius + Math.max(0, inflate / 2));
}

/** Bounds of the drawn shape (used to place glyph badges and underlines). */
export function targetBox(target: RenderTarget, inflate: number): Rect {
  const { shape, bounds } = target;
  if (shape.kind === "point") {
    const r = POINT_TARGET_RADIUS + inflate;
    return { x: shape.point.x - r, y: shape.point.y - r, width: 2 * r, height: 2 * r };
  }
  return inflateRect(bounds, inflate);
}

export interface FitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rect of an `aspect` (w/h) image object-fit:contain'ed into a box. */
export function fitContain(box: { width: number; height: number }, aspect: number): FitRect {
  const a = aspect > 0 ? aspect : 1;
  let width = box.width;
  let height = width / a;
  if (height > box.height) {
    height = box.height;
    width = height * a;
  }
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
