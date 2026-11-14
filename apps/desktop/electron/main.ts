import { app, BrowserWindow, ipcMain, shell, globalShortcut, screen, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { NavigationController } from './controller/navigation';
import { NativeDesktopBridge } from './desktop/native';
import { resolveNativeBinary } from './desktop/native-binary';
import { WorkspaceDesktopBridge } from './desktop/workspace';
import { JevDecisionClient, LocalTestPolicy } from './services/decision-client';
import type { ApiResult } from '../../../packages/contracts/src/index';

app.setName('Desktop Assistant Lab');
const root = process.env.ASSISTANT_ROOT || path.resolve(__dirname, '../../..');
const api = new JevDecisionClient(
  process.env.DECISION_API_URL || 'http://127.0.0.1:8765',
  process.env.DECISION_API_TOKEN || '',
);
let window: BrowserWindow;
let controller: NavigationController;
let bridge: NativeDesktopBridge;
const devUrl = process.env.ASSISTANT_RENDERER_URL;
function trusted(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('Untrusted IPC sender.');
  const url = event.senderFrame.url;
  if (devUrl ? new URL(url).origin !== new URL(devUrl).origin : !url.startsWith('file://'))
    throw new Error('Untrusted application origin.');
}
function handle<T>(channel: string, handler: (...args: any[]) => Promise<T> | T) {
  ipcMain.handle(channel, async (event, ...args): Promise<ApiResult<T>> => {
    try {
      trusted(event);
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unknown application error.' };
    }
  });
}
app.whenReady().then(() => {
  const workspace = new WorkspaceDesktopBridge(
    resolveNativeBinary(root, process.resourcesPath),
    process.env.ASSISTANT_NATIVE_STATE || path.join(app.getPath('userData'), 'native-state'),
  );
  bridge = new NativeDesktopBridge(workspace.binary, workspace.stateRoot);
  controller = new NavigationController(bridge, { jev: api, local: new LocalTestPolicy() }, workspace);
  globalShortcut.register('CommandOrControl+Shift+.', () => controller.cancel());
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  window = new BrowserWindow({
    width: 380,
    height: Math.min(190, workArea.height - 32),
    x: workArea.x + workArea.width - 396,
    y: workArea.y + 16,
    minWidth: 340,
    minHeight: 190,
    title: 'Desktop Assistant',
    backgroundColor: '#e8edf4',
    alwaysOnTop: true,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  let expandedHeight = 480;
  handle('assistant:overlay-expanded', (expanded) => {
    if (typeof expanded !== 'boolean') throw new Error('Invalid overlay size.');
    if (!expanded) expandedHeight = window.getSize()[1];
    const [width] = window.getSize();
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const height = Math.min(expanded ? Math.max(expandedHeight, 400) : 190, area.height);
    window.setBounds({ width, height, y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (devUrl ? new URL(url).origin !== new URL(devUrl).origin : !url.startsWith('file://'))
      event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  if (!devUrl)
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'",
          ],
        },
      });
    });
  handle('assistant:health', async () => ({ native: await bridge.health(), backend: await api.health() }));
  handle('assistant:state', () => controller.state());
  handle('assistant:applications', () => controller.applications());
  handle('assistant:prepare', () => controller.prepare());
  handle('assistant:inspect', () => controller.inspect());
  handle('assistant:start', (input, singleStep) => {
    if (typeof singleStep !== 'boolean') throw new Error('Invalid run mode.');
    return controller.start(input, singleStep);
  });
  handle('assistant:replace', (input, singleStep) => {
    if (typeof singleStep !== 'boolean') throw new Error('Invalid run mode.');
    return controller.replace(input, singleStep);
  });
  handle('assistant:resume', (singleStep) => {
    if (typeof singleStep !== 'boolean') throw new Error('Invalid run mode.');
    return controller.resume(singleStep);
  });
  handle('assistant:cancel', () => controller.cancel());
  handle('assistant:accessibility', async () => {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });
  controller.subscribe((state) => {
    if (!window.isDestroyed()) window.webContents.send('assistant:stateChanged', state);
  });
  window.on('close', () => controller.cancel());
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(path.join(__dirname, '../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
