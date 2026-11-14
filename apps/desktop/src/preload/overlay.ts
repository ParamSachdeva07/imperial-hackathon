import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type PaintedMessage, type RenderScene } from "@pointy/shared/overlay/render";
import type { PointyOverlayApi } from "./api";

const api: PointyOverlayApi = {
  onScene(cb) {
    const listener = (_e: IpcRendererEvent, scene: RenderScene) => cb(scene);
    ipcRenderer.on(IPC.render, listener);
    return () => ipcRenderer.removeListener(IPC.render, listener);
  },
  painted(msg: PaintedMessage) {
    ipcRenderer.send(IPC.painted, msg);
  },
  ready() {
    ipcRenderer.send(IPC.ready);
  },
};

contextBridge.exposeInMainWorld("pointyOverlay", api);
