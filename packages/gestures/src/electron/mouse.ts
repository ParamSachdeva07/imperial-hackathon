/**
 * Opt-in: turn "mouse" and "click" gesture events into real OS mouse moves and left clicks
 * (nut-js, an optional dependency). The session controller decides whether to attach this.
 */
import { screen } from "electron";
import type * as NutJs from "@nut-tree-fork/nut-js";
import { toMousePoint, type ScreenPoint } from "./coords";
import type { GestureService } from "./service";

export interface SystemMouseOptions {
  /** Perform dwell clicks (default true). */
  click?: boolean;
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

  // Moves: only the latest matters. Clicks: never dropped, in order.
  let pending: ScreenPoint | null = null;
  const clicks: ScreenPoint[] = [];
  let busy = false;
  const flush = async () => {
    if (busy) return;
    busy = true;
    try {
      while (clicks.length || pending) {
        const c = clicks.shift();
        if (c) {
          await mouse.setPosition(new Point(c.x, c.y));
          await mouse.leftClick();
        } else if (pending) {
          const p = pending;
          pending = null;
          await mouse.setPosition(new Point(p.x, p.y));
        }
      }
    } catch (err) {
      log(`mouse action failed: ${String(err)}`);
    } finally {
      busy = false;
    }
  };

  const offMouse = service.on("mouse", (e) => {
    if (e.phase === "end") return;
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

  return () => {
    offMouse();
    offClick();
  };
}
