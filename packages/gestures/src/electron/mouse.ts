/**
 * Opt-in: turn "mouse", "click" and "scroll" gesture events into real OS mouse moves, left clicks
 * and wheel scrolling (nut-js, an optional dependency). The session controller decides whether
 * to attach this. Scrolling goes to the window under the mouse pointer (place it with one finger,
 * then close the fist and drag).
 */
import { screen } from "electron";
import type * as NutJs from "@nut-tree-fork/nut-js";
import { createScrollConverter, toMousePoint, type ScreenPoint } from "./coords";
import type { GestureService } from "./service";

export type MouseAction =
  | { type: "move"; x: number; y: number }
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; up: number; left: number };

export interface SystemMouseOptions {
  /** Perform dwell clicks (default true). */
  click?: boolean;
  /** Turn fist drags into wheel scrolling (default true). */
  scroll?: boolean;
  /** DIP of hand movement per wheel notch (default 100). */
  scrollPxPerNotch?: number;
  /** Called after each action is performed (diagnostics). */
  onAction?: (a: MouseAction) => void;
  log?: (msg: string) => void;
}

/** Returns a detach function. Resolves to a no-op if nut-js can't be loaded. */
export async function attachSystemMouse(
  service: GestureService,
  opts: SystemMouseOptions = {},
): Promise<() => void> {
  const log = opts.log ?? ((m: string) => console.log(`[gestures] ${m}`));
  let nut: typeof NutJs;
  try {
    nut = await import("@nut-tree-fork/nut-js");
  } catch (err) {
    log(`system mouse disabled: could not load @nut-tree-fork/nut-js (${String(err)})`);
    return () => {};
  }
  const { mouse, Point } = nut;
  mouse.config.autoDelayMs = 0;
  mouse.config.mouseSpeed = 100000;

  const convert = (x: number, y: number) =>
    toMousePoint(service.display.bounds, x, y, process.platform, (p) => screen.dipToScreenPoint(p));

  // Moves: only the latest matters. Clicks: never dropped, in order. Scroll: summed.
  let pending: ScreenPoint | null = null;
  const clicks: ScreenPoint[] = [];
  const scroll = { up: 0, left: 0 };
  let busy = false;
  const flush = async () => {
    if (busy) return;
    busy = true;
    try {
      while (clicks.length || pending || scroll.up || scroll.left) {
        const c = clicks.shift();
        if (c) {
          await mouse.setPosition(new Point(c.x, c.y));
          await mouse.leftClick();
          opts.onAction?.({ type: "click", ...c });
        } else if (pending) {
          const p = pending;
          pending = null;
          await mouse.setPosition(new Point(p.x, p.y));
          opts.onAction?.({ type: "move", ...p });
        } else {
          const { up, left } = scroll;
          scroll.up = 0;
          scroll.left = 0;
          if (up > 0) await mouse.scrollUp(up);
          else if (up < 0) await mouse.scrollDown(-up);
          if (left > 0) await mouse.scrollLeft(left);
          else if (left < 0) await mouse.scrollRight(-left);
          opts.onAction?.({ type: "scroll", up, left });
        }
      }
    } catch (err) {
      log(`mouse action failed: ${String(err)}`);
    } finally {
      busy = false;
    }
  };

  // "end" carries the rewound position (before the hand changed shape): move there too.
  const offMouse = service.on("mouse", (e) => {
    pending = convert(e.x, e.y);
    void flush();
  });
  const offClick =
    opts.click === false
      ? () => {}
      : service.on("click", (e) => {
          clicks.push(convert(e.x, e.y));
          void flush();
        });

  const toScroll = createScrollConverter(process.platform, opts.scrollPxPerNotch ?? 100);
  const offScroll =
    opts.scroll === false
      ? () => {}
      : service.on("scroll", (e) => {
          if (e.phase !== "move") return;
          const s = toScroll(e.dx, e.dy);
          if (!s.up && !s.left) return;
          scroll.up += s.up;
          scroll.left += s.left;
          void flush();
        });

  return () => {
    offMouse();
    offClick();
    offScroll();
  };
}
