import type { GestureEvent } from "@pointy/gestures";
import { describe, expect, it } from "vitest";
import { guardMouseSource, SelectionGuard } from "./SelectionGuard";
import { MouseEventSink, type MouseSource } from "./SimMouseSink";

let clock = 0;
const mk = (opts = {}) => {
  clock = 0;
  return new SelectionGuard({
    now: () => clock,
    getDisplay: () => ({ width: 1000, height: 800 }),
    ...opts,
  });
};
const sel = (x = 500, y = 400): GestureEvent => ({
  type: "point_selected",
  hand: "Right",
  x,
  y,
  displayId: 1,
  heldForMs: 800,
  t: 0,
});
const mouse = (
  phase: "start" | "move" | "end",
  x = 500,
  y = 400,
): GestureEvent => ({
  type: "mouse",
  hand: "Right",
  phase,
  x,
  y,
  displayId: 1,
  t: 0,
});
const scroll = (phase: "start" | "move" | "end"): GestureEvent => ({
  type: "scroll",
  hand: "Right",
  phase,
  dx: 0,
  dy: 50,
  t: 0,
});
const click = (): GestureEvent => ({
  type: "click",
  hand: "Right",
  button: "left",
  x: 1,
  y: 1,
  displayId: 1,
  t: 0,
});

describe("SelectionGuard", () => {
  it("passes everything before a selection", () => {
    const g = mk();
    for (const e of [
      mouse("start"),
      mouse("move"),
      click(),
      mouse("end"),
      scroll("start"),
      scroll("end"),
    ])
      expect(g.allow(e)).toBe(true);
  });

  it("drops a fist scroll after selection entirely, including start and end", () => {
    const g = mk();
    g.allow(sel());
    clock = 100;
    expect(
      [scroll("start"), scroll("move"), scroll("move"), scroll("end")].map(
        (e) => g.allow(e),
      ),
    ).toEqual([false, false, false, false]);
  });

  it("drops a mouse stroke incl. its click and end, even after unblocking mid-stroke", () => {
    const g = mk();
    g.allow(sel());
    clock = 100;
    expect(g.allow(mouse("start"))).toBe(false);
    g.clear();
    clock = 5000;
    expect(g.isBlocked).toBe(false);
    expect(
      [mouse("move"), click(), mouse("end")].map((e) => g.allow(e)),
    ).toEqual([false, false, false]);
    expect(g.allow(mouse("start"))).toBe(true);
    expect(g.allow(mouse("end"))).toBe(true);
  });

  it("stays blocked until clear and cooldown", () => {
    const g = mk();
    g.allow(sel());
    clock = 1000;
    g.clear();
    expect(g.allow(mouse("start", 1, 1))).toBe(false);
    g.allow(mouse("end"));
    clock = 1499;
    expect(g.isBlocked).toBe(true);
    clock = 1500;
    expect(g.isBlocked).toBe(false);
    expect(g.allow(scroll("start"))).toBe(true);
  });

  it("stays blocked without clear until maxHoldMs (dev)", () => {
    const g = mk({ maxHoldMs: 4000 });
    g.allow(sel());
    clock = 3999;
    expect(g.isBlocked).toBe(true);
    clock = 4000;
    expect(g.isBlocked).toBe(false);
  });

  it("drops a stroke already in progress at selection time", () => {
    const g = mk();
    expect(g.allow(mouse("start"))).toBe(true);
    g.allow(sel());
    expect(
      [mouse("move"), click(), mouse("end")].map((e) => g.allow(e)),
    ).toEqual([false, false, false]);
    expect(g.allow(scroll("start"))).toBe(false);
  });

  it("drops an edge point_selected while blocked, accepts a mid-screen second selection", () => {
    const g = mk();
    g.allow(sel());
    clock = 200;
    expect(g.allow(sel(500, 799))).toBe(false);
    expect(g.allow(sel(2, 300))).toBe(false);
    expect(g.allow(sel(300, 300))).toBe(true);
    expect(g.isBlocked).toBe(true);
  });

  it("drops an edge selection just after clear, accepts it later", () => {
    const g = mk();
    g.allow(sel());
    clock = 2000;
    g.clear();
    expect(g.allow(sel(500, 799))).toBe(false);
    clock = 4000;
    expect(g.allow(sel(500, 799))).toBe(true);
  });

  it("memoizes per event object and resets", () => {
    const g = mk();
    const m = mouse("start");
    expect(g.allow(m)).toBe(true);
    g.allow(sel());
    expect(g.allow(m)).toBe(true);
    g.reset();
    expect(g.isBlocked).toBe(false);
    expect(g.allow(scroll("start"))).toBe(true);
  });

  it("guardMouseSource filters listeners consistently", () => {
    const g = mk();
    const sink = new MouseEventSink();
    const src = guardMouseSource(
      {
        on: (t, cb) => sink.on(t as "mouse", cb as never),
        display: {} as never,
      } as MouseSource,
      g,
    );
    const got: string[] = [];
    src.on("mouse", (e) => got.push(e.phase));
    sink.emit(mouse("start") as never);
    g.allow(sel());
    sink.emit(mouse("move") as never);
    sink.emit(mouse("end") as never);
    expect(got).toEqual(["start"]);
  });
});
