import { describe, expect, it, vi } from "vitest";
import type { GestureEvent } from "@pointy/gestures";
import { createMouseOffHint, MOUSE_OFF_HINT } from "./MouseHint";

describe("createMouseOffHint", () => {
  it("ignores drawing events, logs once on the first mouse/scroll/click", () => {
    const log = vi.fn();
    const on = createMouseOffHint(log);
    on({ type: "cursor_moved", hand: "Right", x: 1, y: 1, displayId: 1, t: 0 });
    expect(log).not.toHaveBeenCalled();
    on({ type: "scroll", hand: "Right", phase: "start", dx: 0, dy: 0, t: 0 } as GestureEvent);
    on({ type: "mouse", hand: "Right", phase: "move", x: 1, y: 1, displayId: 1, t: 0 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(MOUSE_OFF_HINT);
  });
});
