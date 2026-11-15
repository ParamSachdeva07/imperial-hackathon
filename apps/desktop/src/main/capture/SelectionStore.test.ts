import { describe, expect, it, vi } from "vitest";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import { clearOnSessionClose, SelectionStore } from "./SelectionStore";

const snap = (id: string): SelectionSnapshot => ({
  id,
  kind: "point",
  capturedAt: 1,
  displayId: "1",
  regionGlobal: { x: 0, y: 0, width: 1, height: 1 },
  full: { mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA==", width: 1, height: 1, markedRegion: { x: 0, y: 0, width: 0, height: 0 } },
  focus: { mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA==", width: 1, height: 1 },
});

describe("SelectionStore", () => {
  it("sets, reads, consumes and clears", () => {
    const s = new SelectionStore();
    expect(s.latest()).toBeNull();
    s.set(snap("a"));
    expect(s.latest()?.id).toBe("a");
    expect(s.consume()?.id).toBe("a");
    expect(s.latest()).toBeNull();
    expect(s.consume()).toBeNull();
  });
  it("notifies and unsubscribes", () => {
    const s = new SelectionStore();
    const onSnap = vi.fn();
    const onClear = vi.fn();
    const off = s.onSnapshot(onSnap);
    s.onClear(onClear);
    s.set(snap("a"));
    expect(onSnap).toHaveBeenCalledOnce();
    s.clear();
    expect(onClear).toHaveBeenCalledOnce();
    s.clear(); // nothing to clear: no second notification
    expect(onClear).toHaveBeenCalledOnce();
    off();
    s.set(snap("b"));
    expect(onSnap).toHaveBeenCalledOnce();
  });
  it("clears when the session closes", () => {
    const s = new SelectionStore();
    let cb: (a: boolean) => void = () => {};
    const off = clearOnSessionClose(s, { onSession: (c) => ((cb = c), () => {}) });
    s.set(snap("a"));
    cb(true);
    expect(s.latest()).not.toBeNull();
    cb(false);
    expect(s.latest()).toBeNull();
    expect(typeof off).toBe("function");
  });
});
