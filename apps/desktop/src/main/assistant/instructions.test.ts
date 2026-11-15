import { describe, expect, it } from "vitest";
import { buildAssistantInstructions } from "./instructions";

describe("assistant instructions", () => {
  it("do not push pictures when images are off (default)", () => {
    for (const text of [buildAssistantInstructions(), buildAssistantInstructions({ images: false })]) {
      expect(text).toContain("pictures are off");
      expect(text).toContain("never concept or compare");
      expect(text).not.toContain("a picture only when it explains better");
    }
  });
  it("keep the picture guidance when images are on", () => {
    const text = buildAssistantInstructions({ images: true });
    expect(text).toContain("a picture only when it explains better than words");
    expect(text).not.toContain("pictures are off");
  });
});
