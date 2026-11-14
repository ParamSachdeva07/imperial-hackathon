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
 *   POINTY_VOICE=1          open the GPT Realtime test window (needs OPENAI_API_KEY in .env)
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, dialog, screen, type BrowserWindow } from "electron";
import { createOverlayControl } from "./overlay/createOverlayControl";
import { MockAvoidRects } from "./overlay/mocks/MockAvoidRects";
import { MockBoundsProvider } from "./overlay/mocks/MockBoundsProvider";
import { MockScreenCaptureProvider } from "./overlay/mocks/MockScreenCaptureProvider";
import { ElectronScreen, OverlayWindowManager } from "./overlay/OverlayWindowManager";
import { getOverlayPlatform } from "./overlay/platform";
import { startDevServer } from "../dev/devServer";
import { openFixtureWindow } from "../dev/fixtureWindow";
import { openVoiceWindow } from "../dev/realtime/voiceWindow";

export type RendererPage = "overlay" | "fixture" | "gallery" | "voice";

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
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readManifestPrompts(file: string): string[] {
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as { entries?: { prompt?: unknown }[] };
    return (m.entries ?? []).flatMap((e) => (typeof e.prompt === "string" ? [e.prompt] : []));
  } catch {
    return [];
  }
}
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
  // Dev builds read secrets (OPENAI_API_KEY for the voice test) from the gitignored repo-root .env.
  const envFile = join(repoRoot, ".env");
  if (!app.isPackaged && existsSync(envFile)) process.loadEnvFile(envFile);
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

  // The fake mail app is the test surface: reopenable (CLI `pointy-draw fixture`, the voice
  // window's button, and automatically when a voice session starts).
  let fixtureWindow: BrowserWindow | null = null;
  const ensureFixture = async (): Promise<void> => {
    if (fixtureWindow && !fixtureWindow.isDestroyed()) {
      if (fixtureWindow.isMinimized()) fixtureWindow.restore();
      fixtureWindow.show();
    } else {
      fixtureWindow = openFixtureWindow(boundsProvider, (win) => loadRendererPage(win, "fixture"), preloadDir);
    }
    // Wait (briefly) until its elements have been reported, so targets resolve right away.
    for (let i = 0; i < 30 && boundsProvider.listElementIds().length === 0; i++) await delay(100);
  };
  if (process.env.POINTY_NO_FIXTURE !== "1") void ensureFixture();

  let voiceWindow: BrowserWindow | null = null;
  const openVoice = () => {
    if (voiceWindow && !voiceWindow.isDestroyed()) {
      voiceWindow.show();
      voiceWindow.focus();
      return;
    }
    voiceWindow = openVoiceWindow({
      control: overlay.control,
      apiKey: process.env.OPENAI_API_KEY,
      preloadDir,
      loadPage: (win) => loadRendererPage(win, "voice"),
      ensureFixture,
      ctx: {
        listElements: () =>
          boundsProvider.listElementIds().flatMap((id) => {
            const b = boundsProvider.getBoundsSync(id);
            return b ? [{ id, rect: b.rect }] : [];
          }),
        getDisplays: () => electronScreen.getDisplays(),
        primaryDisplayId: () => electronScreen.getPrimaryDisplayId(),
        pregeneratedImagePrompts: () => readManifestPrompts(join(repoRoot, "assets/explainers/manifest.json")),
      },
    });
    console.log("[pointy] voice test window opened");
  };
  if (!app.isPackaged && process.env.POINTY_VOICE === "1") openVoice();
  // `npm run voice` while Pointy is already running: open the voice window in this instance.
  app.on("second-instance", (_e, _argv, _cwd, data) => {
    if (!app.isPackaged && (data as { voice?: boolean } | undefined)?.voice) openVoice();
  });

  if (!app.isPackaged) {
    // A dev-server problem (e.g. port in use) must not stop the overlay or the voice window.
    const server = await startDevServer({
      control: overlay.control,
      sim: boundsProvider,
      getDisplays: () => electronScreen.getDisplays(),
      getPrimaryDisplayId: () => electronScreen.getPrimaryDisplayId(),
      extraRoutes: {
        "/fixture": async () => {
          await ensureFixture();
          return { ok: true, elements: boundsProvider.listElementIds().length };
        },
      },
    }).catch((err: unknown) => {
      console.error(`[pointy] dev server not started (pointy-draw unavailable): ${String(err)}`);
      return null;
    });
    if (server) {
      console.log(`[pointy] dev server on 127.0.0.1:${server.port}`);
      app.on("before-quit", () => void server.close());
    }
  }
  overlay.control.onEvent((e) => console.log(`[pointy] event ${JSON.stringify(e)}`));
  app.on("before-quit", () => overlay.dispose());
  console.log(`[pointy] overlay ready (contentProtection=${contentProtection})`);
}

// Dev: surface renderer errors in the terminal, with the page they came from.
if (!app.isPackaged) {
  app.on("web-contents-created", (_e, wc) => {
    wc.on("console-message", (details) => {
      if (details.level === "error" || details.level === "warning") {
        const page = wc.getURL().split("/").slice(-2).join("/").split("?")[0];
        console.log(`[renderer ${details.level}] ${page}: ${details.message}`);
      }
    });
  });
}

app.on("window-all-closed", () => {
  // Overlay windows are always present; keep running until explicitly quit.
});

// One Pointy per user session (isolated test runs with their own POINTY_DEV_FILE are exempt).
const isolated = Boolean(process.env.POINTY_DEV_FILE);
if (!isolated && !app.requestSingleInstanceLock({ voice: process.env.POINTY_VOICE === "1" })) {
  console.log("[pointy] already running — handed over to the running instance");
  app.quit();
} else {
  main().catch((err: unknown) => {
    console.error("[pointy] startup failed:", err);
    dialog.showErrorBox("Pointy could not start", String(err instanceof Error ? err.stack ?? err.message : err));
  });
}
