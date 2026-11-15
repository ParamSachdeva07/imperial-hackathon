import { app, BrowserWindow, ipcMain, shell, globalShortcut, screen, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { NavigationController } from './controller/navigation';
import { resolveNativeBinary } from './desktop/native-binary';
import { WorkspaceDesktopBridge } from './desktop/workspace';
import { DecisionClient } from './services/decision-client';
import { defaultBrowserBundle } from './desktop/app-discovery';
import { PageBridgeServer } from './page/page-bridge-server';
import { PageWorkspace } from './page/page-workspace';
import { PageAwareBridge } from './page/page-aware-bridge';
import type { ApiResult } from '../../../packages/contracts/src/index';

app.setName('Desktop Assistant Lab');
const root = process.env.ASSISTANT_ROOT || path.resolve(__dirname, '../../..');
const api = new DecisionClient(
  process.env.DECISION_API_URL || 'http://127.0.0.1:8765',
  process.env.DECISION_API_TOKEN || '',
);
let window: BrowserWindow;
let controller: NavigationController;
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
  // The browser extension, when installed, reads and operates Chrome pages directly.
  // If its port is taken or the extension is absent, everything runs through accessibility.
  const pageServer = new PageBridgeServer();
  if (process.env.ASSISTANT_PAGE_BRIDGE !== 'off') void pageServer.start();
  app.on('will-quit', () => pageServer.stop());
  controller = new NavigationController(new PageAwareBridge(workspace, new PageWorkspace(pageServer), defaultBrowserBundle), api,
    process.env.ASSISTANT_TRACE_DIR || path.join(app.getPath('userData'), 'traces'), defaultBrowserBundle);
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
  handle('assistant:health', async () => ({ native: await workspace.health(), backend: await api.health(),
    pageBridge: { connected: pageServer.connected, needsReload: pageServer.needsReload } }));
  handle('assistant:state', () => controller.state());
  handle('assistant:start', (input) => controller.start(input));
  handle('assistant:replace', (input) => controller.replace(input));
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
