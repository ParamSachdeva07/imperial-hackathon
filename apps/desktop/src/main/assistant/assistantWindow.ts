/**
 * The hidden Realtime window (electron side): a never-shown BrowserWindow whose page owns the WebRTC
 * session + microphone. Exposes a RealtimeTransport for AssistantController. The OpenAI API key stays
 * in main: the page only gets a short-lived client secret through ipc `assistant:secret`.
 */
import { join } from "node:path";
import { BrowserWindow, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { ASSISTANT_IPC, type AssistantCommand, type AssistantMessage } from "./ipc";
import { RendererTransport } from "./rendererTransport";
import type { AssistantSecret } from "./secret";

export interface AssistantWindowOptions {
  /** Directory with the built preload scripts (PRELOAD_DIR). */
  preloadDir: string;
  /** Load renderer page "assistant" into the window (loadRendererPage(win, "assistant")). */
  loadPage(win: BrowserWindow): Promise<void>;
  /** Mint a client secret (mintAssistantSecret bound to apiKey/instructions/tools). */
  mintSecret(): Promise<AssistantSecret>;
  log?(msg: string): void;
}

export interface AssistantWindow {
  transport: RendererTransport;
  window: BrowserWindow;
  dispose(): void;
}

export function createAssistantWindow(opts: AssistantWindowOptions): AssistantWindow {
  const log = opts.log ?? (() => {});
  // A dedicated session: only this page may use the microphone, and the app-wide default session
  // (camera for gestures, etc.) is left alone.
  const ses = session.fromPartition("pointy-assistant");
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    skipTaskbar: true,
    webPreferences: {
      preload: join(opts.preloadDir, "assistant.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      session: ses,
    },
  });
  const wcId = win.webContents.id;
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === "media" && wc.id === wcId));
  ses.setPermissionCheckHandler((wc, permission) => permission === "media" && wc?.id === wcId);

  const listeners = new Set<(m: AssistantMessage) => void>();
  const onMessage = (e: IpcMainEvent, m: AssistantMessage) => {
    if (e.sender.id !== wcId) return;
    for (const cb of [...listeners]) cb(m);
  };
  ipcMain.on(ASSISTANT_IPC.message, onMessage);
  ipcMain.handle(ASSISTANT_IPC.secret, async (e: IpcMainInvokeEvent) => {
    if (e.sender.id !== wcId) throw new Error("forbidden");
    return opts.mintSecret();
  });

  // Commands sent before the page finished loading would be lost: hold them until it has.
  let loaded = false;
  const queue: AssistantCommand[] = [];
  const deliver = (cmd: AssistantCommand) => {
    if (!win.isDestroyed()) win.webContents.send(ASSISTANT_IPC.command, cmd);
  };
  const transport = new RendererTransport({
    channel: {
      send(cmd) {
        if (loaded) deliver(cmd);
        else queue.push(cmd);
      },
      onMessage(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  });
  void opts
    .loadPage(win)
    .then(() => {
      loaded = true;
      for (const c of queue.splice(0)) deliver(c);
    })
    .catch((e: unknown) => log(`assistant page failed to load: ${String(e)}`));

  return {
    transport,
    window: win,
    dispose() {
      ipcMain.removeListener(ASSISTANT_IPC.message, onMessage);
      ipcMain.removeHandler(ASSISTANT_IPC.secret);
      transport.dispose();
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
