/** Preload for the hidden production-assistant window (Realtime WebRTC + mic). */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AssistantCommand, AssistantMessage } from "../main/assistant/ipc";

const api = {
  getSecret: (): Promise<{ value: string; expiresAt: number; model: string }> => ipcRenderer.invoke("assistant:secret"),
  emit: (m: AssistantMessage): void => ipcRenderer.send("assistant:msg", m),
  onCommand(cb: (c: AssistantCommand) => void): () => void {
    const l = (_e: IpcRendererEvent, c: AssistantCommand) => cb(c);
    ipcRenderer.on("assistant:cmd", l);
    return () => ipcRenderer.removeListener("assistant:cmd", l);
  },
};

export type PointyAssistantApi = typeof api;
contextBridge.exposeInMainWorld("pointyAssistant", api);
