/**
 * Interfaces to teammates (spec §6). The overlay depends only on these; mocks live in
 * apps/desktop/src/main/overlay/mocks and are swapped for the real implementations at integration.
 */
import type { OverlayEvent, Rect, ToolResult } from "./schemas";

/** Bounds of an accessibility element, in global DIP. */
export interface ElementBounds {
  rect: Rect;
  displayId: string;
}

/** From the accessibility/controller teammate. */
export interface BoundsProvider {
  /** Resolve an element id from the current accessibility snapshot. `null` = not found. */
  getBounds(elementId: string): Promise<ElementBounds | null>;
  /** Called whenever the snapshot revision changes. Returns an unsubscribe function. */
  onChange(cb: () => void): () => void;
}

/** From the screen-capture teammate (for `anatomy`). */
export interface ScreenCaptureProvider {
  /**
   * Capture a region of one display.
   * @param displayId Electron display id (as a string).
   * @param rectDip Region in **global** DIP. The provider converts to physical pixels.
   * @returns PNG bytes at physical-pixel resolution.
   */
  captureRegion(displayId: string, rectDip: Rect): Promise<Buffer>;
}

/** Rects the overlay must not place cards/labels over (e.g. the avatar window). Global DIP. */
export interface AvoidRectsProvider {
  getAvoidRects(): Rect[];
}

/** Calls the controller makes into the overlay. */
export interface OverlayControl {
  /**
   * Run a tool call. `opts.caller` (additive, optional; default "model") says who issued it, and is
   * reported as `by` on the resulting `overlay.dismissed` events (e.g. the controller's
   * `clear("all")` on stop/cancel).
   */
  handleTool(name: string, input: unknown, opts?: { caller?: "user" | "model" | "controller" }): Promise<ToolResult>;
  onTurnStart(turnId: string): void;
  onContextChange(): void;
  onTargetSelected(elementId: string): void;
  /** Stretch: reveal cue-gated annotations. */
  cue(cueId: string): void;
  onEvent(cb: (e: OverlayEvent) => void): () => void;
  /** Native window ids of the overlay windows (for capture exclusion filters). */
  getOverlayWindowIds(): number[];
  /** Hide the overlay for the duration of `fn` (e.g. while the capture teammate takes a screenshot). */
  withOverlayHidden<T>(fn: () => Promise<T>): Promise<T>;
}

/** A display as the overlay sees it (Electron `Display`, normalised). All rects in global DIP. */
export interface DisplayInfo {
  id: string;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
}
