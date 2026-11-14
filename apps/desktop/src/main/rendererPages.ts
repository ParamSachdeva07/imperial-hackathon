/** Where the built preload scripts and renderer pages live, and how to load a page into a window. */
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";

export type RendererPage = "overlay" | "fixture" | "gallery" | "voice" | "gestures" | "gestureFeedback";

/** Built preload scripts (electron-vite: out/preload next to out/main). */
export const PRELOAD_DIR = join(__dirname, "../preload");

/** Load a renderer page: the Vite dev server under `electron-vite dev`, the built files otherwise. */
export function loadRendererPage(win: BrowserWindow, page: RendererPage, query = ""): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl && !app.isPackaged) return win.loadURL(`${devUrl}/${page}/index.html${query}`);
  return win.loadFile(join(__dirname, `../renderer/${page}/index.html`), query ? { search: query.slice(1) } : undefined);
}
