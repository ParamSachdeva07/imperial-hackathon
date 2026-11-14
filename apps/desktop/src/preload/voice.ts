/** DEV-ONLY preload for the GPT Realtime test window. */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { OverlayEvent, ToolResult } from "@pointy/shared/overlay/schemas";

const api = {
  getSecret: (): Promise<{ value: string; expiresAt: number; model: string }> => ipcRenderer.invoke("voice:secret"),
  callTool: (name: string, args: unknown): Promise<ToolResult> => ipcRenderer.invoke("voice:tool", name, args),
  turnStart: (turnId: string): Promise<void> => ipcRenderer.invoke("voice:turn", turnId),
  onOverlayEvent(cb: (e: OverlayEvent) => void): () => void {
    const l = (_e: IpcRendererEvent, ev: OverlayEvent) => cb(ev);
    ipcRenderer.on("voice:overlay-event", l);
    return () => ipcRenderer.removeListener("voice:overlay-event", l);
  },
};

export type PointyVoiceApi = typeof api;
contextBridge.exposeInMainWorld("pointyVoice", api);
