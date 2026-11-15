import { describe, expect, it } from "vitest";
import { type BgraImage, dimOutside, drawMarker, drawPolyline, WHITE } from "./annotate";

function img(w: number, h: number, v = 200): BgraImage {
  const data = Buffer.alloc(w * h * 4, v);
  return { data, width: w, height: h };
}
const px = (i: BgraImage, x: number, y: number): number[] => [...i.data.subarray((y * i.width + x) * 4, (y * i.width + x) * 4 + 4)];

describe("dimOutside", () => {
  it("dims outside a rect and leaves inside untouched", () => {
    const i = img(10, 10);
    dimOutside(i, { rect: { x: 2, y: 2, width: 4, height: 4 } }, 0.5);
    expect(px(i, 3, 3)).toEqual([200, 200, 200, 200]);
    expect(px(i, 0, 0)).toEqual([100, 100, 100, 200]);
    expect(px(i, 6, 3)[0]).toBe(100);
    expect(px(i, 3, 6)[0]).toBe(100);
  });
  it("dims outside a polygon (even-odd)", () => {
    const i = img(20, 20);
    dimOutside(i, { polygon: [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }] }, 0.5);
    expect(px(i, 10, 10)[0]).toBe(200);
    expect(px(i, 2, 10)[0]).toBe(100);
    expect(px(i, 17, 10)[0]).toBe(100);
    expect(px(i, 10, 2)[0]).toBe(100);
  });
  it("dims everything for an off-image shape", () => {
    const i = img(4, 4);
    dimOutside(i, { rect: { x: 50, y: 50, width: 5, height: 5 } }, 0.5);
    expect(px(i, 1, 1)[0]).toBe(100);
  });
});

describe("drawPolyline", () => {
  it("sets outline pixels with a white core and leaves the interior", () => {
    const i = img(30, 30, 100);
    drawPolyline(i, [{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 25 }, { x: 5, y: 25 }], { closed: true });
    expect(px(i, 15, 5)).toEqual([255, 255, 255, 255]);
    expect(px(i, 5, 15)).toEqual([255, 255, 255, 255]);
    expect(px(i, 15, 15)[0]).toBe(100);
    expect(px(i, 15, 7)[0]).toBe(28); // dark edge (b channel)
  });
  it("leaves the closing edge open when closed is false", () => {
    const i = img(30, 30, 100);
    drawPolyline(i, [{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 25 }], { closed: false });
    expect(px(i, 15, 15)[0]).toBe(100);
  });
});

describe("drawMarker", () => {
  it("draws a hollow ring centred on the point", () => {
    const i = img(60, 60, 100);
    drawMarker(i, 30, 30, { radius: 15 });
    expect(px(i, 30, 30)[0]).toBe(100); // centre left untouched (label stays readable)
    expect(px(i, 45, 30)).toEqual([WHITE.b, WHITE.g, WHITE.r, 255]); // ring core
    expect(px(i, 38, 30)[0]).toBe(100); // between dot and ring
    expect(px(i, 30, 15)[0]).toBe(255);
  });
});
