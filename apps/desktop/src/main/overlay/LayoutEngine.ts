/**
 * LayoutEngine (spec §5.6). Pure functions, no Electron. All rects in global DIP.
 *
 * placeBeside algorithm:
 *  1. Try right, left, below, above the target, each separated by `gap` (default theme.edgeMargin).
 *     Each candidate is centred on the target along the cross axis, then slid (clamped) to stay
 *     inside the work area along that axis.
 *  2. Pick the first candidate fully inside the work area that overlaps neither the target nor any
 *     avoid rect.
 *  3. If none fits (and allowShrink), shrink the size to 80% and retry 1–2.
 *  4. Fall back to the work-area corner (inset by `gap`) farthest from the target centre, preferring
 *     corners that don't overlap avoid rects; use the shrunk size if shrinking was allowed.
 *  The connector runs from the midpoint of the box edge nearest the target to the nearest point on
 *  the target bounds.
 */
import { theme } from "@pointy/shared/overlay";
import type { Point, Rect, Segment, Size } from "@pointy/shared/overlay";
import {
  bottomOf,
  center,
  clamp,
  containsPoint,
  containsRect,
  distance,
  intersects,
  nearestPointOnRect,
  rightOf,
} from "./geometry";

export type Placement = "right" | "left" | "below" | "above" | "corner";

export interface LayoutInput {
  target: Rect;
  size: Size;
  workArea: Rect;
  avoid?: Rect[];
  /** Gap between target and box. Default theme.edgeMargin (24). */
  gap?: number;
  /** Allow the 80% shrink step. Default true. */
  allowShrink?: boolean;
  /** Side to try first (the box's previous side), so a small move doesn't make it jump sides. */
  prefer?: Placement;
}

export interface LayoutResult {
  rect: Rect;
  placement: Placement;
  /** 1, or 0.8 when shrunk. `rect` already has the scaled size. */
  scale: number;
  connector: Segment;
}

const SHRINK = 0.8;
const REST_GAP = 8;
const BADGE_GAP = 8;


const scaled = (size: Size, scale: number): Size => ({ width: size.width * scale, height: size.height * scale });

/** Largest scale (≤ 1) at which `size` fits inside the work area with `gap` on every side. */
const fitScale = (size: Size, workArea: Rect, gap: number): number =>
  Math.min(1, (workArea.width - 2 * gap) / size.width, (workArea.height - 2 * gap) / size.height);

const overlapsAny = (rect: Rect, rects: Rect[]): boolean => rects.some((a) => intersects(rect, a));

/** Candidate boxes in preference order: right, left, below, above. */
function sideCandidates(target: Rect, size: Size, workArea: Rect, gap: number): [Exclude<Placement, "corner">, Rect][] {
  const c = center(target);
  const { width, height } = size;
  const y = clamp(c.y - height / 2, workArea.y, bottomOf(workArea) - height);
  const x = clamp(c.x - width / 2, workArea.x, rightOf(workArea) - width);
  return [
    ["right", { x: rightOf(target) + gap, y, width, height }],
    ["left", { x: target.x - gap - width, y, width, height }],
    ["below", { x, y: bottomOf(target) + gap, width, height }],
    ["above", { x, y: target.y - gap - height, width, height }],
  ];
}

function corners(size: Size, workArea: Rect, gap: number): Rect[] {
  const { width, height } = size;
  const left = workArea.x + gap;
  const top = workArea.y + gap;
  const right = rightOf(workArea) - gap - width;
  const bottom = bottomOf(workArea) - gap - height;
  return [
    { x: left, y: top, width, height },
    { x: right, y: top, width, height },
    { x: left, y: bottom, width, height },
    { x: right, y: bottom, width, height },
  ];
}

export function placeBeside(input: LayoutInput): LayoutResult {
  const { target, size, workArea } = input;
  const avoid = input.avoid ?? [];
  const gap = input.gap ?? theme.edgeMargin;
  const allowShrink = input.allowShrink ?? true;
  const scales = allowShrink ? [1, SHRINK] : [1];

  const preferFirst = (c: [Exclude<Placement, "corner">, Rect][]) =>
    input.prefer ? [...c.filter(([p]) => p === input.prefer), ...c.filter(([p]) => p !== input.prefer)] : c;
  for (const scale of scales) {
    for (const [placement, rect] of preferFirst(sideCandidates(target, scaled(size, scale), workArea, gap))) {
      if (containsRect(workArea, rect) && !intersects(rect, target) && !overlapsAny(rect, avoid)) {
        return { rect, placement, scale, connector: connectorBetween(rect, target) };
      }
    }
  }

  // Last resort: a box still bigger than the work area is scaled down until it fits, so content is
  // never pushed off-screen.
  const scale = Math.min(allowShrink ? SHRINK : 1, fitScale(size, workArea, gap));
  const tc = center(target);
  const ranked = corners(scaled(size, scale), workArea, gap)
    .map((rect) => ({ rect, d: distance(center(rect), tc) }))
    .sort((a, b) => b.d - a.d);
  // Prefer a corner clear of both the target and the avoid rects, then one clear of the target
  // (never cover what's being explained), then one clear of the avoid rects, then the farthest.
  const best =
    ranked.find((c) => !intersects(c.rect, target) && !overlapsAny(c.rect, avoid)) ??
    ranked.find((c) => !intersects(c.rect, target)) ??
    ranked.find((c) => !overlapsAny(c.rect, avoid)) ??
    ranked[0]!;
  return { rect: best.rect, placement: "corner", scale, connector: connectorBetween(best.rect, target) };
}

/** From the midpoint of the box edge nearest the target to the nearest point on the target. */
export function connectorBetween(box: Rect, target: Rect): Segment {
  const mids: Point[] = [
    { x: rightOf(box), y: box.y + box.height / 2 },
    { x: box.x, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: bottomOf(box) },
    { x: box.x + box.width / 2, y: box.y },
  ];
  let from = mids[0]!;
  let bestD = Infinity;
  for (const m of mids) {
    const d = distance(m, nearestPointOnRect(target, m));
    if (d < bestD) {
      bestD = d;
      from = m;
    }
  }
  return { from, to: nearestPointOnRect(target, from) };
}

/**
 * Placement for an explainer card with no anchor: "centred-right of the screen" — vertically
 * centred, right-aligned `gap` from the work area's right edge, sliding left/up to avoid avoid-rects
 * if possible. Same shrink rule (always allowed). connector is null.
 * When nothing avoids the avoid rects, the preferred spot is used at the shrunk size
 * (placement "right").
 */
export function placeCentredRight(
  size: Size,
  workArea: Rect,
  avoid: Rect[] = [],
  gap: number = theme.edgeMargin,
): Omit<LayoutResult, "connector"> & { connector: null } {
  const preferred = (s: Size): Rect => ({
    x: rightOf(workArea) - gap - s.width,
    y: workArea.y + (workArea.height - s.height) / 2,
    ...s,
  });

  for (const scale of [1, SHRINK]) {
    const s = scaled(size, scale);
    const base = preferred(s);
    const candidates: Rect[] = [base];
    for (const a of avoid) {
      candidates.push(
        { ...base, x: a.x - gap - s.width }, // slide left of the obstacle
        { ...base, y: a.y - gap - s.height }, // slide above
        { ...base, y: bottomOf(a) + gap }, // slide below
      );
    }
    const rect = candidates.find((r) => containsRect(workArea, r) && !overlapsAny(r, avoid));
    if (rect) return { rect, placement: "right", scale, connector: null };
  }
  const scale = Math.min(SHRINK, fitScale(size, workArea, gap));
  return { rect: preferred(scaled(size, scale)), placement: "right", scale, connector: null };
}

export interface PointerPlacement {
  /** Tip start position: just beyond the display edge nearest to the target centre. */
  entry: Point;
  /** Tip position while tapping: target centre. */
  tap: Point;
  /** Tip position at rest: on the line entry→tap, `restGap` (8 DIP) outside the target bounds. */
  rest: Point;
  /** Degrees clockwise from "pointing right": direction from entry to tap. */
  angle: number;
  /** Approximate rect occupied by the resting pointer body (pointerSize square behind the tip), for label avoidance. */
  body: Rect;
}

/**
 * Where the pointer enters, taps and rests. `displayBounds` is the full display (entry is just
 * outside it, by pointerSize), `pointerSize` defaults to theme.pointerSize.
 * The glide is axis-aligned: the entry point shares the target centre's coordinate along the
 * nearest edge, so the pointer travels in a straight horizontal or vertical line.
 */
export function pointerPlacement(
  target: Rect,
  displayBounds: Rect,
  pointerSize: number = theme.pointerSize,
  /** Other displays' bounds: an entry point on a neighbouring display would glide across it. */
  otherDisplays: Rect[] = [],
  /** The pointer's previous angle: keep approaching from that side while it still works. */
  preferAngle?: number,
): PointerPlacement {
  const tap = center(target);
  const edges = [
    { d: tap.x - displayBounds.x, entry: { x: displayBounds.x - pointerSize, y: tap.y } },
    { d: rightOf(displayBounds) - tap.x, entry: { x: rightOf(displayBounds) + pointerSize, y: tap.y } },
    { d: tap.y - displayBounds.y, entry: { x: tap.x, y: displayBounds.y - pointerSize } },
    { d: bottomOf(displayBounds) - tap.y, entry: { x: tap.x, y: bottomOf(displayBounds) + pointerSize } },
  ].sort((a, b) => a.d - b.d);

  // Nearest edge first, but only where the resting pointer stays fully on the display (a target
  // hugging the left edge gets its pointer from another side instead of resting off-screen).
  const candidates = edges.map((e) => placeFrom(e.entry, tap, target, pointerSize));
  const onScreen = (c: PointerPlacement) => containsRect(displayBounds, c.body);
  const clearOfNeighbours = (c: PointerPlacement) => !otherDisplays.some((d) => containsPoint(d, c.entry));
  const sameSide = (c: PointerPlacement) => preferAngle !== undefined && Math.abs(c.angle - preferAngle) < 1;
  return (
    candidates.find((c) => sameSide(c) && onScreen(c) && clearOfNeighbours(c)) ??
    candidates.find((c) => onScreen(c) && clearOfNeighbours(c)) ??
    candidates.find(onScreen) ??
    candidates[0]!
  );
}

function placeFrom(entry: Point, tap: Point, target: Rect, pointerSize: number): PointerPlacement {
  const dx = tap.x - entry.x;
  const dy = tap.y - entry.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 0; // +0 normalises -0

  // Walk back from the tap point along the approach line until outside the target inflated by REST_GAP.
  const halfW = target.width / 2 + REST_GAP;
  const halfH = target.height / 2 + REST_GAP;
  const t = Math.min(ux !== 0 ? halfW / Math.abs(ux) : Infinity, uy !== 0 ? halfH / Math.abs(uy) : Infinity);
  const rest = { x: tap.x - ux * t, y: tap.y - uy * t };

  return { entry, tap, rest, angle, body: pointerBody(rest, angle, pointerSize) };
}

/** The resting pointer's body: a pointerSize square behind the tip, opposite the pointing direction. */
export function pointerBody(rest: Point, angle: number, pointerSize: number = theme.pointerSize): Rect {
  const rad = (angle * Math.PI) / 180;
  const cx = rest.x - (Math.cos(rad) * pointerSize) / 2;
  const cy = rest.y - (Math.sin(rad) * pointerSize) / 2;
  return { x: cx - pointerSize / 2, y: cy - pointerSize / 2, width: pointerSize, height: pointerSize };
}

/**
 * Centre for the small next-step hint pinned beside (never on top of) the target: left of the target
 * (vertically centred, 8 DIP gap) if it fits in the work area, else right, else above, else below.
 * When none fits, the left position is clamped into the work area.
 */
export function hintPlacement(
  target: Rect,
  workArea: Rect,
  badgeSize: number = theme.stepHintSize,
  /** Other controls (e.g. the guide's other steps) the hint must not cover, when possible. */
  avoid: Rect[] = [],
): Point {
  const c = center(target);
  const off = badgeSize / 2 + BADGE_GAP;
  const candidates: Point[] = [
    { x: target.x - off, y: c.y },
    { x: rightOf(target) + off, y: c.y },
    { x: c.x, y: target.y - off },
    { x: c.x, y: bottomOf(target) + off },
  ];
  const box = (p: Point): Rect => ({ x: p.x - badgeSize / 2, y: p.y - badgeSize / 2, width: badgeSize, height: badgeSize });
  const fits = (p: Point): boolean => containsRect(workArea, box(p));
  const found = candidates.find((p) => fits(p) && !overlapsAny(box(p), avoid)) ?? candidates.find(fits);
  if (found) return found;
  const h = badgeSize / 2;
  return {
    x: clamp(candidates[0]!.x, workArea.x + h, rightOf(workArea) - h),
    y: clamp(candidates[0]!.y, workArea.y + h, bottomOf(workArea) - h),
  };
}


export interface CardPlacementInput {
  /** The thing the card explains (card goes beside it), or null → centred-right of the screen. */
  anchor: Rect | null;
  /** The card's design size at an image scale (1 = normal pictures). */
  measure: (imageScale: number) => Size;
  /** Whether the card has pictures that can be made smaller. */
  hasImages: boolean;
  workArea: Rect;
  avoid: Rect[];
  /** Picture scale for the compact re-layout. */
  compactImageScale: number;
  /** The card's previous side (keep it while it still fits). */
  prefer?: Placement;
}

export interface CardPlacement {
  rect: Rect;
  placement: Placement;
  /** Whole-card scale (1, or less when nothing else fits). */
  scale: number;
  connector: Segment | null;
  imageScale: number;
  designSize: Size;
}

/**
 * Where an explainer card goes, keeping text at full size (fontMin) whenever possible:
 *  1. beside the anchor (placeBeside) — or centred-right when there is no anchor;
 *  2. if that had to shrink the card: re-lay it out with smaller pictures (compactImageScale);
 *  3. still shrunk and anchored: a full-size card in a corner with a connector beats a smaller
 *     card beside the anchor.
 */
export function placeCard(input: CardPlacementInput): CardPlacement {
  const { anchor, workArea, avoid } = input;
  const place = (size: Size): Omit<CardPlacement, "imageScale" | "designSize"> => {
    if (anchor) {
      const r = placeBeside({ target: anchor, size, workArea, avoid, ...(input.prefer ? { prefer: input.prefer } : {}) });
      return { rect: r.rect, placement: r.placement, scale: r.scale, connector: r.connector };
    }
    const r = placeCentredRight(size, workArea, avoid);
    return { rect: r.rect, placement: r.placement, scale: r.scale, connector: null };
  };
  let designSize = input.measure(1);
  let imageScale = 1;
  let placed = place(designSize);
  if (placed.scale < 1 && input.hasImages) {
    const compact = input.measure(input.compactImageScale);
    const retry = place(compact);
    if (retry.scale >= placed.scale) {
      placed = retry;
      imageScale = input.compactImageScale;
      designSize = compact;
    }
  }
  if (placed.scale < 1 && anchor) {
    const full = placeBeside({ target: anchor, size: designSize, workArea, avoid, allowShrink: false });
    if (full.scale === 1) placed = { rect: full.rect, placement: full.placement, scale: 1, connector: full.connector };
  }
  if (placed.scale < 1 && !anchor && fitScale(designSize, workArea, theme.edgeMargin) >= 1) {
    // No anchor: a full-size card in any free corner beats a smaller one centred-right.
    const corner = corners(designSize, workArea, theme.edgeMargin).find((c) => !overlapsAny(c, avoid));
    if (corner) placed = { rect: corner, placement: "corner", scale: 1, connector: null };
  }
  return { ...placed, imageScale, designSize };
}
