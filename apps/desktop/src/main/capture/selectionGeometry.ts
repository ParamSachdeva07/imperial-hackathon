/**
 * Selection geometry (pure). Turns a gesture selection event (display-RELATIVE DIP) into a capture
 * plan: global-DIP geometry, the focus crop box, output sizes, and the selection mapped into the
 * full-image as 0..1 fractions (resolution independent, so the plan survives quality/size stepping).
 */
import type { DisplayInfo, Point, Rect } from "@pointy/shared/overlay";
import { fitSize } from "../overlay/explainer/anatomyCrop";
import { findDisplay, localToGlobal, rectLocalToGlobal } from "../overlay/coords";
import { inflate, intersection } from "../overlay/geometry";

export const FULL_MAX_WIDTH = 1280;
export const FOCUS_MAX_SIDE = 768;
export const FOCUS_PAD_FRACTION = 0.15;
export const POINT_FOCUS_DIP = { width: 480, height: 320 };
/** A region smaller than this (DIP) gets its focus box grown around its centre so the close-up is legible. */
export const MIN_FOCUS_DIP = { width: 120, height: 80 };

export type SelectionEventInput =
  | { type: "region_selected"; polygon: ReadonlyArray<readonly [number, number]>; bbox: Rect; displayId: number }
  | { type: "point_selected"; x: number; y: number; displayId: number };

export interface Size2 {
  width: number;
  height: number;
}

export interface SelectionPlan {
  kind: "region" | "point";
  display: DisplayInfo;
  /** Region: bbox (clamped to the display). Point: the focus box. Global DIP. */
  regionGlobal: Rect;
  polygonGlobal?: Point[];
  pointGlobal?: Point;
  /** Focus close-up box, global DIP, inside the display. */
  focusBoxGlobal: Rect;
  /** Focus box in native display pixels (relative to the display top-left). */
  focusCropPx: Rect;
  /** Native display size in pixels. */
  displayPx: Size2;
  /** Base output sizes (before any budget down-scaling). */
  fullSize: Size2;
  focusSize: Size2;
  /** Selection mapped to 0..1 fractions of the display (= of the full image). */
  polygonNorm?: Point[];
  pointNorm?: Point;
  /** Selection bbox (region) or the point's marker box as 0..1 fractions. */
  markedRegion: Rect;
}

export type PlanResult = { ok: true; plan: SelectionPlan } | { ok: false; reason: string };

const finite = (...n: number[]): boolean => n.every((v) => Number.isFinite(v));

/** Scale a 0..1 point to image pixels. */
export function normToPx(p: Point, size: Size2): Point {
  return { x: p.x * size.width, y: p.y * size.height };
}

/** Scale a size down to fit a box (never upscales), integer, at least 1px. */
function fitDown(content: Size2, box: Size2): Size2 {
  const fit = fitSize(content, box);
  const scale = Math.min(1, fit.scale);
  return { width: Math.max(1, Math.round(content.width * scale)), height: Math.max(1, Math.round(content.height * scale)) };
}

function growToMin(r: Rect, min: Size2): Rect {
  const w = Math.max(r.width, min.width);
  const h = Math.max(r.height, min.height);
  return { x: r.x - (w - r.width) / 2, y: r.y - (h - r.height) / 2, width: w, height: h };
}

/** Shift a rect of the given size so it lies inside bounds (shrinking it only if larger than bounds). */
function clampInside(r: Rect, bounds: Rect): Rect {
  const width = Math.min(r.width, bounds.width);
  const height = Math.min(r.height, bounds.height);
  const x = Math.min(Math.max(r.x, bounds.x), bounds.x + bounds.width - width);
  const y = Math.min(Math.max(r.y, bounds.y), bounds.y + bounds.height - height);
  return { x, y, width, height };
}

export function planSelection(event: SelectionEventInput, displays: DisplayInfo[]): PlanResult {
  const display = findDisplay(String(event.displayId), displays);
  if (!display) return { ok: false, reason: `display ${event.displayId} not found` };
  const b = display.bounds;
  if (b.width <= 0 || b.height <= 0 || display.scaleFactor <= 0) return { ok: false, reason: "display has no size" };
  const displayPx = { width: Math.round(b.width * display.scaleFactor), height: Math.round(b.height * display.scaleFactor) };

  let kind: "region" | "point";
  let regionGlobal: Rect;
  let focusBoxGlobal: Rect;
  let polygonGlobal: Point[] | undefined;
  let pointGlobal: Point | undefined;
  let markedGlobal: Rect;

  if (event.type === "region_selected") {
    kind = "region";
    if (event.polygon.length < 3) return { ok: false, reason: "polygon has fewer than 3 points" };
    if (!event.polygon.every(([x, y]) => finite(x, y))) return { ok: false, reason: "polygon has non-finite points" };
    const { x, y, width, height } = event.bbox;
    if (!finite(x, y, width, height)) return { ok: false, reason: "bbox is not finite" };
    const bboxGlobal = rectLocalToGlobal({ x, y, width: Math.max(1, width), height: Math.max(1, height) }, display);
    const clamped = intersection(bboxGlobal, b);
    if (!clamped) return { ok: false, reason: "region is not on the display" };
    polygonGlobal = event.polygon.map(([px, py]) => localToGlobal({ x: px, y: py }, display));
    regionGlobal = clamped;
    markedGlobal = clamped;
    focusBoxGlobal = clampInside(growToMin(inflate(clamped, clamped.width * FOCUS_PAD_FRACTION, clamped.height * FOCUS_PAD_FRACTION), MIN_FOCUS_DIP), b);
  } else {
    kind = "point";
    if (!finite(event.x, event.y)) return { ok: false, reason: "point is not finite" };
    if (event.x < 0 || event.y < 0 || event.x >= b.width || event.y >= b.height) return { ok: false, reason: "point is not on the display" };
    pointGlobal = localToGlobal({ x: event.x, y: event.y }, display);
    const box = {
      x: pointGlobal.x - POINT_FOCUS_DIP.width / 2,
      y: pointGlobal.y - POINT_FOCUS_DIP.height / 2,
      ...POINT_FOCUS_DIP,
    };
    focusBoxGlobal = clampInside(box, b);
    regionGlobal = focusBoxGlobal;
    markedGlobal = { x: pointGlobal.x, y: pointGlobal.y, width: 0, height: 0 };
  }

  const toNorm = (p: Point): Point => ({ x: (p.x - b.x) / b.width, y: (p.y - b.y) / b.height });
  const polygonNorm = polygonGlobal?.map(toNorm);
  const pointNorm = pointGlobal ? toNorm(pointGlobal) : undefined;
  const markedRegion: Rect = {
    x: (markedGlobal.x - b.x) / b.width,
    y: (markedGlobal.y - b.y) / b.height,
    width: markedGlobal.width / b.width,
    height: markedGlobal.height / b.height,
  };

  // Focus crop in native px: relative to the display, rounded outward, clamped.
  const fl = (focusBoxGlobal.x - b.x) * display.scaleFactor;
  const ft = (focusBoxGlobal.y - b.y) * display.scaleFactor;
  const left = Math.max(0, Math.floor(fl));
  const top = Math.max(0, Math.floor(ft));
  const right = Math.min(displayPx.width, Math.ceil(fl + focusBoxGlobal.width * display.scaleFactor));
  const bottom = Math.min(displayPx.height, Math.ceil(ft + focusBoxGlobal.height * display.scaleFactor));
  const focusCropPx = { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };

  return {
    ok: true,
    plan: {
      kind,
      display,
      regionGlobal,
      ...(polygonGlobal ? { polygonGlobal } : {}),
      ...(pointGlobal ? { pointGlobal } : {}),
      focusBoxGlobal,
      focusCropPx,
      displayPx,
      fullSize: fitDown(displayPx, { width: FULL_MAX_WIDTH, height: 100_000 }),
      focusSize: fitDown(focusCropPx, { width: FOCUS_MAX_SIDE, height: FOCUS_MAX_SIDE }),
      ...(polygonNorm ? { polygonNorm } : {}),
      ...(pointNorm ? { pointNorm } : {}),
      markedRegion,
    },
  };
}
