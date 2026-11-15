import { app, BrowserWindow, ipcMain, Menu, screen, session, systemPreferences } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import type { TokenResult } from '../shared/bridge.js';
import { startControlServer } from './control.mjs';
import type { ControlServer } from './control.mjs';
import { createSpeakController } from './speak.mjs';
import type { SpeakCommand } from './speak.mjs';

// Only FastAPI is allowed to read backend/.env.
delete process.env.ANAM_API_KEY;
const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererFile = path.join(directory, '../dist/index.html');
const dev = process.env.OVERLAY_DEV === '1';
// Speak-only: another local app (Pointy) drives the avatar as a mouth. No mic, no sendUserMessage.
const speakOnly = process.env.ANAM_SPEAK_ONLY === '1';
const speaker = speakOnly ? createSpeakController({
  send: sendSpeakCommand,
  // Collapsing waits for the page's closing animation; a call started again meanwhile keeps the window open.
  setExpanded: (value) => {
    if (value) return setExpanded(true, false);
    setTimeout(() => { const s = speaker?.state(); if (!s?.connected && !s?.starting) setExpanded(false, false); }, CLOSE_MS);
  },
}) : null;
const CLOSE_MS = 280;
const rendererURL = dev ? 'http://127.0.0.1:5173/' : pathToFileURL(rendererFile).href;
let overlay: BrowserWindow | null = null;
let control: ControlServer | null = null;
let quitting = false;
const DOT_SIZE = 56;
const CONTROLS_HEIGHT = 80;
let expanded = false;
let expandedWidth = 320;
let move: { cursor: Electron.Point; bounds: Rectangle } | null = null;
let tokenRequest: Promise<TokenResult> | null = null;
let launcherVisible = false;
let launcherFocused = false;
let outsideSince: number | null = null;
let hoverTimer: ReturnType<typeof setInterval> | null = null;

function revealLauncher(visible: boolean) {
  if (!overlay) return;
  const next = !expanded && visible;
  // Hidden launcher windows must not intercept clicks in other applications.
  overlay.setIgnoreMouseEvents(!expanded && !next, { forward: true });
  if (launcherVisible === next) return;
  launcherVisible = next;
  overlay.webContents.send('overlay:launcher-visibility', next);
}

const CORNER = 56;

function checkCornerHover() {
  if (!overlay || expanded) return;
  const bounds = overlay.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const cursor = screen.getCursorScreenPoint();
  const right = display.bounds.x + display.bounds.width;
  // Include the menu bar: the cursor can start at the actual top-right pixel.
  // Only a cursor that has travelled into the corner itself brings the button out (it slides in diagonally from there).
  const inCorner = cursor.x >= right - CORNER && cursor.x < right
    && cursor.y >= display.bounds.y && cursor.y <= display.workArea.y + CORNER;
  const onLauncher = cursor.x >= bounds.x - 12 && cursor.x <= bounds.x + bounds.width + 12
    && cursor.y >= bounds.y - 12 && cursor.y <= bounds.y + bounds.height + 12;
  if (inCorner || onLauncher || launcherFocused) {
    outsideSince = null;
    if (!launcherVisible) revealLauncher(true);
  } else if (launcherVisible) {
    outsideSince ??= Date.now();
    // Allow the pointer to cross the gap without the button disappearing.
    if (Date.now() - outsideSince >= 400) revealLauncher(false);
  }
}

function trustedURL(url: string) {
  try {
    const parsed = new URL(url);
    return dev ? parsed.origin === 'http://127.0.0.1:5173' : parsed.href === rendererURL;
  } catch { return false; }
}

function trusted(event: IpcMainEvent | IpcMainInvokeEvent) {
  return !!overlay && event.sender === overlay.webContents
    && event.senderFrame === overlay.webContents.mainFrame && trustedURL(event.senderFrame.url);
}

async function fetchToken(): Promise<TokenResult> {
  try {
    const response = await fetch('http://127.0.0.1:8765/api/session-token', {
      method: 'POST', headers: { 'X-Anam-Overlay': '1' },
      signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store',
    });
    const body = await response.json() as { detail?: unknown; sessionToken?: unknown };
    if (!response.ok) return { ok: false, error: typeof body.detail === 'string'
      ? body.detail.slice(0, 240) : 'The local backend could not create a session.' };
    if (typeof body.sessionToken !== 'string' || !body.sessionToken.trim()) {
      return { ok: false, error: 'The local backend returned no session token.' };
    }
    return { ok: true, sessionToken: body.sessionToken };
  } catch {
    return { ok: false, error: 'Cannot reach the local backend. Start FastAPI on 127.0.0.1:8765 and retry.' };
  }
}

function placeWindow(bounds: Rectangle) {
  if (!overlay) return;
  const area = screen.getDisplayMatching(bounds).workArea;
  overlay.setBounds({ ...bounds,
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - bounds.width, bounds.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - bounds.height, bounds.y))),
  });
}

function setExpanded(value: boolean, focus = true) {
  if (!overlay || expanded === value) return;
  const bounds = overlay.getBounds();
  expanded = value;
  move = null;
  launcherFocused = false;
  outsideSince = null;
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = value ? Math.min(expandedWidth, area.width, area.height - CONTROLS_HEIGHT) : DOT_SIZE;
  const height = value ? width + CONTROLS_HEIGHT : DOT_SIZE;
  // A completed call always docks back at this screen's top-right corner.
  placeWindow({ x: value ? bounds.x + bounds.width - width : area.x + area.width - DOT_SIZE - 16,
    y: value ? bounds.y : area.y + 16, width, height });
  revealLauncher(false);
  // Externally driven expansion must not steal focus from the app the user is working in.
  if (value && focus) overlay.focus();
}

function sendSpeakCommand(command: SpeakCommand) {
  const target = overlay?.webContents;
  if (!target) return;
  if (target.isLoading()) target.once('did-finish-load', () => target.send('anam:speak-command', command));
  else target.send('anam:speak-command', command);
}

function resizeBy(amount: number) {
  if (!overlay || !expanded) return;
  const bounds = overlay.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  expandedWidth = Math.round(Math.min(480, area.width, area.height - CONTROLS_HEIGHT,
    Math.max(240, bounds.width + amount)));
  placeWindow({ x: bounds.x + bounds.width - expandedWidth, y: bounds.y,
    width: expandedWidth, height: expandedWidth + CONTROLS_HEIGHT });
}

const safeDelta = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && Math.abs(value) <= 100;

ipcMain.handle('anam:session-token', async (event): Promise<TokenResult> => {
  if (!trusted(event)) return { ok: false, error: 'Untrusted window.' };
  tokenRequest ??= fetchToken().finally(() => { tokenRequest = null; });
  return tokenRequest;
});
ipcMain.handle('overlay:microphone', async (event) => {
  if (!trusted(event)) return false;
  if (speakOnly) return false; // never request the microphone in speak-only mode
  if (process.platform !== 'darwin') return true;
  try { return await systemPreferences.askForMediaAccess('microphone'); }
  catch { return false; }
});
ipcMain.handle('anam:mode', (event) => ({ speakOnly: trusted(event) && speakOnly, lipSync: trusted(event) && speakOnly && process.env.ANAM_LIP_SYNC === '1' }));
ipcMain.on('anam:speak-report', (event, report: unknown) => {
  if (!trusted(event) || !speaker || !report || typeof report !== 'object') return;
  const { connected, speaking, muted, session } = report as { connected?: unknown; speaking?: unknown; muted?: unknown; session?: unknown };
  speaker.report({
    ...(typeof connected === 'boolean' ? { connected } : {}),
    ...(typeof speaking === 'boolean' ? { speaking } : {}),
    ...(typeof muted === 'boolean' ? { muted } : {}),
    ...(typeof session === 'number' && Number.isInteger(session) ? { session } : {}),
  });
});
ipcMain.handle('overlay:expanded', (event, value: unknown) => {
  if (trusted(event) && typeof value === 'boolean') setExpanded(value);
});
ipcMain.handle('overlay:launcher-visibility', (event) => trusted(event) && launcherVisible);
ipcMain.on('overlay:launcher-focused', (event, value: unknown) => {
  if (!trusted(event) || typeof value !== 'boolean' || expanded) return;
  launcherFocused = value;
  if (value) revealLauncher(true);
});
ipcMain.on('overlay:move-start', (event) => {
  if (trusted(event) && overlay && expanded) move = { cursor: screen.getCursorScreenPoint(), bounds: overlay.getBounds() };
});
ipcMain.on('overlay:move-update', (event) => {
  if (!trusted(event) || !move) return;
  const cursor = screen.getCursorScreenPoint();
  placeWindow({ ...move.bounds, x: move.bounds.x + cursor.x - move.cursor.x,
    y: move.bounds.y + cursor.y - move.cursor.y });
});
ipcMain.on('overlay:move-end', (event) => { if (trusted(event)) move = null; });
ipcMain.on('overlay:resize-by', (event, amount: unknown) => {
  if (trusted(event) && safeDelta(amount)) resizeBy(amount);
});
ipcMain.on('overlay:move-by', (event, dx: unknown, dy: unknown) => {
  if (!trusted(event) || !overlay || !expanded || !safeDelta(dx) || !safeDelta(dy)) return;
  const bounds = overlay.getBounds();
  placeWindow({ ...bounds, x: bounds.x + dx, y: bounds.y + dy });
});

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  overlay = new BrowserWindow({
    title: 'Anam Overlay', width: DOT_SIZE, height: DOT_SIZE,
    x: area.x + area.width - DOT_SIZE - 16, y: area.y + 16,
    minWidth: DOT_SIZE, minHeight: DOT_SIZE,
    // Electron does not support native resize reliably on transparent windows.
    // Expand/collapse and context-menu sizing use bounded setBounds calls.
    resizable: false, maximizable: false, fullscreenable: false,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, hasShadow: false, show: false,
    // macOS: an NSPanel (like Pointy's overlay) can float over another app's full-screen Space;
    // a normal window stays on the desktop Space even with visibleOnFullScreen.
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: path.join(directory, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, spellcheck: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'floating');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.once('ready-to-show', () => overlay?.showInactive());
  hoverTimer = setInterval(checkCornerHover, 100);
  hoverTimer.unref();
  overlay.on('closed', () => {
    if (hoverTimer) clearInterval(hoverTimer);
    hoverTimer = null; overlay = null; move = null;
  });
  overlay.on('blur', () => { move = null; launcherFocused = false; });
  overlay.webContents.on('before-input-event', (_event, input) => {
    if (!expanded && input.type === 'keyDown' && input.key === 'Tab') {
      launcherFocused = true;
      revealLauncher(true);
    }
  });
  overlay.webContents.on('context-menu', () => {
    if (!overlay) return;
    Menu.buildFromTemplate([
      { label: 'Larger avatar', enabled: expanded, click: () => resizeBy(40) },
      { label: 'Smaller avatar', enabled: expanded, click: () => resizeBy(-40) },
      { type: 'separator' },
      { label: 'Quit Anam', role: 'quit' },
    ]).popup({ window: overlay });
  });
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', (event) => event.preventDefault());
  overlay.webContents.on('will-attach-webview', (event) => event.preventDefault());
  void (dev ? overlay.loadURL(rendererURL) : overlay.loadFile(rendererFile));
}

app.setName('Anam Overlay');
void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === overlay?.webContents && trustedURL(contents.getURL())
      && !speakOnly && details.isMainFrame && permission === 'media'
      && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === overlay?.webContents && !!contents && trustedURL(contents.getURL())
    && !speakOnly && permission === 'media' && details.mediaType === 'audio');
  createWindow();
  startControlServer({
    ...(speaker ? { speak: speaker } : {}),
    getState: () => {
      if (!overlay) return null;
      const bounds = overlay.getBounds();
      const display = screen.getDisplayMatching(bounds);
      return { expanded, dragging: move !== null, bounds, workArea: display.workArea, displayId: String(display.id) };
    },
    moveTo: (x, y) => {
      if (!overlay) return null;
      placeWindow({ ...overlay.getBounds(), x, y });
      return overlay.getBounds();
    },
  }).then((server) => {
    if (quitting) { server.removeFileSync(); void server.close(); } else control = server;
  }, (error) => console.error('control server failed to start', error));
});
const stopControl = () => { quitting = true; control?.removeFileSync(); void control?.close(); control = null; };
app.on('before-quit', stopControl);
app.on('will-quit', stopControl);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (!overlay || expanded) return;
  launcherFocused = true;
  revealLauncher(true);
  overlay.show();
});
