/**
 * macOS overlay window adapter (spec §5.1).
 */
import { systemPreferences, type BrowserWindow } from "electron";
import type { OverlayPlatform } from "./types";

export const macPlatform: OverlayPlatform = {
  overlayWindowOptions() {
    return {
      transparent: true,
      frame: false,
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // NSPanel: floats above other apps and never activates our app (verified in Phase 1).
      type: "panel",
      // Let the window cover the menu bar strip and span the whole display.
      enableLargerThanScreen: true,
      roundedCorners: false,
      backgroundColor: "#00000000",
      show: false,
    };
  },

  applyOverlayFlags(win: BrowserWindow, { contentProtection }) {
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(contentProtection);
    win.setFocusable(false);
  },

  showWithoutFocus(win: BrowserWindow) {
    win.showInactive();
  },

  prefersReducedMotion() {
    try {
      return systemPreferences.getAnimationSettings().prefersReducedMotion;
    } catch {
      return false;
    }
  },
};
