import { describe, expect, it } from "vitest";
import { lineCount, measureCard, measureLabel } from "./measure";
import { theme } from "./theme";

describe("measure", () => {
  it("counts wrapped lines", () => {
    expect(lineCount("", 24, 200)).toBe(1);
    expect(lineCount("short", 24, 400)).toBe(1);
    // 24 px * 0.56 ≈ 13.4 px/char → 100 px ≈ 7 chars per line
    expect(lineCount("aaaa bbbb cccc", 24, 100)).toBe(3);
    expect(lineCount("a".repeat(20), 24, 100)).toBe(3); // hard wrap of a long word
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
});
