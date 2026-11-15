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
  it("varies the offer, mentions safety only for risky selections, never reuses wording", () => {
    const t = buildAssistantInstructions();
    expect(t).toContain("never reuse the wording of an earlier offer");
    expect(t).toMatch(/ONLY when the selection looks like an email/);
    expect(t).not.toContain("offers to check whether it is safe or to explain it");
  });
  it("answers pointer questions in words without drawing", () => {
    const t = buildAssistantInstructions();
    expect(t).toContain("[pointer]");
    expect(t).toMatch(/Do NOT draw or call tools unless they ask/);
  });
  it("keeps drawings to a minimum and aware of existing overlays", () => {
    const t = buildAssistantInstructions();
    expect(t).toContain("Answer in words by default");
    expect(t).toContain("FEWEST drawings: normally ONE");
    expect(t).toContain("at most 3 items");
    expect(t).toContain("Never stack a new drawing on top of an existing one");
    expect(t).toContain("[overlays]");
    expect(t).toContain("at most two drawings per answer");
    expect(t).not.toContain("Showing beats telling");
  });
});
