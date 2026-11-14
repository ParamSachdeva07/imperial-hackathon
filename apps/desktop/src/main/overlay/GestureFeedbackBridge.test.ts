import { describe, expect, it } from "vitest";
import type { GestureEvent } from "@pointy/gestures";
import type { DisplayInfo } from "@pointy/shared/overlay";
import type { GestureFeedbackMessage } from "@pointy/shared/overlay/render";
import { createGestureFeedbackBridge, mapGestureEvent } from "./GestureFeedbackBridge";

const D1: DisplayInfo = { id: "1", bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 }, scaleFactor: 2 };
const D2: DisplayInfo = { id: "2", bounds: { x: -1920, y: -100, width: 1920, height: 1080 }, workArea: { x: -1920, y: -100, width: 1920, height: 1080 }, scaleFactor: 1 };
const DISPLAYS = [D1, D2];
const t = 0;

function setup(displays: DisplayInfo[] = DISPLAYS) {
  const sent: GestureFeedbackMessage[] = [];
  const screen = { getDisplays: () => displays, getPrimaryDisplayId: () => "1", onDisplaysChanged: () => () => {} };
  const bridge = createGestureFeedbackBridge({ screen, sink: { sendGesture: (m) => sent.push(m) } });
  const listeners = new Set<(e: GestureEvent) => void>();
  const source = {
    onAny(cb: (e: GestureEvent) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const emit = (e: GestureEvent) => [...listeners].forEach((l) => l(e));
  return { bridge, sent, source, emit, listeners };
}
const tick = () => Promise.resolve();

describe("mapGestureEvent", () => {
  const hand = "Right" as const;
  it("maps every event type", () => {
    const m = (e: GestureEvent) => mapGestureEvent(e, DISPLAYS);
    expect(m({ type: "cursor_moved", hand, x: 10, y: 20, displayId: 1, t })).toEqual({ kind: "cursor", at: { x: 10, y: 20 }, mode: "draw" });
    expect(m({ type: "mouse", hand, phase: "start", x: 1, y: 2, displayId: 1, t })).toEqual({ kind: "cursor", at: { x: 1, y: 2 }, mode: "mouse" });
    expect(m({ type: "mouse", hand, phase: "move", x: 3, y: 4, displayId: 1, t })).toEqual({ kind: "cursor", at: { x: 3, y: 4 }, mode: "mouse" });
    expect(m({ type: "mouse", hand, phase: "end", x: 3, y: 4, displayId: 1, t })).toEqual({ kind: "lost", mode: "mouse" });
    expect(m({ type: "dwell_progress", hand, progress: 0.4, x: 5, y: 6, displayId: 1, t })).toEqual({ kind: "progress", at: { x: 5, y: 6 }, value: 0.4, progressKind: "dwell" });
    expect(m({ type: "click_progress", hand, progress: 0, x: 5, y: 6, displayId: 1, t })).toEqual({ kind: "progress", at: { x: 5, y: 6 }, value: 0, progressKind: "click" });
    expect(m({ type: "click", hand, button: "left", x: 7, y: 8, displayId: 1, t })).toEqual({ kind: "click", at: { x: 7, y: 8 } });
    expect(m({ type: "point_selected", hand, x: 9, y: 10, displayId: 1, heldForMs: 900, t })).toEqual({ kind: "selected_point", at: { x: 9, y: 10 } });
    expect(m({ type: "hand_lost", hand, reason: "absent", t })).toEqual({ kind: "lost", mode: "draw" });
    expect(m({ type: "scroll", hand, phase: "move", dx: 0, dy: 5, t })).toEqual({ kind: "scroll", phase: "move" });
    expect(m({ type: "wake_requested", source: "open_palm", hand, heldForMs: 900, t })).toBeNull();
  });

  it("converts display-relative coordinates on a negative-origin secondary display", () => {
    const at = mapGestureEvent({ type: "cursor_moved", hand, x: 100, y: 50, displayId: 2, t }, DISPLAYS);
    expect(at).toEqual({ kind: "cursor", at: { x: -1820, y: -50 }, mode: "draw" });
  });

  it("converts region polygon and bbox", () => {
    const fb = mapGestureEvent(
      { type: "region_selected", hand, polygon: [[0, 0], [100, 0], [100, 80]], bbox: { x: 0, y: 0, width: 100, height: 80 }, displayId: 2, t },
      DISPLAYS,
    );
    expect(fb).toEqual({
      kind: "selected_region",
      points: [{ x: -1920, y: -100 }, { x: -1820, y: -100 }, { x: -1820, y: -20 }],
      bounds: { x: -1920, y: -100, width: 100, height: 80 },
    });
  });

  it("drops events for unknown displays, clamps progress", () => {
    expect(mapGestureEvent({ type: "cursor_moved", hand, x: 1, y: 1, displayId: 99, t }, DISPLAYS)).toBeNull();
    expect(mapGestureEvent({ type: "region_selected", hand, polygon: [], bbox: { x: 0, y: 0, width: 1, height: 1 }, displayId: 99, t }, DISPLAYS)).toBeNull();
    const p = mapGestureEvent({ type: "dwell_progress", hand, progress: 1.4, x: 1, y: 1, displayId: 1, t }, DISPLAYS);
    expect(p).toMatchObject({ value: 1 });
  });
});

describe("createGestureFeedbackBridge", () => {
  const hand = "Left" as const;

  it("batches one microtask into one message and collapses consecutive cursor/progress updates", async () => {
    const { bridge, sent, source, emit } = setup();
    bridge.attach(source);
    emit({ type: "cursor_moved", hand, x: 1, y: 1, displayId: 1, t });
    emit({ type: "cursor_moved", hand, x: 2, y: 2, displayId: 1, t });
    emit({ type: "dwell_progress", hand, progress: 0.2, x: 2, y: 2, displayId: 1, t });
    emit({ type: "dwell_progress", hand, progress: 0.3, x: 2, y: 2, displayId: 1, t });
    emit({ type: "cursor_moved", hand, x: 3, y: 3, displayId: 1, t });
    expect(sent).toHaveLength(0);
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events).toEqual([
      { kind: "cursor", at: { x: 2, y: 2 }, mode: "draw" },
      { kind: "progress", at: { x: 2, y: 2 }, value: 0.3, progressKind: "dwell" },
      { kind: "cursor", at: { x: 3, y: 3 }, mode: "draw" },
    ]);
    emit({ type: "cursor_moved", hand, x: 4, y: 4, displayId: 1, t });
    await tick();
    expect(sent).toHaveLength(2);
  });

  it("keeps draw and mouse cursors of two hands apart", async () => {
    const { bridge, sent, source, emit } = setup();
    bridge.attach(source);
    emit({ type: "cursor_moved", hand, x: 1, y: 1, displayId: 1, t });
    emit({ type: "mouse", hand: "Right", phase: "move", x: 9, y: 9, displayId: 1, t });
    await tick();
    expect(sent[0]!.events).toEqual([
      { kind: "cursor", at: { x: 1, y: 1 }, mode: "draw" },
      { kind: "cursor", at: { x: 9, y: 9 }, mode: "mouse" },
    ]);
  });

  it("never drops selections, clicks, lost or session changes", async () => {
    const { bridge, sent, source, emit } = setup();
    bridge.attach(source);
    bridge.setSessionActive(true);
    emit({ type: "cursor_moved", hand, x: 1, y: 1, displayId: 1, t });
    emit({ type: "point_selected", hand, x: 1, y: 1, displayId: 1, heldForMs: 1, t });
    emit({ type: "click", hand, button: "left", x: 1, y: 1, displayId: 1, t });
    emit({ type: "hand_lost", hand, reason: "absent", t });
    emit({ type: "hand_lost", hand, reason: "absent", t });
    bridge.setSessionActive(false);
    await tick();
    expect(sent[0]!.events.map((e) => e.kind)).toEqual(["session", "cursor", "selected_point", "click", "lost", "lost", "session"]);
  });

  it("drops unknown-display events and sends nothing when the batch is empty", async () => {
    const { bridge, sent, source, emit } = setup();
    bridge.attach(source);
    emit({ type: "cursor_moved", hand, x: 1, y: 1, displayId: 42, t });
    emit({ type: "wake_requested", source: "open_palm", hand, heldForMs: 1, t });
    await tick();
    expect(sent).toHaveLength(0);
  });

  it("supports several sources, detach, and dispose", async () => {
    const a = setup();
    const b = setup();
    const sent: GestureFeedbackMessage[] = [];
    const screen = { getDisplays: () => DISPLAYS, getPrimaryDisplayId: () => "1", onDisplaysChanged: () => () => {} };
    const bridge = createGestureFeedbackBridge({ screen, sink: { sendGesture: (m) => sent.push(m) } });
    const detachA = bridge.attach(a.source);
    bridge.attach(b.source);
    a.emit({ type: "hand_lost", hand, reason: "absent", t });
    b.emit({ type: "hand_lost", hand, reason: "absent", t });
    await tick();
    expect(sent[0]!.events).toHaveLength(2);
    detachA();
    expect(a.listeners.size).toBe(0);
    a.emit({ type: "hand_lost", hand, reason: "absent", t });
    await tick();
    expect(sent).toHaveLength(1);
    bridge.dispose();
    expect(b.listeners.size).toBe(0);
    bridge.setSessionActive(true);
    await tick();
    expect(sent).toHaveLength(1);
  });

  it("dispose drops a pending batch", async () => {
    const { bridge, sent, source, emit } = setup();
    bridge.attach(source);
    emit({ type: "hand_lost", hand, reason: "absent", t });
    bridge.dispose();
    await tick();
    expect(sent).toHaveLength(0);
  });
});
