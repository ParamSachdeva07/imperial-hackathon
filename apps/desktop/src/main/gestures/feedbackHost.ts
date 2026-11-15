/**
 * Starts the gesture package's own feedback window (cursor, trail, rings, wake ring, selection of
 * the USER's hand). The AI overlay draws none of this.
 * Shared by the real gesture layer (startGestures.ts) and the camera-free dev simulation (devHarness.ts).
 */
import { join } from "node:path";
import { screen } from "electron";
import type { GestureService } from "@pointy/gestures/electron";
import { startGestureFeedback, type GestureFeedback } from "@pointy/gestures/electron/feedback";
import { loadRendererPage, PRELOAD_DIR } from "../rendererPages";
import { createCaptureHidingRegistry } from "./captureHiding";
import type { FeedbackGestureService } from "./SimGestureService";

/** Every feedback window launched below (real layer or lazy simulation) registers here for capture hiding. */
export const feedbackCaptureHiding = createCaptureHidingRegistry();

/** Primary display in the shape the gesture service reports it. */
export function primaryDisplayInfo(): FeedbackGestureService["display"] {
  const d = screen.getPrimaryDisplay();
  return { id: d.id, width: d.bounds.width, height: d.bounds.height, bounds: d.bounds };
}

/** Query string for the feedback page: how long the selection outline stays (default: the package's 4 s). */
export function feedbackQuery(selectionTtlMs?: number): string {
  return selectionTtlMs && Number.isFinite(selectionTtlMs) && selectionTtlMs > 0 ? `?selectionTtlMs=${Math.round(selectionTtlMs)}` : "";
}

/** Never throws: a feedback failure is logged and returns null (gestures keep working without it). */
export async function launchGestureFeedback(
  service: FeedbackGestureService,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void,
  opts: { selectionTtlMs?: number } = {},
): Promise<GestureFeedback | null> {
  try {
    // startGestureFeedback only uses the members of FeedbackGestureService (onAny, onSession, sessionActive, display).
    const feedback = await startGestureFeedback(service as unknown as GestureService, {
      preloadPath: join(PRELOAD_DIR, "gestureFeedback.js"),
      loadPage: (w) => loadRendererPage(w, "gestureFeedback", feedbackQuery(opts.selectionTtlMs)),
      contentProtection: env.POINTY_CAPTURABLE !== "1",
    });
    const unregister = feedbackCaptureHiding.register(() => feedback.window);
    log(`feedback window started (contentProtection=${env.POINTY_CAPTURABLE !== "1"})`);
    return {
      clearSelection: () => feedback.clearSelection(),
      window: feedback.window,
      dispose: () => {
        unregister();
        feedback.dispose();
      },
    };
  } catch (err) {
    log(`feedback window failed (gestures keep running): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return null;
  }
}
