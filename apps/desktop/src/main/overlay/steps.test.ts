import { describe, expect, it } from "vitest";
import { advanceSteps, startSteps, statusOf } from "./steps";

describe("steps", () => {
  it("starts at the given index", () => {
    expect(startSteps(4, 2)).toEqual({ total: 4, current: 2, completed: false });
  });
  it("clamps startAt into range", () => {
    expect(startSteps(4, -3).current).toBe(0);
    expect(startSteps(4, 99).current).toBe(3);
    expect(startSteps(1, 5).current).toBe(0);
  });
  it("handles total 0 without a negative index", () => {
    expect(startSteps(0, 0).current).toBe(0);
  });
  it("advances one step at a time", () => {
    const s = advanceSteps(startSteps(3, 0));
    expect(s).toEqual({ total: 3, current: 1, completed: false });
  });
  it("completes when advancing past the last step; current = total", () => {
    let s = startSteps(2, 1);
    s = advanceSteps(s);
    expect(s).toEqual({ total: 2, current: 2, completed: true });
    expect([0, 1].map((i) => statusOf(s, i))).toEqual(["past", "past"]);
  });
  it("single-step guide completes on first advance", () => {
    expect(advanceSteps(startSteps(1, 0)).completed).toBe(true);
  });
  it("advancing a completed state is a no-op", () => {
    const done = advanceSteps(startSteps(1, 0));
    expect(advanceSteps(done)).toEqual(done);
  });
  it("does not mutate its input", () => {
    const s = startSteps(3, 0);
    advanceSteps(s);
    expect(s.current).toBe(0);
  });
  it("statusOf: past / current / future", () => {
    const s = startSteps(4, 2);
    expect([0, 1, 2, 3].map((i) => statusOf(s, i))).toEqual(["past", "past", "current", "future"]);
  });
  it("walks the whole guide", () => {
    let s = startSteps(3, 0);
    const seen: number[] = [s.current];
    while (!s.completed) {
      s = advanceSteps(s);
      seen.push(s.current);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});
