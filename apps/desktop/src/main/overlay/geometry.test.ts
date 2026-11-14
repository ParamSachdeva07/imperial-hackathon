import { describe, expect, it } from "vitest";
import {
  boundsOfPoints,
  bottomOf,
  center,
  containsPoint,
  containsRect,
  distance,
  inflate,
  intersection,
  intersects,
  nearestPointOnRect,
  rectsEqual,
  rightOf,
  translate,
  union,
} from "./geometry";

const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("geometry", () => {
  it("rightOf/bottomOf/center", () => {
    expect(rightOf(r(10, 20, 30, 40))).toBe(40);
    expect(bottomOf(r(10, 20, 30, 40))).toBe(60);
    expect(center(r(10, 20, 30, 40))).toEqual({ x: 25, y: 40 });
  });
  it("intersects requires positive area", () => {
    expect(intersects(r(0, 0, 10, 10), r(5, 5, 10, 10))).toBe(true);
    expect(intersects(r(0, 0, 10, 10), r(10, 0, 10, 10))).toBe(false);
    expect(intersects(r(0, 0, 10, 10), r(0, 10, 10, 10))).toBe(false);
    expect(intersects(r(0, 0, 10, 10), r(20, 20, 5, 5))).toBe(false);
    expect(intersects(r(0, 0, 10, 10), r(2, 2, 3, 3))).toBe(true);
  });
  it("intersection", () => {
    expect(intersection(r(0, 0, 10, 10), r(5, 5, 10, 10))).toEqual(r(5, 5, 5, 5));
    expect(intersection(r(0, 0, 10, 10), r(10, 0, 10, 10))).toBeNull();
    expect(intersection(r(-10, -10, 5, 5), r(0, 0, 5, 5))).toBeNull();
  });
  it("containsRect allows touching edges", () => {
    expect(containsRect(r(0, 0, 10, 10), r(0, 0, 10, 10))).toBe(true);
    expect(containsRect(r(0, 0, 10, 10), r(1, 1, 5, 5))).toBe(true);
    expect(containsRect(r(0, 0, 10, 10), r(5, 5, 6, 5))).toBe(false);
    expect(containsRect(r(0, 0, 10, 10), r(-1, 0, 5, 5))).toBe(false);
  });
  it("containsPoint is edge inclusive", () => {
    expect(containsPoint(r(0, 0, 10, 10), { x: 10, y: 10 })).toBe(true);
    expect(containsPoint(r(0, 0, 10, 10), { x: 0, y: 0 })).toBe(true);
    expect(containsPoint(r(0, 0, 10, 10), { x: 10.1, y: 5 })).toBe(false);
  });
  it("inflate grows/shrinks, optional dy", () => {
    expect(inflate(r(10, 10, 20, 20), 5)).toEqual(r(5, 5, 30, 30));
    expect(inflate(r(10, 10, 20, 20), 5, 2)).toEqual(r(5, 8, 30, 24));
    expect(inflate(r(10, 10, 20, 20), -5)).toEqual(r(15, 15, 10, 10));
  });
  it("union / translate", () => {
    expect(union(r(0, 0, 10, 10), r(20, 5, 10, 10))).toEqual(r(0, 0, 30, 15));
    expect(translate(r(1, 2, 3, 4), 10, -5)).toEqual(r(11, -3, 3, 4));
  });
  it("boundsOfPoints, min 1x1", () => {
    expect(
      boundsOfPoints([
        { x: 5, y: 5 },
        { x: 15, y: 25 },
        { x: -5, y: 10 },
      ]),
    ).toEqual(r(-5, 5, 20, 20));
    expect(boundsOfPoints([{ x: 3, y: 4 }])).toEqual(r(3, 4, 1, 1));
    expect(
      boundsOfPoints([
        { x: 3, y: 4 },
        { x: 3, y: 9 },
      ]),
    ).toEqual(r(3, 4, 1, 5));
    expect(boundsOfPoints([])).toEqual(r(0, 0, 1, 1));
  });
  it("nearestPointOnRect", () => {
    const box = r(10, 10, 10, 10);
    expect(nearestPointOnRect(box, { x: 15, y: 15 })).toEqual({ x: 15, y: 15 });
    expect(nearestPointOnRect(box, { x: 0, y: 15 })).toEqual({ x: 10, y: 15 });
    expect(nearestPointOnRect(box, { x: 100, y: 100 })).toEqual({ x: 20, y: 20 });
    expect(nearestPointOnRect(box, { x: 15, y: -5 })).toEqual({ x: 15, y: 10 });
  });
  it("distance", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
  it("rectsEqual with tolerance", () => {
    expect(rectsEqual(r(0, 0, 10, 10), r(0.4, 0.4, 9.6, 9.6))).toBe(true);
    expect(rectsEqual(r(0, 0, 10, 10), r(1, 0, 10, 10))).toBe(false);
    expect(rectsEqual(r(0, 0, 10, 10), r(0, 0, 11, 10))).toBe(false);
    expect(rectsEqual(r(0, 0, 10, 10), r(0.9, 0, 10, 10), 1)).toBe(true);
  });
});
