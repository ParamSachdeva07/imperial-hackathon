/** Preload for the feedback overlay window (sandboxed; bundle with externalizeDeps: false). */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { PointyGestureFeedbackApi } from "./api";
import { GESTURE_IPC, type FeedbackMessage } from "./protocol";

const api: PointyGestureFeedbackApi = {
  onMessage(cb) {
    const listener = (_e: IpcRendererEvent, msg: FeedbackMessage) => cb(msg);
    ipcRenderer.on(GESTURE_IPC.feedback, listener);
    return () => ipcRenderer.off(GESTURE_IPC.feedback, listener);
  },
};

contextBridge.exposeInMainWorld("pointyGestureFeedback", api);
