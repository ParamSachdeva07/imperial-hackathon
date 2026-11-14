import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

/**
 * Everything OS-specific about overlay windows lives behind this adapter, so Windows can be added
 * later without touching the rest of the overlay. Only macOS is implemented.
 */
export interface OverlayPlatform {
  /** Extra BrowserWindow options for a transparent, click-through, non-activating overlay. */
  overlayWindowOptions(): BrowserWindowConstructorOptions;
  /** Flags that must be applied after construction (z-level, workspaces, click-through, capture). */
  applyOverlayFlags(win: BrowserWindow, opts: { contentProtection: boolean }): void;
  /** Show without activating / stealing focus. */
  showWithoutFocus(win: BrowserWindow): void;
  /** OS "reduce motion" accessibility preference. */
  prefersReducedMotion(): boolean;
}
