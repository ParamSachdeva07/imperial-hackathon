import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayBridge } from '../shared/bridge.js';

const bridge: OverlayBridge = {
  getSessionToken: () => ipcRenderer.invoke('anam:session-token'),
  requestMicrophone: () => ipcRenderer.invoke('overlay:microphone'),
  setExpanded: (expanded) => ipcRenderer.invoke('overlay:expanded', expanded),
  getLauncherVisibility: () => ipcRenderer.invoke('overlay:launcher-visibility'),
  onLauncherVisibility: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
    ipcRenderer.on('overlay:launcher-visibility', listener);
    return () => ipcRenderer.removeListener('overlay:launcher-visibility', listener);
  },
  setLauncherFocused: (focused) => ipcRenderer.send('overlay:launcher-focused', focused),
  moveStart: () => ipcRenderer.send('overlay:move-start'),
  moveUpdate: () => ipcRenderer.send('overlay:move-update'),
  moveEnd: () => ipcRenderer.send('overlay:move-end'),
  resizeBy: (amount) => ipcRenderer.send('overlay:resize-by', amount),
  moveBy: (x, y) => ipcRenderer.send('overlay:move-by', x, y),
};
contextBridge.exposeInMainWorld('overlay', Object.freeze(bridge));
