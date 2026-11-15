import { describe, expect, it } from "vitest";
import { FalClient, type ImageSource } from "./explainer/falClient";
import { imagesEnabled, resolveImageSource } from "./imagesFlag";

describe("POINTY_IMAGES flag", () => {
  it("is off unless exactly 1", () => {
    expect(imagesEnabled({})).toBe(false);
    expect(imagesEnabled({ POINTY_IMAGES: "" })).toBe(false);
    expect(imagesEnabled({ POINTY_IMAGES: "0" })).toBe(false);
    expect(imagesEnabled({ POINTY_IMAGES: "1" })).toBe(true);
  });

  it("creates no ImageSource by default, even with an assetsDir (no broker calls, no pregenerated assets)", () => {
    expect(resolveImageSource({ assetsDir: "/a" })).toBeUndefined();
    expect(resolveImageSource({ images: false, assetsDir: "/a" })).toBeUndefined();
  });

  it("creates the FalClient only when images are on and an assetsDir is given", () => {
    expect(resolveImageSource({ images: true, assetsDir: "/a" })).toBeInstanceOf(FalClient);
    expect(resolveImageSource({ images: true })).toBeUndefined();
  });

  it("an explicit imageSource always wins", () => {
    const src: ImageSource = { getImage: async () => ({ ok: false }) } as unknown as ImageSource;
    expect(resolveImageSource({ imageSource: src })).toBe(src);
  });
});
