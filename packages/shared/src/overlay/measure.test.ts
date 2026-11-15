import { describe, expect, it } from "vitest";
import { CARD, lineCount, measureCard, measureLabel, verdictBodyHeight } from "./measure";
import { theme } from "./theme";

describe("measure", () => {
  it("counts wrapped lines", () => {
    expect(lineCount("", 24, 200)).toBe(1);
    expect(lineCount("short", 24, 400)).toBe(1);
    // lowercase ≈ 14 px/char at 24 px → 100 px ≈ 7 chars per line
    expect(lineCount("aaaa bbbb cccc", 24, 100)).toBe(3);
    expect(lineCount("a".repeat(20), 24, 100)).toBeGreaterThanOrEqual(3); // hard wrap of a long word
    expect(lineCount("WWWW WWWW", 24, 100)).toBe(2); // capitals are wider than lowercase
  });

  it("labels respect the max width and grow in height when wrapping", () => {
    const one = measureLabel("Send");
    const long = measureLabel("This is a very long caption that will certainly need to wrap");
    expect(one.height).toBeGreaterThanOrEqual(theme.fontMin.label);
    expect(long.width).toBeLessThanOrEqual(440);
    expect(long.height).toBeGreaterThan(one.height);
    expect(measureLabel("Send", true).width).toBeGreaterThan(one.width);
  });

  it("cards are cardMaxWidth wide", () => {
    const size = measureCard("Title", { kind: "sequence", steps: [{ icon: "click", caption: "a" }, { icon: "send", caption: "b" }] });
    expect(size.width).toBe(theme.cardMaxWidth);
    expect(size.height).toBeGreaterThan(100);
  });

  it("verdict cards measure the headline (glyph inline) plus one row per reason, with no standalone glyph tile (never 0)", () => {
    const one = measureCard("Looks safe", { kind: "verdict", tone: "success", reasons: ["Known sender"] });
    const three = measureCard("Likely a scam", { kind: "verdict", tone: "warning", reasons: ["Fake sender", "Threatens you", "Odd link"] });
    expect(one.width).toBe(theme.cardMaxWidth);
    expect(one.height).toBeGreaterThan(2 * CARD.pad);
    // Short headline + one reason: pad + one title line + gap + one bullet row + pad. The glyph is inline, so no CARD.tile of extra height.
    expect(one.height).toBe(2 * CARD.pad + CARD.titleLineHeight + CARD.gap + CARD.bodyLineHeight);
    expect(verdictBodyHeight(["a", "b"])).toBe(2 * CARD.bodyLineHeight + CARD.rowGap);
    expect(three.height).toBeGreaterThan(one.height);
    const wrapped = measureCard("Likely a scam", { kind: "verdict", tone: "warning", reasons: ["x ".repeat(29).trim(), "b", "c"] });
    expect(wrapped.height).toBeGreaterThan(three.height);
  });
});
