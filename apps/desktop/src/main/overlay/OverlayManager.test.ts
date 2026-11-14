import { describe, expect, it } from "vitest";
import type { ToolName } from "@pointy/shared/overlay";
import { OverlayManager, type NewAnnotation } from "./OverlayManager";

let clockT = 0;
const mk = (id: string, toolName: ToolName, extra: Partial<NewAnnotation> = {}): NewAnnotation => ({
  id,
  toolName,
  input: { id },
  resolvedBounds: { x: 0, y: 0, width: 10, height: 10 },
  displayId: "1",
  ...extra,
});
const newMgr = (o: ConstructorParameters<typeof OverlayManager>[0] = {}) =>
  new OverlayManager({ now: () => ++clockT, ...o });
const visibleIds = (m: OverlayManager) => m.visible().map((a) => a.id);

describe("OverlayManager basics", () => {
  it("nextId gives unique, prefixed ids", () => {
    const m = newMgr();
    const ids = [m.nextId("hl"), m.nextId("hl"), m.nextId("pt"), m.nextId("steps")];
    expect(ids[0]).toBe("hl_1");
    expect(new Set(ids).size).toBe(4);
    expect(ids[2]).toMatch(/^pt_/);
  });

  it("add creates a visible annotation with fields and createdAt", () => {
    const m = newMgr({ now: () => 42 });
    const { annotation, dismissed } = m.add(mk("a", "point_at", { turnId: "t1", cue: "c" }));
    expect(dismissed).toEqual([]);
    expect(annotation).toMatchObject({
      id: "a",
      toolName: "point_at",
      state: "visible",
      createdAt: 42,
      turnId: "t1",
      cue: "c",
      displayId: "1",
    });
    expect(m.get("a")).toBe(annotation);
    expect(m.get("zzz")).toBeUndefined();
  });

  it("all() is oldest first; visible() excludes pending and exiting", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.add(mk("b", "point_at", { pending: true }));
    m.add(mk("c", "point_at"));
    m.beginExit("c");
    expect(m.all().map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(visibleIds(m)).toEqual(["a"]);
  });

  it("update patches bounds, displayId and input only", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.update("a", { resolvedBounds: { x: 1, y: 2, width: 3, height: 4 }, displayId: "2", input: { n: 1 } });
    expect(m.get("a")).toMatchObject({ resolvedBounds: { x: 1, y: 2, width: 3, height: 4 }, displayId: "2", input: { n: 1 } });
    m.update("a", { resolvedBounds: null });
    expect(m.get("a")?.resolvedBounds).toBeNull();
    expect(() => m.update("nope", { displayId: "3" })).not.toThrow();
  });

  it("beginExit: visible/pending → exiting, false for unknown or already exiting", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.add(mk("p", "point_at", { pending: true }));
    expect(m.beginExit("a")).toBe(true);
    expect(m.get("a")?.state).toBe("exiting");
    expect(m.beginExit("a")).toBe(false);
    expect(m.beginExit("p")).toBe(true);
    expect(m.beginExit("nope")).toBe(false);
  });

  it("remove forgets an annotation", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.remove("a");
    expect(m.get("a")).toBeUndefined();
    expect(m.all()).toEqual([]);
  });
});

describe("OverlayManager replacement", () => {
  it("a new highlight replaces the visible highlight", () => {
    const m = newMgr();
    m.add(mk("h1", "highlight"));
    const { dismissed } = m.add(mk("h2", "highlight"));
    expect(dismissed).toEqual([{ id: "h1", reason: "replaced" }]);
    expect(m.get("h1")?.state).toBe("exiting");
    expect(visibleIds(m)).toEqual(["h2"]);
  });

  it("a new highlight replaces a pending highlight too", () => {
    const m = newMgr();
    m.add(mk("h1", "highlight", { pending: true, cue: "x" }));
    const { dismissed } = m.add(mk("h2", "highlight"));
    expect(dismissed).toEqual([{ id: "h1", reason: "replaced" }]);
    expect(m.get("h1")?.state).toBe("exiting");
  });

  it("highlight does not replace pointers or explainers", () => {
    const m = newMgr();
    m.add(mk("p", "point_at"));
    m.add(mk("e", "show_explainer"));
    const { dismissed } = m.add(mk("h", "highlight"));
    expect(dismissed).toEqual([]);
    expect(visibleIds(m)).toEqual(["p", "e", "h"]);
  });

  it("a new step set replaces the old one", () => {
    const m = newMgr();
    m.add(mk("s1", "show_steps"));
    const { dismissed } = m.add(mk("s2", "show_steps"));
    expect(dismissed).toEqual([{ id: "s1", reason: "replaced" }]);
    expect(visibleIds(m)).toEqual(["s2"]);
  });

  it("a pending add does not replace anything until revealed", () => {
    const m = newMgr();
    m.add(mk("h1", "highlight"));
    const { dismissed } = m.add(mk("h2", "highlight", { pending: true, cue: "c" }));
    expect(dismissed).toEqual([]);
    expect(visibleIds(m)).toEqual(["h1"]);
  });

  it("already exiting highlights are not replaced again", () => {
    const m = newMgr();
    m.add(mk("h1", "highlight"));
    m.beginExit("h1");
    expect(m.add(mk("h2", "highlight")).dismissed).toEqual([]);
  });
});

describe("OverlayManager max visible", () => {
  it("allows 3 visible", () => {
    const m = newMgr();
    for (const id of ["a", "b", "c"]) expect(m.add(mk(id, "point_at")).dismissed).toEqual([]);
    expect(visibleIds(m)).toEqual(["a", "b", "c"]);
  });

  it("the 4th evicts the oldest", () => {
    const m = newMgr();
    for (const id of ["a", "b", "c"]) m.add(mk(id, "point_at"));
    const { dismissed } = m.add(mk("d", "point_at"));
    expect(dismissed).toEqual([{ id: "a", reason: "evicted" }]);
    expect(m.get("a")?.state).toBe("exiting");
    expect(visibleIds(m)).toEqual(["b", "c", "d"]);
  });

  it("the step set is never evicted by the limit", () => {
    const m = newMgr();
    m.add(mk("s", "show_steps"));
    m.add(mk("a", "point_at"));
    m.add(mk("b", "point_at"));
    expect(m.add(mk("c", "point_at")).dismissed).toEqual([{ id: "a", reason: "evicted" }]);
    expect(m.add(mk("d", "point_at")).dismissed).toEqual([{ id: "b", reason: "evicted" }]);
    expect(visibleIds(m)).toEqual(["s", "c", "d"]);
  });

  it("an older step set is skipped even when it is the oldest", () => {
    const m = newMgr();
    m.add(mk("s", "show_steps"));
    m.add(mk("a", "highlight"));
    m.add(mk("b", "point_at"));
    m.add(mk("c", "show_explainer"));
    expect(m.get("s")?.state).toBe("visible");
    expect(m.get("a")?.state).toBe("exiting");
  });

  it("a new step set can push out the oldest non-step annotation", () => {
    const m = newMgr();
    for (const id of ["a", "b", "c"]) m.add(mk(id, "point_at"));
    const { dismissed } = m.add(mk("s", "show_steps"));
    expect(dismissed).toEqual([{ id: "a", reason: "evicted" }]);
  });

  it("exiting annotations do not count toward the limit", () => {
    const m = newMgr();
    for (const id of ["a", "b", "c"]) m.add(mk(id, "point_at"));
    m.beginExit("a");
    expect(m.add(mk("d", "point_at")).dismissed).toEqual([]);
    expect(visibleIds(m)).toEqual(["b", "c", "d"]);
  });

  it("pending annotations do not count toward the limit", () => {
    const m = newMgr();
    for (const id of ["p1", "p2", "p3", "p4"]) m.add(mk(id, "point_at", { pending: true, cue: "c" }));
    for (const id of ["a", "b", "c"]) expect(m.add(mk(id, "point_at")).dismissed).toEqual([]);
  });

  it("replacement and eviction can both happen in one add", () => {
    const m = newMgr();
    m.add(mk("h1", "highlight"));
    m.add(mk("a", "point_at"));
    m.add(mk("b", "point_at"));
    const { dismissed } = m.add(mk("h2", "highlight"));
    expect(dismissed).toEqual([{ id: "h1", reason: "replaced" }]);
    expect(visibleIds(m)).toEqual(["a", "b", "h2"]);
  });

  it("respects a custom maxVisible", () => {
    const m = newMgr({ maxVisible: 1 });
    m.add(mk("a", "point_at"));
    expect(m.add(mk("b", "point_at")).dismissed).toEqual([{ id: "a", reason: "evicted" }]);
  });

  it("never evicts the annotation being added", () => {
    const m = newMgr({ maxVisible: 1 });
    m.add(mk("s", "show_steps"));
    const { dismissed } = m.add(mk("a", "point_at"));
    expect(dismissed).toEqual([]);
    expect(m.get("a")?.state).toBe("visible");
  });
});

describe("OverlayManager reveal", () => {
  it("makes pending annotations with the cue visible", () => {
    const m = newMgr();
    m.add(mk("a", "point_at", { pending: true, cue: "c1" }));
    m.add(mk("b", "point_at", { pending: true, cue: "c2" }));
    const { revealed, dismissed } = m.reveal("c1");
    expect(revealed.map((r) => r.id)).toEqual(["a"]);
    expect(dismissed).toEqual([]);
    expect(m.get("a")?.state).toBe("visible");
    expect(m.get("b")?.state).toBe("pending");
  });

  it("applies replacement rules", () => {
    const m = newMgr();
    m.add(mk("h1", "highlight"));
    m.add(mk("h2", "highlight", { pending: true, cue: "c" }));
    const { revealed, dismissed } = m.reveal("c");
    expect(revealed.map((r) => r.id)).toEqual(["h2"]);
    expect(dismissed).toEqual([{ id: "h1", reason: "replaced" }]);
    expect(visibleIds(m)).toEqual(["h2"]);
  });

  it("applies the eviction rule", () => {
    const m = newMgr();
    for (const id of ["a", "b", "c"]) m.add(mk(id, "point_at"));
    m.add(mk("d", "point_at", { pending: true, cue: "c" }));
    const { dismissed } = m.reveal("c");
    expect(dismissed).toEqual([{ id: "a", reason: "evicted" }]);
    expect(visibleIds(m)).toEqual(["b", "c", "d"]);
  });

  it("reveals several oldest first; later highlights replace earlier ones", () => {
    const m = newMgr();
    m.add(mk("h1", "highlight", { pending: true, cue: "c" }));
    m.add(mk("h2", "highlight", { pending: true, cue: "c" }));
    const { revealed, dismissed } = m.reveal("c");
    expect(revealed.map((r) => r.id)).toEqual(["h1", "h2"]);
    expect(dismissed).toEqual([{ id: "h1", reason: "replaced" }]);
    expect(visibleIds(m)).toEqual(["h2"]);
  });

  it("unknown cue, or non-pending annotations, are untouched", () => {
    const m = newMgr();
    m.add(mk("a", "point_at", { cue: "c" }));
    expect(m.reveal("c")).toEqual({ revealed: [], dismissed: [] });
    expect(m.reveal("zzz")).toEqual({ revealed: [], dismissed: [] });
  });

  it("revealing twice does nothing the second time", () => {
    const m = newMgr();
    m.add(mk("a", "point_at", { pending: true, cue: "c" }));
    m.reveal("c");
    expect(m.reveal("c").revealed).toEqual([]);
  });
});

describe("OverlayManager turns and history", () => {
  it("endTurn drops pending annotations and returns their ids", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.add(mk("p1", "point_at", { pending: true, cue: "c" }));
    m.add(mk("p2", "highlight", { pending: true, cue: "d" }));
    expect(m.endTurn().sort()).toEqual(["p1", "p2"]);
    expect(m.all().map((x) => x.id)).toEqual(["a"]);
  });

  it("endTurn keeps visible and exiting annotations", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.add(mk("b", "point_at"));
    m.beginExit("b");
    expect(m.endTurn()).toEqual([]);
    expect(m.all()).toHaveLength(2);
  });

  it("lastSet is null before any turn ends and when nothing was added", () => {
    const m = newMgr();
    expect(m.lastSet()).toBeNull();
    m.endTurn();
    expect(m.lastSet()).toBeNull();
  });

  it("endTurn pushes the current set (toolName + input, in order)", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.add(mk("b", "highlight"));
    m.endTurn();
    expect(m.lastSet()).toEqual([
      { toolName: "point_at", input: { id: "a" } },
      { toolName: "highlight", input: { id: "b" } },
    ]);
  });

  it("an empty turn does not push over the previous set", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.endTurn();
    m.endTurn();
    expect(m.lastSet()).toEqual([{ toolName: "point_at", input: { id: "a" } }]);
  });

  it("each turn starts a fresh set", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.endTurn();
    m.add(mk("b", "highlight"));
    m.endTurn();
    expect(m.lastSet()).toEqual([{ toolName: "highlight", input: { id: "b" } }]);
  });

  it("history is recorded for every add, including replaced/evicted/pending ones", () => {
    const m = newMgr();
    m.add(mk("h1", "highlight"));
    m.add(mk("h2", "highlight"));
    m.add(mk("p", "point_at", { pending: true, cue: "c" }));
    m.endTurn();
    expect(m.lastSet()).toHaveLength(3);
  });

  it("history is capped at 5 sets (default) and lastSet is the newest", () => {
    const m = newMgr();
    for (let i = 1; i <= 8; i++) {
      m.add(mk(`a${i}`, "point_at"));
      m.endTurn();
    }
    expect(m.lastSet()).toEqual([{ toolName: "point_at", input: { id: "a8" } }]);
    // Internal cap: observable via a custom size.
    const small = newMgr({ historySize: 2 });
    for (let i = 1; i <= 3; i++) {
      small.add(mk(`b${i}`, "point_at"));
      small.endTurn();
    }
    expect(small.lastSet()).toEqual([{ toolName: "point_at", input: { id: "b3" } }]);
  });

  it("lastSet returns a copy that cannot corrupt history", () => {
    const m = newMgr();
    m.add(mk("a", "point_at"));
    m.endTurn();
    const s = m.lastSet();
    s?.pop();
    expect(m.lastSet()).toHaveLength(1);
  });
});
