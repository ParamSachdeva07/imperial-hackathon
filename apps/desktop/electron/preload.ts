import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../../../packages/contracts/src/index';
const api: DesktopApi = {
  applications: () => ipcRenderer.invoke('assistant:applications'),
  health: () => ipcRenderer.invoke('assistant:health'),
  state: () => ipcRenderer.invoke('assistant:state'),
  prepare: () => ipcRenderer.invoke('assistant:prepare'),
  inspect: () => ipcRenderer.invoke('assistant:inspect'),
  start: (input, singleStep) => ipcRenderer.invoke('assistant:start', input, singleStep),
  replace: (input, singleStep) => ipcRenderer.invoke('assistant:replace', input, singleStep),
  resume: (singleStep) => ipcRenderer.invoke('assistant:resume', singleStep),
  cancel: () => ipcRenderer.invoke('assistant:cancel'),
  answer: (text) => ipcRenderer.invoke('assistant:answer', text),
  openAccessibilitySettings: () => ipcRenderer.invoke('assistant:accessibility'),
  setOverlayExpanded: (expanded) => ipcRenderer.invoke('assistant:overlay-expanded', expanded),
  onState: (listener) => {
    const wrapped = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('assistant:stateChanged', wrapped);
    return () => ipcRenderer.removeListener('assistant:stateChanged', wrapped);
  },
};
contextBridge.exposeInMainWorld('desktop', api);
