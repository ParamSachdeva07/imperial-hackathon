import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MockBoundsProvider } from "./MockBoundsProvider";

const r = (x: number, y: number) => ({ x, y, width: 10, height: 10 });

describe("MockBoundsProvider", () => {
  it("serves elements from sources, later sources win", async () => {
    const p = new MockBoundsProvider(() => "1");
    p.setSource("a", { btn: { rect: r(0, 0) } });
    p.setSource("b", { btn: { rect: r(5, 5), displayId: "2" } });
    expect(await p.getBounds("btn")).toEqual({ rect: r(5, 5), displayId: "2" });
    expect(await p.getBounds("nope")).toBeNull();
  });

  it("simulates moves (cumulative), removals and restore, notifying listeners", async () => {
    const p = new MockBoundsProvider((rect) => (rect.x >= 100 ? "2" : "1"));
    const cb = vi.fn();
    p.onChange(cb);
    p.setSource("a", { btn: { rect: r(80, 0) } });
    p.simMove("btn", 10, 0);
    p.simMove("btn", 10, 5);
    expect(await p.getBounds("btn")).toEqual({ rect: r(100, 5), displayId: "2" });
    p.simRemove("btn");
    expect(await p.getBounds("btn")).toBeNull();
    p.simRestore("btn");
    expect((await p.getBounds("btn"))?.rect).toEqual(r(80, 0));
    expect(cb).toHaveBeenCalledTimes(5);
  });

  it("loads and validates a JSON file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pointy-"));
    const file = join(dir, "els.json");
    writeFileSync(file, JSON.stringify({ x: { rect: r(1, 2), displayId: "3" } }));
    const p = new MockBoundsProvider();
    p.loadJsonFile(file);
    expect(await p.getBounds("x")).toEqual({ rect: r(1, 2), displayId: "3" });
    writeFileSync(file, JSON.stringify({ x: { rect: { x: 0, y: 0, width: 0, height: 1 } } }));
    expect(() => p.loadJsonFile(file)).toThrow();
  });
});
