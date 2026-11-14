import { describe, expect, it } from "vitest";
import { theme } from "@pointy/shared/overlay";
import type { Rect } from "@pointy/shared/overlay";
import {
  badgePlacement,
  connectorBetween,
  placeBeside,
  placeCentredRight,
  pointerPlacement,
} from "./LayoutEngine";
import { containsPoint, containsRect, intersects } from "./geometry";

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const wa = r(0, 0, 1000, 800);

describe("placeBeside: placement order", () => {
  const target = r(400, 350, 100, 100); // centre (450, 400)
  const size = { width: 200, height: 100 };

  it("prefers right, centred vertically, with the default gap", () => {
    const res = placeBeside({ target, size, workArea: wa });
    expect(res.placement).toBe("right");
    expect(res.scale).toBe(1);
    expect(res.rect).toEqual(r(524, 350, 200, 100));
  });

  it("uses a custom gap", () => {
    const res = placeBeside({ target, size, workArea: wa, gap: 10 });
    expect(res.rect.x).toBe(510);
  });

  it("falls to left when right is blocked by an avoid rect", () => {
    const res = placeBeside({ target, size, workArea: wa, avoid: [r(500, 300, 300, 200)] });
    expect(res.placement).toBe("left");
    expect(res.rect).toEqual(r(176, 350, 200, 100));
  });

  it("falls to left when right does not fit in the work area", () => {
    const res = placeBeside({ target: r(800, 350, 100, 100), size, workArea: wa });
    expect(res.placement).toBe("left");
    expect(res.rect.x).toBe(800 - 24 - 200);
  });

  it("falls to below, centred on the target and slid inside the work area", () => {
    const wide = r(100, 300, 800, 100);
    const res = placeBeside({ target: wide, size, workArea: wa });
    expect(res.placement).toBe("below");
    expect(res.rect).toEqual(r(400, 424, 200, 100));
  });

  it("falls to above when below is blocked", () => {
    const wide = r(100, 300, 800, 100);
    const res = placeBeside({ target: wide, size, workArea: wa, avoid: [r(0, 400, 1000, 200)] });
    expect(res.placement).toBe("above");
    expect(res.rect).toEqual(r(400, 176, 200, 100));
  });

  it("an avoid rect that merely touches the box does not block it", () => {
    const res = placeBeside({ target, size, workArea: wa, avoid: [r(724, 350, 50, 100)] });
    expect(res.placement).toBe("right");
  });

  it("a candidate that would overlap the target is rejected", () => {
    // target fills the work area vertically and is wide: right/left do not fit, below/above neither
    const res = placeBeside({ target: r(0, 0, 1000, 800), size, workArea: wa });
    expect(res.placement).toBe("corner");
  });
});

describe("placeBeside: cross-axis sliding", () => {
  const size = { width: 200, height: 100 };

  it("slides down when the centred box would stick out of the top", () => {
    const res = placeBeside({ target: r(400, 0, 100, 50), size, workArea: wa });
    expect(res.placement).toBe("right");
    expect(res.rect.y).toBe(0);
  });

  it("slides up when the centred box would stick out of the bottom", () => {
    const res = placeBeside({ target: r(400, 760, 100, 40), size, workArea: wa });
    expect(res.placement).toBe("right");
    expect(res.rect.y).toBe(700);
  });

  it("respects a work area with a non-zero origin (menu bar / dock)", () => {
    const area = r(0, 25, 1000, 775);
    const res = placeBeside({ target: r(400, 25, 100, 20), size, workArea: area });
    expect(res.rect.y).toBe(25);
  });

  it("slides horizontally for below/above placements", () => {
    // target hugging the right edge, tall: right impossible, left blocked, below slides left
    const target = r(900, 100, 100, 300);
    const res = placeBeside({ target, size, workArea: wa, avoid: [r(600, 50, 250, 300)] });
    expect(res.placement).toBe("below");
    expect(res.rect.x).toBe(800); // clamped so right edge == 1000
    expect(res.rect.y).toBe(424);
  });
});

describe("placeBeside: shrink and corner fallbacks", () => {
  const target = r(400, 350, 100, 100);

  it("shrinks to 80% before resorting to a corner", () => {
    const size = { width: 520, height: 340 };
    const res = placeBeside({ target, size, workArea: wa });
    expect(res.placement).toBe("right");
    expect(res.scale).toBe(0.8);
    expect(res.rect.width).toBeCloseTo(416);
    expect(res.rect.height).toBeCloseTo(272);
    expect(res.rect.x).toBe(524);
  });

  it("with allowShrink:false goes straight to a corner at full size", () => {
    const size = { width: 520, height: 340 };
    const res = placeBeside({ target, size, workArea: wa, allowShrink: false });
    expect(res.placement).toBe("corner");
    expect(res.scale).toBe(1);
    expect(res.rect).toEqual(r(456, 24, 520, 340));
  });

  it("picks the corner farthest from the target, at the shrunk size", () => {
    const big = r(50, 50, 700, 500); // centre (400, 300)
    const res = placeBeside({ target: big, size: { width: 400, height: 300 }, workArea: wa });
    expect(res.placement).toBe("corner");
    expect(res.scale).toBe(0.8);
    expect(res.rect).toEqual(r(656, 536, 320, 240));
  });

  it("prefers corners that do not overlap avoid rects", () => {
    const size = { width: 520, height: 340 };
    const res = placeBeside({ target, size, workArea: wa, allowShrink: false, avoid: [r(900, 0, 100, 200)] });
    expect(res.placement).toBe("corner");
    expect(res.rect).toEqual(r(456, 436, 520, 340)); // bottom-right, next farthest free corner
  });

  it("falls back to the farthest corner when every corner overlaps an avoid rect", () => {
    const size = { width: 520, height: 340 };
    const res = placeBeside({ target, size, workArea: wa, allowShrink: false, avoid: [r(0, 0, 1000, 800)] });
    expect(res.placement).toBe("corner");
    expect(res.rect).toEqual(r(456, 24, 520, 340));
  });

  it("never picks a corner covering the target when a target-free corner exists", () => {
    // Target fills the left half; the avatar avoid rect fills the right half, so no side fits and
    // every corner either covers the target (left) or the avatar (right). Covering the avatar wins:
    // never cover the thing being explained.
    const half = r(0, 0, 500, 800);
    const res = placeBeside({ target: half, size: { width: 250, height: 200 }, workArea: wa, allowShrink: false, avoid: [r(520, 0, 480, 800)] });
    expect(res.placement).toBe("corner");
    expect(res.rect).toEqual(r(726, 24, 250, 200));
  });

  it("insets corners by the gap", () => {
    const res = placeBeside({
      target: r(0, 0, 1000, 800),
      size: { width: 100, height: 100 },
      workArea: wa,
      gap: 10,
      allowShrink: false,
    });
    expect(res.placement).toBe("corner");
    expect(containsRect(r(10, 10, 980, 780), res.rect)).toBe(true);
  });

  it("corner connector reaches the target", () => {
    const res = placeBeside({ target: r(50, 50, 700, 500), size: { width: 400, height: 300 }, workArea: wa });
    expect(containsPoint(r(50, 50, 700, 500), res.connector.to)).toBe(true);
  });

  it("never overlaps the target or avoid rects in side placements", () => {
    const avoid = [r(0, 0, 300, 300)];
    const res = placeBeside({ target, size: { width: 200, height: 100 }, workArea: wa, avoid });
    expect(intersects(res.rect, target)).toBe(false);
    expect(intersects(res.rect, avoid[0]!)).toBe(false);
  });
});

describe("connectorBetween", () => {
  it("right-placed box: left edge midpoint to the target's nearest point", () => {
    const seg = connectorBetween(r(524, 350, 200, 100), r(400, 350, 100, 100));
    expect(seg).toEqual({ from: { x: 524, y: 400 }, to: { x: 500, y: 400 } });
  });
  it("left-placed box: right edge midpoint", () => {
    const seg = connectorBetween(r(0, 0, 100, 100), r(300, 20, 50, 50));
    expect(seg).toEqual({ from: { x: 100, y: 50 }, to: { x: 300, y: 50 } });
  });
  it("below-placed box: top edge midpoint", () => {
    const seg = connectorBetween(r(400, 424, 200, 100), r(100, 300, 800, 100));
    expect(seg).toEqual({ from: { x: 500, y: 424 }, to: { x: 500, y: 400 } });
  });
  it("above-placed box: bottom edge midpoint", () => {
    const seg = connectorBetween(r(400, 176, 200, 100), r(100, 300, 800, 100));
    expect(seg).toEqual({ from: { x: 500, y: 276 }, to: { x: 500, y: 300 } });
  });
  it("targets offset from the box centre use the nearest point on the target", () => {
    const seg = connectorBetween(r(0, 0, 100, 100), r(300, 80, 50, 200));
    expect(seg.from).toEqual({ x: 100, y: 50 });
    expect(seg.to).toEqual({ x: 300, y: 80 });
  });
});

describe("placeCentredRight", () => {
  const size = { width: 400, height: 300 };

  it("is vertically centred and right-aligned by the gap", () => {
    const res = placeCentredRight(size, wa);
    expect(res.rect).toEqual(r(576, 250, 400, 300));
    expect(res.scale).toBe(1);
    expect(res.connector).toBeNull();
  });

  it("honours the work area origin", () => {
    const res = placeCentredRight(size, r(100, 25, 1000, 775), [], 20);
    expect(res.rect).toEqual(r(680, 262.5, 400, 300));
  });

  it("slides left of an avoid rect", () => {
    const res = placeCentredRight(size, wa, [r(500, 200, 400, 400)]);
    expect(res.rect).toEqual(r(76, 250, 400, 300));
  });

  it("slides vertically when sliding left is not possible", () => {
    // obstacle spans the whole width on the lower half: go above
    const res = placeCentredRight(size, wa, [r(0, 400, 1000, 400)]);
    expect(res.rect.y).toBe(400 - 24 - 300);
    expect(res.rect.x).toBe(576);
  });

  it("shrinks to 80% when full size cannot avoid the obstacles", () => {
    const res = placeCentredRight(size, wa, [r(0, 300, 1000, 200)]);
    expect(res.scale).toBe(0.8);
    expect(res.rect).toEqual(r(656, 36, 320, 240));
  });

  it("gives the shrunk preferred spot when nothing avoids the obstacles", () => {
    const res = placeCentredRight(size, wa, [r(0, 0, 1000, 800)]);
    expect(res.scale).toBe(0.8);
    expect(res.rect).toEqual(r(656, 280, 320, 240));
  });
});

describe("pointerPlacement", () => {
  const display = r(0, 0, 1000, 800);

  it("enters from the left for a target near the left edge", () => {
    const p = pointerPlacement(r(150, 380, 100, 40), display);
    expect(p.entry).toEqual({ x: -96, y: 400 });
    expect(p.tap).toEqual({ x: 200, y: 400 });
    expect(p.rest).toEqual({ x: 142, y: 400 });
    expect(p.angle).toBe(0);
    expect(p.body).toEqual(r(46, 352, 96, 96));
  });

  it("enters from the right (pointing left)", () => {
    const p = pointerPlacement(r(750, 380, 100, 40), display);
    expect(p.entry).toEqual({ x: 1096, y: 400 });
    expect(p.rest).toEqual({ x: 858, y: 400 });
    expect(p.angle).toBe(180);
    expect(p.body).toEqual(r(858, 352, 96, 96));
  });

  it("enters from the top (pointing down)", () => {
    const p = pointerPlacement(r(480, 120, 40, 100), display);
    expect(p.entry).toEqual({ x: 500, y: -96 });
    expect(p.rest).toEqual({ x: 500, y: 112 });
    expect(p.angle).toBe(90);
    expect(p.body).toEqual(r(452, 16, 96, 96));
  });

  it("enters from the bottom (pointing up)", () => {
    const p = pointerPlacement(r(480, 580, 40, 100), display);
    expect(p.entry).toEqual({ x: 500, y: 896 });
    expect(p.rest).toEqual({ x: 500, y: 688 });
    expect(p.angle).toBe(-90);
  });

  it("a target hugging an edge gets its pointer from another side, so it never rests off-screen", () => {
    const hug = r(5, 380, 100, 40); // nearest edge is left, but there is no room left of it
    const p = pointerPlacement(hug, display);
    expect(p.entry.x).not.toBe(-96); // not from the left edge
    expect(p.angle).toBe(90); // the next-nearest edge with room: the top
    expect(containsRect(display, p.body)).toBe(true);
  });

  it("does not enter across a neighbouring display", () => {
    const left = r(-1000, 0, 1000, 800);
    const p = pointerPlacement(r(150, 380, 100, 40), display, 96, [left]); // nearest edge (left) borders `left`
    expect(containsPoint(left, p.entry)).toBe(false);
    expect(p.angle).not.toBe(0);
  });

  it("works on a display with a negative origin", () => {
    const neg = r(-1920, -200, 1920, 1080);
    const target = r(-1750, 0, 100, 50);
    const p = pointerPlacement(target, neg);
    expect(p.entry).toEqual({ x: -2016, y: 25 });
    expect(containsPoint(neg, p.entry)).toBe(false);
    expect(containsPoint(target, p.rest)).toBe(false);
    expect(p.rest).toEqual({ x: -1758, y: 25 });
    expect(p.angle).toBe(0);
    expect(containsRect(neg, p.body)).toBe(true);
  });

  it("negative origin above the primary: enters from the top edge", () => {
    const neg = r(0, -1080, 1920, 1080);
    const target = r(900, -960, 100, 40);
    const p = pointerPlacement(target, neg);
    expect(p.entry.y).toBe(-1080 - 96);
    expect(p.angle).toBe(90);
  });

  it("entry is always outside the display and rest outside the target (even in corners)", () => {
    const targets = [r(5, 5, 30, 30), r(960, 5, 30, 30), r(5, 760, 30, 30), r(960, 760, 30, 30), r(480, 380, 40, 40)];
    for (const t of targets) {
      const p = pointerPlacement(t, display);
      expect(containsPoint(display, p.entry)).toBe(false);
      expect(containsPoint(t, p.rest)).toBe(false);
      expect(containsPoint(t, p.tap)).toBe(true);
      const expected = (Math.atan2(p.tap.y - p.entry.y, p.tap.x - p.entry.x) * 180) / Math.PI;
      expect(p.angle).toBeCloseTo(expected);
    }
  });

  it("rest lies on the entry→tap line", () => {
    const p = pointerPlacement(r(150, 380, 100, 40), display);
    expect(p.rest.y).toBe(p.entry.y);
  });

  it("supports a custom pointer size", () => {
    const p = pointerPlacement(r(100, 380, 100, 40), display, 50);
    expect(p.entry.x).toBe(-50);
    expect(p.body.width).toBe(50);
  });

  it("small targets rest 8 DIP outside", () => {
    const p = pointerPlacement(r(496, 396, 8, 8), display);
    expect(p.entry).toEqual({ x: 500, y: -96 });
    expect(p.rest).toEqual({ x: 500, y: 400 - 4 - 8 });
  });
});

describe("placeBeside: oversized boxes", () => {
  it("scales a box taller than the work area down until it fits", () => {
    const res = placeBeside({ target: r(400, 350, 100, 100), size: { width: 520, height: 1037 }, workArea: r(0, 0, 1000, 800) });
    expect(containsRect(r(0, 0, 1000, 800), res.rect)).toBe(true);
    expect(res.scale).toBeLessThan(0.8);
  });
});

describe("badgePlacement", () => {
  it("does not cover a neighbouring control when another side is free", () => {
    const left = r(100, 300, 80, 40);
    const me = r(190, 300, 80, 40); // a badge on my left would cover `left`
    const p = badgePlacement(me, wa, 40, [left]);
    const box = r(p.x - 20, p.y - 20, 40, 40);
    expect(intersects(box, left)).toBe(false);
  });

  it("left of the target, vertically centred, 8 DIP gap", () => {
    const p = badgePlacement(r(200, 300, 100, 50), wa, 40);
    expect(p).toEqual({ x: 200 - 8 - 20, y: 325 });
  });
  it("defaults to the theme badge size", () => {
    const p = badgePlacement(r(200, 300, 100, 50), wa);
    expect(p.x).toBe(200 - 8 - theme.stepBadgeSize / 2);
  });
  it("falls back to right when left does not fit", () => {
    const p = badgePlacement(r(10, 300, 100, 50), wa, 40);
    expect(p).toEqual({ x: 110 + 28, y: 325 });
  });
  it("falls back to above when neither side fits", () => {
    const p = badgePlacement(r(0, 300, 1000, 50), wa, 40);
    expect(p).toEqual({ x: 500, y: 300 - 28 });
  });
  it("falls back to below when above does not fit either", () => {
    const p = badgePlacement(r(0, 0, 1000, 50), wa, 40);
    expect(p).toEqual({ x: 500, y: 50 + 28 });
  });
  it("clamps into the work area when nothing fits", () => {
    const p = badgePlacement(r(0, 0, 1000, 800), wa, 40);
    expect(p).toEqual({ x: 20, y: 400 });
  });
  it("respects a work area with a top inset", () => {
    const area = r(0, 25, 1000, 775);
    const p = badgePlacement(r(0, 25, 1000, 40), area, 40);
    expect(p.y).toBe(25 + 40 + 28);
  });
});
