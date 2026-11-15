import { describe, expect, it } from "vitest";
import { SentenceBatcher } from "./sentenceBatcher";
import { estimateSpeakMs } from "./speechEstimate";

describe("SentenceBatcher", () => {
  it("emits the first sentence as soon as it is long enough and complete", () => {
    const b = new SentenceBatcher();
    expect(b.push("Sure, I can help")).toEqual([]);
    expect(b.push(" you.")).toEqual([]); // no whitespace after the period yet
    expect(b.push(" Click the")).toEqual(["Sure, I can help you. "]);
    expect(b.flush()).toBe("Click the");
  });

  it("starts the first chunk after the 6th word when no sentence end has arrived", () => {
    const b = new SentenceBatcher();
    expect(b.push("One two three four five six")).toEqual([]); // no whitespace after the 6th word yet
    expect(b.push(" seven eight")).toEqual(["One two three four five six "]);
    expect(b.flush()).toBe("seven eight");
  });

  it("does not split on decimals or short fragments", () => {
    const b = new SentenceBatcher();
    expect(b.push("It costs 3.5 pounds today and tomorrow too. ")).toEqual(["It costs 3.5 pounds today and tomorrow too. "]);
    expect(b.push("Ok. Yes. ")).toEqual([]); // under minChars: held to join with the next sentence
    expect(b.flush()).toBe("Ok. Yes.");
  });

  it("joins short sentences until minChars", () => {
    const b = new SentenceBatcher({ firstMinChars: 5, minChars: 30 });
    const out = b.push("First one here. Second. Third sentence is longer than the rest. tail");
    expect(out).toEqual(["First one here. ", "Second. Third sentence is longer than the rest. "]);
    expect(b.flush()).toBe("tail");
  });

  it("force-cuts overlong text without punctuation at a space", () => {
    const b = new SentenceBatcher({ maxChars: 20 });
    const out = b.push("word ".repeat(10));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.length <= 20)).toBe(true);
  });

  it("chunks concatenate back to the original text (no fused words)", () => {
    const text = "Click the green Send button at the top. Then press Enter to confirm it all now. " + "word ".repeat(30) + "end";
    const b = new SentenceBatcher({ maxChars: 40 });
    let joined = "";
    for (let i = 0; i < text.length; i += 7) joined += b.push(text.slice(i, i + 7)).join("");
    joined += b.flush();
    expect(joined).toBe(text);
  });

  it("flush resets and reset drops", () => {
    const b = new SentenceBatcher();
    b.push("hello there");
    b.reset();
    expect(b.flush()).toBe("");
  });
});

describe("estimateSpeakMs", () => {
  it("scales with words and is zero for empty", () => {
    expect(estimateSpeakMs("")).toBe(0);
    expect(estimateSpeakMs("one two three four")).toBeGreaterThan(estimateSpeakMs("one two"));
  });
});
