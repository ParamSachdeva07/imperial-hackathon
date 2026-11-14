import { contextBridge, ipcRenderer } from "electron";
import { IPC, type FixtureBoundsMessage } from "@pointy/shared/overlay/render";
import type { PointyFixtureApi } from "./api";

const api: PointyFixtureApi = {
  reportBounds(msg: FixtureBoundsMessage) {
    ipcRenderer.send(IPC.fixtureBounds, msg);
  },
};

contextBridge.exposeInMainWorld("pointyFixture", api);
