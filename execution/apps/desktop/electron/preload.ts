import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../../../packages/contracts/src/index';
const api: DesktopApi = {
  health: () => ipcRenderer.invoke('assistant:health'),
  state: () => ipcRenderer.invoke('assistant:state'),
  start: (input) => ipcRenderer.invoke('assistant:start', input),
  replace: (input) => ipcRenderer.invoke('assistant:replace', input),
  cancel: () => ipcRenderer.invoke('assistant:cancel'),
  openAccessibilitySettings: () => ipcRenderer.invoke('assistant:accessibility'),
  setOverlayExpanded: (expanded) => ipcRenderer.invoke('assistant:overlay-expanded', expanded),
  onState: (listener) => {
    const wrapped = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('assistant:stateChanged', wrapped);
    return () => ipcRenderer.removeListener('assistant:stateChanged', wrapped);
  },
};
contextBridge.exposeInMainWorld('desktop', api);
