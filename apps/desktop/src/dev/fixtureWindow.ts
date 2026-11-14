/**
 * Fixture window (spec §6): a normal window with fake buttons, a fake email and a fake file list.
 * Its renderer reports element rects relative to the page; we convert them to global DIP using the
 * window's content bounds (so moving the window moves the elements) and feed MockBoundsProvider.
 */
import { join } from "node:path";
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from "electron";
import { IPC, type FixtureBoundsMessage } from "@pointy/shared/overlay/render";
import type { Rect } from "@pointy/shared/overlay";
import type { MockBoundsProvider } from "../main/overlay/mocks/MockBoundsProvider";

/** Width reserved on the right of the primary screen for the voice test window. */
export const VOICE_WINDOW_WIDTH = 440;

export function openFixtureWindow(
  bounds: MockBoundsProvider,
  loadPage: (win: BrowserWindow) => Promise<void>,
  preloadDir: string,
): BrowserWindow {
  // Left part of the primary screen, leaving room on the right for the voice test window.
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.max(820, Math.min(1100, wa.width - VOICE_WINDOW_WIDTH - 3 * 16));
  const win = new BrowserWindow({
    width,
    height: Math.min(760, wa.height - 32),
    x: wa.x + 16,
    y: wa.y + 16,
    title: "Pointy Fixture",
    backgroundColor: "#ffffff",
    webPreferences: { preload: join(preloadDir, "fixture.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  let last: FixtureBoundsMessage = { elements: [] };

  const publish = () => {
    if (win.isDestroyed()) return;
    const content = win.getContentBounds();
    const elements: Record<string, { rect: Rect; displayId: string }> = {};
    for (const e of last.elements) {
      const rect = { x: content.x + e.rect.x, y: content.y + e.rect.y, width: e.rect.width, height: e.rect.height };
      elements[e.id] = { rect, displayId: String(screen.getDisplayMatching(rect).id) };
    }
    // A minimised/hidden fixture has no visible elements.
    bounds.setSource("fixture", win.isVisible() && !win.isMinimized() ? elements : {});
  };

  const onBounds = (e: IpcMainEvent, msg: FixtureBoundsMessage) => {
    if (win.isDestroyed() || e.sender.id !== win.webContents.id || !Array.isArray(msg?.elements)) return;
    last = msg;
    publish();
  };
  ipcMain.on(IPC.fixtureBounds, onBounds);
  win.on("move", publish);
  win.on("resize", publish);
  win.on("minimize", publish);
  win.on("restore", publish);
  win.on("show", publish);
  win.on("hide", publish);
  win.on("closed", () => {
    ipcMain.removeListener(IPC.fixtureBounds, onBounds);
    bounds.clearSource("fixture");
  });
  void loadPage(win);
  return win;
}
