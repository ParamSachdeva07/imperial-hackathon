/**
 * One-time hint when one-finger / fist events arrive from the camera but the real mouse is not wired
 * (POINTY_GESTURES_MOUSE is off): otherwise one finger and fist scrolling look dead. Pure; the log is injected.
 */
import type { GestureEvent } from "@pointy/gestures";

export const MOUSE_OFF_STARTUP = "mouse=OFF: one-finger cursor, dwell click and fist scroll do NOT move the OS mouse (two-finger drawing/selection still works). Run `npm run app:gestures:mouse` (POINTY_GESTURES_MOUSE=1) and grant macOS Accessibility.";
export const MOUSE_OFF_HINT = "one-finger / fist hand pose detected, but the real mouse is NOT attached (POINTY_GESTURES_MOUSE is not 1), so nothing moves. Run `npm run app:gestures:mouse` and grant macOS Accessibility to the terminal / Electron.";
export const ACCESSIBILITY_HINT = "macOS Accessibility is NOT granted to this process: the OS mouse will silently not move. Grant it to your terminal (or Electron) in System Settings > Privacy & Security > Accessibility, then restart the app.";

/** Returns a listener for real-service events; logs MOUSE_OFF_HINT once on the first mouse / scroll / click. */
export function createMouseOffHint(log: (msg: string) => void): (e: GestureEvent) => void {
  let said = false;
  return (e) => {
    if (said || (e.type !== "mouse" && e.type !== "scroll" && e.type !== "click")) return;
    said = true;
    log(MOUSE_OFF_HINT);
  };
}
