import { describe, expect, it } from "vitest";
import { chooseAvatarPosition, cornerTopLeft } from "./avatarPlacement";

const WA = { x: 0, y: 25, width: 1440, height: 875 };
const avatar = { x: 1096, y: 49, width: 320, height: 400 }; // top-right, 24 from the edges

describe("chooseAvatarPosition", () => {
  it("places each named corner inset by the margin", () => {
    const at = (position: "top_left" | "top_right" | "bottom_left" | "bottom_right") => chooseAvatarPosition({ avatar, workArea: WA, position, avoid: [] });
    expect(at("top_left")).toEqual({ x: 24, y: 49 });
    expect(at("top_right")).toEqual({ x: 1096, y: 49 });
    expect(at("bottom_left")).toEqual({ x: 24, y: 476 });
    expect(at("bottom_right")).toEqual({ x: 1096, y: 476 });
  });

  it("honours a custom margin and never leaves the work area", () => {
    expect(chooseAvatarPosition({ avatar, workArea: WA, position: "top_left", avoid: [], margin: 0 })).toEqual({ x: 0, y: 25 });
    const huge = { x: 0, y: 0, width: 2000, height: 2000 };
    expect(cornerTopLeft(huge, WA, "bottom_right", 24)).toEqual({ x: WA.x, y: WA.y });
  });

  it("works on a display with a negative origin", () => {
    const left = { x: -1920, y: -200, width: 1920, height: 1080 };
    expect(chooseAvatarPosition({ avatar, workArea: left, position: "bottom_right", avoid: [] })).toEqual({ x: -344, y: 456 });
  });

  it("auto: stays put when the current spot is clear", () => {
    const avoid = [{ x: 100, y: 300, width: 200, height: 50 }];
    expect(chooseAvatarPosition({ avatar, workArea: WA, position: "auto", avoid })).toEqual({ x: 1096, y: 49 });
    expect(chooseAvatarPosition({ avatar, workArea: WA, position: "auto", avoid: [] })).toEqual({ x: 1096, y: 49 });
  });

  it("auto: leaves a covered spot for the corner with least overlap", () => {
    // Target under the avatar (top-right); bottom-left corner is the farthest clear one.
    const avoid = [{ x: 1200, y: 100, width: 120, height: 40 }];
    expect(chooseAvatarPosition({ avatar, workArea: WA, position: "auto", avoid })).toEqual({ x: 24, y: 476 });
  });

  it("auto: prefers a clear corner over one that overlaps, even when it is nearer", () => {
    const avoid = [
      { x: 1200, y: 100, width: 120, height: 40 }, // under the avatar now
      { x: 40, y: 500, width: 200, height: 60 }, // blocks bottom-left
    ];
    const p = chooseAvatarPosition({ avatar, workArea: WA, position: "auto", avoid });
    expect([p.x, p.y]).not.toEqual([24, 451]);
    expect([p.x, p.y]).not.toEqual([1096, 49]);
  });

  it("auto: when every corner overlaps, takes the smallest overlap", () => {
    const small = { x: 1100, y: 60, width: 20, height: 20 };
    const big = { x: 0, y: 25, width: 1440, height: 875 };
    // Avatar overlaps `big` everywhere; all four corners overlap `big` equally (full avatar area),
    // so the extra `small` rect decides: any corner except top-right wins.
    const p = chooseAvatarPosition({ avatar, workArea: WA, position: "auto", avoid: [big, small] });
    expect(p).not.toEqual({ x: 1096, y: 49 });
  });
});
