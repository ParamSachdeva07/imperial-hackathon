/**
 * On-screen feedback for the user's own gestures, in the main process: a transparent,
 * click-through, always-on-top window over the display that draws the drawing cursor,
 * its trail, the hold rings (selection and dwell click) and the selected point/region.
 *
 * This is NOT the AI's annotation layer (apps/desktop overlay: arrows, highlights, cards).
 * It only mirrors gesture events, so the person can see what they are pointing at or circling.
 *
 *   const feedback = await startGestureFeedback(gestures, { preloadPath, loadPage });
 */
import { BrowserWindow, screen } from "electron";
import type { GestureEvent } from "../events";
import { GESTURE_IPC, type FeedbackMessage } from "./protocol";
import type { GestureService } from "./service";

export interface GestureFeedbackOptions {
  /** Built preload for the feedback window (from src/electron/feedbackPreload.ts). */
  preloadPath: string;
  /** Load the feedback page (its script calls startFeedbackRenderer()). */
  loadPage: (win: BrowserWindow) => Promise<void>;
  /** Exclude the window from screen captures (default true), so the AI never sees our drawings. */
  contentProtection?: boolean;
}

export interface GestureFeedback {
  /** Remove the selected point/region (e.g. when the controller ends the turn). */
  clearSelection(): void;
  readonly window: BrowserWindow;
  dispose(): void;
}

// Events the overlay draws; others (wake, scroll, mouse moves the OS already shows) are not sent.
const DRAWN = new Set<GestureEvent["type"]>([
  "cursor_moved",
  "dwell_progress",
  "point_selected",
  "region_selected",
  "hand_lost",
  "mouse",
  "click_progress",
  "click",
]);

export async function startGestureFeedback(
  service: GestureService,
  opts: GestureFeedbackOptions,
): Promise<GestureFeedback> {
  const bounds = () => screen.getDisplayMatching(service.display.bounds).bounds;
  const b = bounds();
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
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
    enableLargerThanScreen: true,
    backgroundColor: "#00000000",
    show: false,
    // macOS: a panel floats above other apps without activating ours (same as the AI overlay).
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  win.setIgnoreMouseEvents(true); // clicks go through to whatever is underneath
  win.setContentProtection(opts.contentProtection ?? true);
  win.setFocusable(false);

  const send = (msg: FeedbackMessage) => {
    if (!win.isDestroyed()) win.webContents.send(GESTURE_IPC.feedback, msg);
  };

  // Batch the events of one frame into a single IPC message.
  let batch: GestureEvent[] = [];
  let scheduled = false;
  const offEvents = service.onAny((e) => {
    if (!DRAWN.has(e.type)) return;
    batch.push(e);
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      const events = batch;
      batch = [];
      send({ type: "events", events });
    });
  });
  const offSession = service.onSession((active) => send({ type: "session", active }));

  const onDisplay = () => {
    if (!win.isDestroyed()) win.setBounds(bounds());
  };
  screen.on("display-metrics-changed", onDisplay);

  await opts.loadPage(win);
  win.showInactive();
  send({ type: "session", active: service.sessionActive });

  return {
    clearSelection: () => send({ type: "clear" }),
    window: win,
    dispose() {
      offEvents();
      offSession();
      screen.off("display-metrics-changed", onDisplay);
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
