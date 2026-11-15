/**
 * Preload for the hidden vision window. Bundle it as a sandboxed preload
 * (electron-vite: externalizeDeps: false), like apps/desktop/src/preload/*.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { PointyGesturesApi } from "./api";
import { GESTURE_IPC, type GestureCommand } from "./protocol";

const api: PointyGesturesApi = {
  emit(events) {
    if (events.length) ipcRenderer.send(GESTURE_IPC.events, events);
  },
  status(status) {
    ipcRenderer.send(GESTURE_IPC.status, status);
  },
  onCommand(cb) {
    const listener = (_e: IpcRendererEvent, cmd: GestureCommand) => cb(cmd);
    ipcRenderer.on(GESTURE_IPC.command, listener);
    return () => ipcRenderer.off(GESTURE_IPC.command, listener);
  },
  ready() {
    ipcRenderer.send(GESTURE_IPC.ready);
  },
};

contextBridge.exposeInMainWorld("pointyGestures", api);
