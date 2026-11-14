import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type GestureFeedbackMessage, type PaintedMessage, type RenderScene } from "@pointy/shared/overlay/render";
import type { PointyOverlayApi } from "./api";

const api: PointyOverlayApi = {
  onScene(cb) {
    const listener = (_e: IpcRendererEvent, scene: RenderScene) => cb(scene);
    ipcRenderer.on(IPC.render, listener);
    return () => ipcRenderer.removeListener(IPC.render, listener);
  },
  onImage(cb) {
    const listener = (_e: IpcRendererEvent, msg: { key: string; src: string }) => cb(msg);
    ipcRenderer.on(IPC.image, listener);
    return () => ipcRenderer.removeListener(IPC.image, listener);
  },
  onImageDrop(cb) {
    const listener = (_e: IpcRendererEvent, msg: { keys: string[] }) => cb(msg);
    ipcRenderer.on(IPC.imageDrop, listener);
    return () => ipcRenderer.removeListener(IPC.imageDrop, listener);
  },
  onGesture(cb) {
    const listener = (_e: IpcRendererEvent, msg: GestureFeedbackMessage) => cb(msg);
    ipcRenderer.on(IPC.gesture, listener);
    return () => ipcRenderer.removeListener(IPC.gesture, listener);
  },
  imageFailed(msg) {
    ipcRenderer.send(IPC.imageFailed, msg);
  },
  painted(msg: PaintedMessage) {
    ipcRenderer.send(IPC.painted, msg);
  },
  ready() {
    ipcRenderer.send(IPC.ready);
  },
};

contextBridge.exposeInMainWorld("pointyOverlay", api);
