import { describe, expect, it } from "vitest";
import { buildInstructions } from "./realtimeSession";

describe("instructions", () => {
  it("include the selection rule", () => {
    const text = buildInstructions({ listElements: () => [], getDisplays: () => [], primaryDisplayId: () => "1", pregeneratedImagePrompts: async () => [] });
    expect(text).toContain("[selection]");
    expect(text).toContain("close-up");
    expect(text).toContain("highlight");
  });
});
