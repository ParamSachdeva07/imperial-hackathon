import { describe, expect, it } from "vitest";
import { StatusEmitter } from "./status";

describe("StatusEmitter", () => {
  it("starts idle, emits on change only, unsubscribes", () => {
    const e = new StatusEmitter();
    const seen: string[] = [];
    const off = e.onChange((s) => seen.push(s));
    expect(e.get()).toBe("idle");
    e.set("idle");
    e.set("thinking");
    e.set("thinking");
    off();
    e.set("speaking");
    expect(seen).toEqual(["thinking"]);
    expect(e.get()).toBe("speaking");
  });
});
