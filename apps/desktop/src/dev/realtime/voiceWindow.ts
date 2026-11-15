/**
 * DEV-ONLY: the GPT Realtime test window. Bridges the voice renderer to the overlay:
 *   voice:secret  → mint a short-lived Realtime client secret (API key stays in main)
 *   voice:tool    → OverlayControl.handleTool(name, args)
 *   voice:turn    → OverlayControl.onTurnStart(turnId) when the user starts speaking
 * Overlay events are forwarded to the window for its log.
 */
import { join } from "node:path";
import { BrowserWindow, ipcMain, screen, session, type IpcMainInvokeEvent } from "electron";
import { VOICE_WINDOW_WIDTH } from "../fixtureWindow";
import type { OverlayControl } from "@pointy/shared/overlay";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import { buildInstructions, mintClientSecret, type HarnessContext } from "./realtimeSession";

export const VOICE_IPC = {
  secret: "voice:secret",
  tool: "voice:tool",
  turn: "voice:turn",
  instructions: "voice:instructions",
  fixture: "voice:fixture",
  event: "voice:overlay-event",
  /** main → voice window: a SelectionSnapshot from a gesture. */
  selection: "voice:selection",
  /** voice window -> main: the current (session-bound) selection, asked for when the channel opens. */
  latestSelection: "voice:selection-latest",
} as const;

export function openVoiceWindow(opts: {
  control: OverlayControl;
  ctx: HarnessContext;
  apiKey: string | undefined;
  preloadDir: string;
  /** Open (or show) the fake mail app the AI points at, and wait until its buttons are reported. */
  ensureFixture: () => Promise<void>;
  loadPage: (win: BrowserWindow) => Promise<void>;
  /** Gesture selections to hand to the model; each snapshot is pushed to this window only. */
  selectionSource?: { onSnapshot(cb: (s: SelectionSnapshot) => void): () => void; latest(): SelectionSnapshot | null };
}): BrowserWindow {
  // Top-right of the primary screen, beside (not on top of) the fake mail app.
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: VOICE_WINDOW_WIDTH,
    height: Math.min(640, wa.height - 32),
    x: wa.x + wa.width - VOICE_WINDOW_WIDTH - 16,
    y: wa.y + 16,
    title: "Pointy Voice Test (GPT Realtime)",
    webPreferences: { preload: join(opts.preloadDir, "voice.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const fromWin = (e: IpcMainInvokeEvent) => !win.isDestroyed() && e.sender.id === win.webContents.id;

  // Only this window may use the microphone.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === "media" && !win.isDestroyed() && wc.id === win.webContents.id);
  });

  ipcMain.handle(VOICE_IPC.secret, async (e) => {
    if (!fromWin(e)) throw new Error("forbidden");
    if (!opts.apiKey) throw new Error("OPENAI_API_KEY is not set (add it to the repo-root .env)");
    // The AI can only point at what's on screen: make sure the test app is open first.
    await opts.ensureFixture();
    return mintClientSecret(opts.apiKey, opts.ctx);
  });
  // Fresh instructions (current on-screen element ids) for a session.update on each user turn.
  ipcMain.handle(VOICE_IPC.instructions, async (e) => {
    if (!fromWin(e)) throw new Error("forbidden");
    return buildInstructions(opts.ctx);
  });
  ipcMain.handle(VOICE_IPC.fixture, async (e) => {
    if (!fromWin(e)) throw new Error("forbidden");
    await opts.ensureFixture();
    return opts.ctx.listElements().length;
  });
  ipcMain.handle(VOICE_IPC.tool, async (e, name: unknown, args: unknown) => {
    if (!fromWin(e) || typeof name !== "string") throw new Error("forbidden");
    return opts.control.handleTool(name, args);
  });
  ipcMain.handle(VOICE_IPC.turn, async (e, turnId: unknown) => {
    if (!fromWin(e) || typeof turnId !== "string") throw new Error("forbidden");
    opts.control.onTurnStart(turnId);
  });
  // Pull model: the store is cleared when the gesture session closes, so a selection is never held
  // (and never replayed) in the renderer beyond its session.
  ipcMain.handle(VOICE_IPC.latestSelection, async (e) => {
    if (!fromWin(e)) throw new Error("forbidden");
    return opts.selectionSource?.latest() ?? null;
  });
  const off = opts.control.onEvent((ev) => {
    if (!win.isDestroyed()) win.webContents.send(VOICE_IPC.event, ev);
  });
  const offSelection = opts.selectionSource?.onSnapshot((s) => {
    if (!win.isDestroyed()) win.webContents.send(VOICE_IPC.selection, s);
  });
  win.on("closed", () => {
    off();
    offSelection?.();
    for (const ch of [VOICE_IPC.secret, VOICE_IPC.tool, VOICE_IPC.turn, VOICE_IPC.instructions, VOICE_IPC.fixture, VOICE_IPC.latestSelection]) {
      ipcMain.removeHandler(ch);
    }
  });
  void opts.loadPage(win);
  return win;
}
