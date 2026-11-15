import { describe, expect, it } from "vitest";
import { buildInstructions } from "./realtimeSession";

describe("instructions", () => {
  it("include the selection rule", () => {
    const text = buildInstructions({ listElements: () => [], getDisplays: () => [], primaryDisplayId: () => "1", pregeneratedImagePrompts: async () => [] });
    expect(text).toContain("[selection]");
    expect(text).toContain("close-up");
    expect(text).toContain("highlight");
  });

  const base = { listElements: () => [], getDisplays: () => [], primaryDisplayId: () => "1", pregeneratedImagePrompts: async () => [] };
  it("tell the model pictures are off by default, and allow them with images", () => {
    expect(buildInstructions(base)).toContain("pictures are off");
    expect(buildInstructions(base)).not.toContain("show a picture card");
    expect(buildInstructions({ ...base, images: true })).toContain("show a picture card");
  });
});
