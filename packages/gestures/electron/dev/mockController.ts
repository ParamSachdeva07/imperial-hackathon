/**
 * Stand-in for the real session controller, for the standalone launcher only:
 * opens the session on wake, closes it after a period without gestures, logs what happens.
 * The real controller replaces this with its own logic (voice, TurnContext, Jev...).
 */
import type { GestureEvent } from "../../src/events";
import type { GestureService } from "../../src/electron/service";

export interface MockControllerOptions {
  idleMs: number;
  log: (msg: string) => void;
}

const QUIET = new Set(["cursor_moved", "dwell_progress", "click_progress"]);

export function describe(e: GestureEvent): string | null {
  switch (e.type) {
    case "wake_requested":
      return `WAKE (${e.hand} hand, held ${e.heldForMs} ms)`;
    case "point_selected":
      return `POINT selected at (${e.x}, ${e.y})`;
    case "region_selected":
      return `REGION selected ${Math.round(e.bbox.width)}×${Math.round(e.bbox.height)} at (${Math.round(e.bbox.x)}, ${Math.round(e.bbox.y)})`;
    case "click":
      return `CLICK at (${e.x}, ${e.y})`;
    case "mouse":
      return e.phase === "move" ? null : `mouse ${e.phase}`;
    case "scroll":
      return e.phase === "move" ? null : `scroll ${e.phase}`;
    case "hand_lost":
      return `hand lost (${e.reason})`;
    default:
      return QUIET.has(e.type) ? null : e.type;
  }
}

export function startMockController(service: GestureService, opts: MockControllerOptions): () => void {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    idleTimer = null;
    service.setSessionActive(false);
    opts.log(`SESSION CLOSED (no gesture for ${opts.idleMs / 1000} s) — raise an open palm to wake`);
  };
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(close, opts.idleMs);
  };

  const off = service.onAny((e) => {
    const line = describe(e);
    if (line) opts.log(line);
    if (e.type === "wake_requested" && !service.sessionActive) {
      service.setSessionActive(true);
      opts.log("SESSION OPEN — 1 finger: mouse (hold still = click) · 2 fingers: draw/select · fist: scroll");
    }
    if (service.sessionActive) touch();
  });

  return () => {
    off();
    if (idleTimer) clearTimeout(idleTimer);
  };
}
