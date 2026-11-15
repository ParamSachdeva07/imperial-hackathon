/**
 * Pixel annotation on BGRA buffers (pure). Used to mark the selection on the full-display image:
 * dim everything outside it, outline it, or ring a point. Colours are RGB; the buffer is BGRA
 * (Electron's NativeImage.toBitmap order on little-endian machines), row-major, no padding.
 */
import type { Point, Rect } from "@pointy/shared/overlay";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface BgraImage {
  data: Buffer;
  width: number;
  height: number;
}

export type DimShape = { polygon: Point[] } | { rect: Rect };

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
export const DARK: Rgb = { r: 20, g: 20, b: 28 };

/** Multiply the colour of every pixel OUTSIDE the shape by `factor` (even-odd for polygons). */
export function dimOutside(img: BgraImage, shape: DimShape, factor = 0.65): void {
  const { data, width, height } = img;
  const f256 = Math.round(Math.min(1, Math.max(0, factor)) * 256);
  const dimRange = (y: number, x0: number, x1: number): void => {
    let i = (y * width + Math.max(0, x0)) * 4;
    const end = (y * width + Math.min(width, x1)) * 4;
    for (; i < end; i += 4) {
      data[i] = (data[i]! * f256) >> 8;
      data[i + 1] = (data[i + 1]! * f256) >> 8;
      data[i + 2] = (data[i + 2]! * f256) >> 8;
    }
  };
  for (let y = 0; y < height; y++) {
    const spans = "rect" in shape ? rectSpan(shape.rect, y) : polygonSpans(shape.polygon, y + 0.5);
    let cursor = 0;
    for (const [s, e] of spans) {
      const s0 = Math.max(cursor, Math.min(width, s));
      dimRange(y, cursor, s0);
      cursor = Math.max(cursor, Math.min(width, e));
    }
    dimRange(y, cursor, width);
  }
}

/** Inside-spans [startX, endX) in pixels for the scanline at (centre) y. */
function rectSpan(r: Rect, y: number): Array<[number, number]> {
  return y >= r.y && y < r.y + r.height ? [[Math.round(r.x), Math.round(r.x + r.width)]] : [];
}

function polygonSpans(poly: Point[], yc: number): Array<[number, number]> {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > yc !== b.y > yc) xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
  }
  xs.sort((p, q) => p - q);
  const spans: Array<[number, number]> = [];
  for (let k = 0; k + 1 < xs.length; k += 2) spans.push([Math.round(xs[k]!), Math.round(xs[k + 1]!)]);
  return spans;
}

function setPx(img: BgraImage, x: number, y: number, c: Rgb): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = c.b;
  img.data[i + 1] = c.g;
  img.data[i + 2] = c.r;
  img.data[i + 3] = 255;
}

function distToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function strokeSegments(img: BgraImage, segs: Array<[Point, Point]>, halfWidth: number, c: Rgb): void {
  for (const [a, b] of segs) {
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - halfWidth - 1));
    const x1 = Math.min(img.width - 1, Math.ceil(Math.max(a.x, b.x) + halfWidth + 1));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - halfWidth - 1));
    const y1 = Math.min(img.height - 1, Math.ceil(Math.max(a.y, b.y) + halfWidth + 1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (distToSegment(x + 0.5, y + 0.5, a, b) <= halfWidth) setPx(img, x, y, c);
  }
}

export interface PolylineStyle {
  closed?: boolean;
  /** Core thickness in px (default 3). */
  thickness?: number;
  core?: Rgb;
  edge?: Rgb;
}

/** Draw a thick polyline: a dark edge underneath a bright core, so it reads on any background. */
export function drawPolyline(img: BgraImage, points: Point[], style: PolylineStyle = {}): void {
  if (points.length < 2) return;
  const t = style.thickness ?? 3;
  const segs: Array<[Point, Point]> = [];
  for (let i = 0; i + 1 < points.length; i++) segs.push([points[i]!, points[i + 1]!]);
  if (style.closed ?? true) segs.push([points[points.length - 1]!, points[0]!]);
  strokeSegments(img, segs, t / 2 + 1.5, style.edge ?? DARK);
  strokeSegments(img, segs, t / 2, style.core ?? WHITE);
}

function fillDisc(img: BgraImage, cx: number, cy: number, r: number, c: Rgb, innerR = 0): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r && d >= innerR) setPx(img, x, y, c);
    }
}

export interface MarkerStyle {
  /** Ring radius in px (default 18). */
  radius?: number;
  thickness?: number;
  core?: Rgb;
  edge?: Rgb;
}

/** Hollow ring at (x, y) for a selected point (no centre dot, so the control's label stays readable). */
export function drawMarker(img: BgraImage, x: number, y: number, style: MarkerStyle = {}): void {
  const R = style.radius ?? 18;
  const t = style.thickness ?? 3;
  const core = style.core ?? WHITE;
  const edge = style.edge ?? DARK;
  fillDisc(img, x, y, R + t / 2 + 1.5, edge, Math.max(0, R - t / 2 - 1.5));
  fillDisc(img, x, y, R + t / 2, core, Math.max(0, R - t / 2));
}
