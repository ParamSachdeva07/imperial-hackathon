/**
 * Gesture service for the Electron main process.
 *
 * Owns a hidden window that runs the camera + MediaPipe + GestureInterpreter, and exposes the
 * resulting GestureEvents to the session controller:
 *
 *   const gestures = await startGestureService({ preloadPath, loadPage });
 *   gestures.on("wake_requested", () => { gestures.setSessionActive(true); ... });
 *   gestures.on("region_selected", (e) => turnContext.setRegion(e.polygon, e.bbox));
 *
 * It never acts on the desktop itself: moving/clicking the mouse is opt-in (see ./mouse.ts),
 * so the controller stays in charge of what actually happens.
 */
import { BrowserWindow, ipcMain, screen, session, systemPreferences, type IpcMainEvent, type Rectangle } from "electron";
import type { GestureConfig } from "../config";
import type { DisplayInfo, GestureEvent, GestureEventType } from "../events";
import { GESTURE_IPC, isGestureEvent, isVisionStatus, type GestureCommand, type VisionStatus } from "./protocol";

export interface GestureServiceOptions {
  /** Built preload for the vision window (from src/electron/preload.ts). */
  preloadPath: string;
  /** Load the vision page into the window (dev server URL or built file), like loadRendererPage. */
  loadPage: (win: BrowserWindow) => Promise<void>;
  config?: Partial<GestureConfig>;
  /** Show the vision window (camera preview + status) instead of keeping it hidden. Debug only. */
  showWindow?: boolean;
  /** Session partition for the vision window; camera permission is granted to this window only. */
  partition?: string;
}

type EventOf<T extends GestureEventType> = Extract<GestureEvent, { type: T }>;

export interface GestureService {
  on<T extends GestureEventType>(type: T, cb: (e: EventOf<T>) => void): () => void;
  onAny(cb: (e: GestureEvent) => void): () => void;
  onStatus(cb: (s: VisionStatus) => void): () => void;
  /** Open/close the session: when closed, only wake_requested can fire. */
  setSessionActive(active: boolean): void;
  readonly sessionActive: boolean;
  setConfig(config: Partial<GestureConfig>): void;
  /** Display the gestures are mapped to (primary display), with its bounds in DIP. */
  readonly display: DisplayInfo & { bounds: Rectangle };
  readonly window: BrowserWindow;
  dispose(): void;
}

function primaryDisplay(): DisplayInfo & { bounds: Rectangle } {
  const d = screen.getPrimaryDisplay();
  return { id: d.id, width: d.bounds.width, height: d.bounds.height, bounds: d.bounds };
}

export async function startGestureService(opts: GestureServiceOptions): Promise<GestureService> {
  if (process.platform === "darwin") {
    // Triggers the macOS camera prompt (needs NSCameraUsageDescription in the packaged app).
    await systemPreferences.askForMediaAccess("camera");
  }

  const ses = session.fromPartition(opts.partition ?? "pointy-gestures");
  const win = new BrowserWindow({
    show: !!opts.showWindow,
    width: 420,
    height: 360,
    title: "Pointy gestures (debug)",
    skipTaskbar: !opts.showWindow,
    webPreferences: {
      preload: opts.preloadPath,
      session: ses,
      sandbox: true,
      contextIsolation: true,
      // Hidden windows are throttled by Chromium otherwise: detection would drop to ~1 fps.
      backgroundThrottling: false,
    },
  });
  // Camera access for this window only, without touching the app's default session.
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === "media" && wc === win.webContents));
  ses.setPermissionCheckHandler((wc, permission) => permission === "media" && wc === win.webContents);

  let display = primaryDisplay();
  let sessionActive = false;
  let config: Partial<GestureConfig> = { ...opts.config };
  const listeners = new Set<(e: GestureEvent) => void>();
  const statusListeners = new Set<(s: VisionStatus) => void>();

  const send = (cmd: GestureCommand) => {
    if (!win.isDestroyed()) win.webContents.send(GESTURE_IPC.command, cmd);
  };
  const sendAll = () => {
    send({ type: "display", display: { id: display.id, width: display.width, height: display.height } });
    send({ type: "config", config });
    send({ type: "session", active: sessionActive });
  };

  const fromVisionWindow = (e: IpcMainEvent) => !win.isDestroyed() && e.sender === win.webContents;
  const onEvents = (e: IpcMainEvent, payload: unknown) => {
    if (!fromVisionWindow(e) || !Array.isArray(payload)) return;
    for (const ev of payload) {
      if (!isGestureEvent(ev)) continue;
      for (const l of listeners) l(ev);
    }
  };
  const onStatus = (e: IpcMainEvent, payload: unknown) => {
    if (!fromVisionWindow(e) || !isVisionStatus(payload)) return;
    for (const l of statusListeners) l(payload);
  };
  const onReady = (e: IpcMainEvent) => {
    if (fromVisionWindow(e)) sendAll();
  };
  ipcMain.on(GESTURE_IPC.events, onEvents);
  ipcMain.on(GESTURE_IPC.status, onStatus);
  ipcMain.on(GESTURE_IPC.ready, onReady);

  const onDisplaysChanged = () => {
    const next = primaryDisplay();
    if (next.id !== display.id || next.width !== display.width || next.height !== display.height) {
      display = next;
      send({ type: "display", display: { id: display.id, width: display.width, height: display.height } });
    } else {
      display = next;
    }
  };
  screen.on("display-metrics-changed", onDisplaysChanged);
  screen.on("display-added", onDisplaysChanged);
  screen.on("display-removed", onDisplaysChanged);

  // If the vision page crashes, reload it once per minute at most; the session state is re-sent on ready.
  let lastReload = 0;
  win.webContents.on("render-process-gone", (_e, details) => {
    for (const l of statusListeners) l({ type: "error", message: `vision window crashed (${details.reason})` });
    if (Date.now() - lastReload > 60_000 && !win.isDestroyed()) {
      lastReload = Date.now();
      void opts.loadPage(win);
    }
  });

  await opts.loadPage(win);

  return {
    on(type, cb) {
      const l = (e: GestureEvent) => {
        if (e.type === type) cb(e as EventOf<typeof type>);
      };
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onAny(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    setSessionActive(active) {
      sessionActive = active;
      send({ type: "session", active });
    },
    get sessionActive() {
      return sessionActive;
    },
    setConfig(next) {
      config = { ...config, ...next };
      send({ type: "config", config: next });
    },
    get display() {
      return display;
    },
    window: win,
    dispose() {
      ipcMain.off(GESTURE_IPC.events, onEvents);
      ipcMain.off(GESTURE_IPC.status, onStatus);
      ipcMain.off(GESTURE_IPC.ready, onReady);
      screen.off("display-metrics-changed", onDisplaysChanged);
      screen.off("display-added", onDisplaysChanged);
      screen.off("display-removed", onDisplaysChanged);
      listeners.clear();
      statusListeners.clear();
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
