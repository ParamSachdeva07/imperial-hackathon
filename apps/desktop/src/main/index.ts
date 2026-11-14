/**
 * Electron main entry: dev composition root for the overlay.
 * Wires the overlay to mocks (fixture window, MockBoundsProvider, desktopCapturer crops), starts the
 * localhost dev server for `pointy-draw`, and in POINTY_PROBE mode draws a fixed test ring only.
 *
 * Env:
 *   POINTY_CAPTURABLE=1     disable content protection (dev screenshots of the overlay itself)
 *   POINTY_PROBE=1          overlay windows draw a fixed ring (Phase 1 canvas check), nothing else
 *   POINTY_NO_FIXTURE=1     don't open the fixture window
 *   POINTY_ELEMENTS=path    extra element rects (JSON) for MockBoundsProvider
 *   POINTY_REDUCE_MOTION=1  force reduce-motion
 *   POINTY_HIDE_DURING_CAPTURE=1  hide overlays while capturing anatomy crops
 */
import { join, resolve } from "node:path";
import { app, screen, type BrowserWindow } from "electron";
import { createOverlayControl } from "./overlay/createOverlayControl";
import { MockAvoidRects } from "./overlay/mocks/MockAvoidRects";
import { MockBoundsProvider } from "./overlay/mocks/MockBoundsProvider";
import { MockScreenCaptureProvider } from "./overlay/mocks/MockScreenCaptureProvider";
import { ElectronScreen, OverlayWindowManager } from "./overlay/OverlayWindowManager";
import { getOverlayPlatform } from "./overlay/platform";
import { startDevServer } from "../dev/devServer";
import { openFixtureWindow } from "../dev/fixtureWindow";

export type RendererPage = "overlay" | "fixture" | "gallery";

/** Load one of the renderer pages: Vite dev server in `electron-vite dev`, built files otherwise. */
export function loadRendererPage(win: BrowserWindow, page: RendererPage, query = ""): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl && !app.isPackaged) return win.loadURL(`${devUrl}/${page}/index.html${query}`);
  return win.loadFile(join(__dirname, `../renderer/${page}/index.html`), query ? { search: query.slice(1) } : undefined);
}

const PROBE_HTML = `<!doctype html><html><body style="margin:0;background:transparent">
<svg width="100%" height="100%" style="position:fixed;inset:0">
<rect x="203" y="203" width="294" height="94" rx="14" fill="none" stroke="#fff" stroke-width="12"/>
<rect x="203" y="203" width="294" height="94" rx="14" fill="none" stroke="#2563EB" stroke-width="6"/>
</svg></body></html>`;

const preloadDir = join(__dirname, "../preload");
const repoRoot = resolve(__dirname, "../../../..");

function startProbe(): void {
  const windows = new OverlayWindowManager({
    platform: getOverlayPlatform(),
    preloadPath: join(preloadDir, "overlay.js"),
    loadPage: (win) => win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PROBE_HTML)}`),
    contentProtection: process.env.POINTY_CAPTURABLE !== "1",
  });
  windows.start();
}

async function main(): Promise<void> {
  await app.whenReady();
  const contentProtection = process.env.POINTY_CAPTURABLE !== "1";
  if (process.env.POINTY_PROBE === "1") {
    startProbe();
    console.log(`[pointy] probe overlay started (contentProtection=${contentProtection})`);
    return;
  }

  const electronScreen = new ElectronScreen();
  const boundsProvider = new MockBoundsProvider((rect) => String(screen.getDisplayMatching(rect).id));
  if (process.env.POINTY_ELEMENTS) boundsProvider.loadJsonFile(process.env.POINTY_ELEMENTS);
  const captureProvider = new MockScreenCaptureProvider(() => electronScreen.getDisplays());
  const avoidRects = new MockAvoidRects(() =>
    electronScreen.getDisplays().find((d) => d.id === electronScreen.getPrimaryDisplayId()),
  );

  const overlay = createOverlayControl({
    boundsProvider,
    captureProvider,
    avoidRects,
    preloadPath: join(preloadDir, "overlay.js"),
    loadPage: (win) => loadRendererPage(win, "overlay"),
    assetsDir: join(repoRoot, "assets/explainers"),
    contentProtection,
    hideDuringCapture: process.env.POINTY_HIDE_DURING_CAPTURE === "1",
  });

  if (process.env.POINTY_NO_FIXTURE !== "1") {
    openFixtureWindow(boundsProvider, (win) => loadRendererPage(win, "fixture"), preloadDir);
  }

  if (!app.isPackaged) {
    const server = await startDevServer({
      control: overlay.control,
      sim: boundsProvider,
      getDisplays: () => electronScreen.getDisplays(),
      getPrimaryDisplayId: () => electronScreen.getPrimaryDisplayId(),
    });
    console.log(`[pointy] dev server on 127.0.0.1:${server.port}`);
    app.on("before-quit", () => void server.close());
  }
  overlay.control.onEvent((e) => console.log(`[pointy] event ${JSON.stringify(e)}`));
  app.on("before-quit", () => overlay.dispose());
  console.log(`[pointy] overlay ready (contentProtection=${contentProtection})`);
}

app.on("window-all-closed", () => {
  // Overlay windows are always present; keep running until explicitly quit.
});

void main();
