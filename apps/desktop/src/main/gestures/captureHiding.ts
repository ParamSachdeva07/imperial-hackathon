/**
 * Capture exclusion for the gestures feedback window, mirroring the overlay's
 * `getOverlayWindowIds()` / `withOverlayHidden()`. The window is already content-protected unless
 * POINTY_CAPTURABLE=1; this covers capture paths that ignore content protection. Pure: no Electron
 * import (the window is a structural subset of BrowserWindow), delay injectable.
 */
import type { ScreenCaptureProvider } from "@pointy/shared/overlay";

export interface HideableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  getMediaSourceId(): string;
  hide(): void;
  showInactive(): void;
}

export interface CaptureHiding {
  getWindowIds(): number[];
  withHidden<T>(fn: () => Promise<T>): Promise<T>;
}

const SETTLE_MS = 80;
const defaultDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createCaptureHiding(getWindow: () => HideableWindow | null, delay: (ms: number) => Promise<void> = defaultDelay): CaptureHiding {
  let depth = 0;
  let settled: Promise<void> = Promise.resolve();
  let wasVisible = false;
  return {
    getWindowIds() {
      const w = getWindow();
      if (!w || w.isDestroyed()) return [];
      const n = Number(w.getMediaSourceId().split(":")[1]);
      return Number.isFinite(n) ? [n] : [];
    },
    async withHidden(fn) {
      const w = getWindow();
      if (!w || w.isDestroyed()) return fn();
      depth += 1;
      if (depth === 1) {
        wasVisible = w.isVisible();
        if (wasVisible) {
          w.hide();
          settled = delay(SETTLE_MS);
        }
      }
      try {
        await settled;
        return await fn();
      } finally {
        depth -= 1;
        if (depth === 0 && wasVisible && !w.isDestroyed()) w.showInactive();
      }
    },
  };
}

/** Union of several capture-hiding sources (e.g. AI overlay + gesture feedback window). */
export function combineCaptureHiding(...parts: CaptureHiding[]): CaptureHiding {
  return {
    getWindowIds: () => parts.flatMap((p) => p.getWindowIds()),
    withHidden: <T>(fn: () => Promise<T>): Promise<T> => parts.reduceRight<() => Promise<T>>((inner, p) => () => p.withHidden(inner), fn)(),
  };
}

/**
 * Set of gesture feedback windows that can come and go (the real layer's window, the lazily started
 * simulation window). Windows register themselves; hiding covers whatever is registered at call time.
 */
export interface CaptureHidingRegistry extends CaptureHiding {
  /** Returns the unregister function. */
  register(getWindow: () => HideableWindow | null): () => void;
}

export function createCaptureHidingRegistry(delay?: (ms: number) => Promise<void>): CaptureHidingRegistry {
  const parts = new Set<CaptureHiding>();
  return {
    register(getWindow) {
      const part = createCaptureHiding(getWindow, delay);
      parts.add(part);
      return () => parts.delete(part);
    },
    getWindowIds: () => combineCaptureHiding(...parts).getWindowIds(),
    withHidden: (fn) => combineCaptureHiding(...parts).withHidden(fn),
  };
}

/**
 * Wraps the screen capture provider so every capture runs with the feedback windows hidden. The AI
 * overlay's own hiding (hideDuringCapture) only covers its windows; the feedback windows are separate.
 */
export function hideFeedbackDuringCapture(inner: ScreenCaptureProvider, hiding: CaptureHiding): ScreenCaptureProvider {
  return { captureRegion: (displayId, rect) => hiding.withHidden(() => inner.captureRegion(displayId, rect)) };
}
