/**
 * DEV-ONLY: the GPT Realtime test window. Bridges the voice renderer to the overlay:
 *   voice:secret  → mint a short-lived Realtime client secret (API key stays in main)
 *   voice:tool    → OverlayControl.handleTool(name, args)
 *   voice:turn    → OverlayControl.onTurnStart(turnId) when the user starts speaking
 * Overlay events are forwarded to the window for its log.
 */
import { join } from "node:path";
import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import type { OverlayControl } from "@pointy/shared/overlay";
import { mintClientSecret, type HarnessContext } from "./realtimeSession";

export const VOICE_IPC = {
  secret: "voice:secret",
  tool: "voice:tool",
  turn: "voice:turn",
  event: "voice:overlay-event",
} as const;

export function openVoiceWindow(opts: {
  control: OverlayControl;
  ctx: HarnessContext;
  apiKey: string | undefined;
  preloadDir: string;
  loadPage: (win: BrowserWindow) => Promise<void>;
}): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 640,
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
    return mintClientSecret(opts.apiKey, opts.ctx);
  });
  ipcMain.handle(VOICE_IPC.tool, async (e, name: unknown, args: unknown) => {
    if (!fromWin(e) || typeof name !== "string") throw new Error("forbidden");
    return opts.control.handleTool(name, args);
  });
  ipcMain.handle(VOICE_IPC.turn, async (e, turnId: unknown) => {
    if (!fromWin(e) || typeof turnId !== "string") throw new Error("forbidden");
    opts.control.onTurnStart(turnId);
  });
  const off = opts.control.onEvent((ev) => {
    if (!win.isDestroyed()) win.webContents.send(VOICE_IPC.event, ev);
  });
  win.on("closed", () => {
    off();
    for (const ch of [VOICE_IPC.secret, VOICE_IPC.tool, VOICE_IPC.turn]) ipcMain.removeHandler(ch);
  });
  void opts.loadPage(win);
  return win;
}
