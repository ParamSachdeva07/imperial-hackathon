/**
 * Electron main entry. Starts the real-desktop composition in ./production.ts (`npm run pointy`).
 *
 * Environment flags:
 *   POINTY_AVATAR=anam|mock  anam (default): watch for the avatar window (control API, ANAM_CONTROL_FILE,
 *                           default ~/.pointy/anam-control.json). mock: never talk to it.
 *   POINTY_CAPTURABLE=1     disable content protection (screenshots of the overlay itself)
 *   POINTY_HIDE_DURING_CAPTURE=1  hide overlays while capturing anatomy crops
 *   POINTY_REDUCE_MOTION=1  force reduce-motion
 *   POINTY_PROBE=1          overlay windows draw a fixed ring only (canvas check)
 *   POINTY_GESTURES=1       start the hand-gesture layer (hidden camera window + MediaPipe); needs
 *                           `npm run gestures:assets` once. Gesture selections are captured as two JPEGs
 *                           (full display marked + focus close-up) for the AI; needs macOS Screen Recording
 *                           permission, otherwise it logs an error and skips.
 *   POINTY_GESTURES_SHOW=1  show the gesture vision window (camera preview, debug)
 *   POINTY_GESTURES_MOUSE=1 one finger/fist drive the real OS mouse/clicks/scroll, only while the session is open
 *   POINTY_GESTURES_IDLE_MS gesture session idle timeout (default 20000)
 *   POINTY_DEV_SERVER=1     also start the localhost developer server (gesture simulation, overlay inspection)
 *   POINTY_DEV_PORT / POINTY_DEV_FILE   developer server port / connection file (isolated test runs)
 */
import { join, resolve } from "node:path";
import { app, dialog } from "electron";
import { loadRepoEnv } from "@pointy/shared/node/env";
import { OverlayWindowManager } from "./overlay/OverlayWindowManager";
import { getOverlayPlatform } from "./overlay/platform";
import { registerGestureAssetScheme } from "./gestures/startGestures";
import { PRELOAD_DIR } from "./rendererPages";
import { startProduction } from "./production";

const repoRoot = resolve(__dirname, "../../../..");
const env = (name: string) => process.env[name];

// Privileged schemes must be registered before app ready.
registerGestureAssetScheme();

const PROBE_HTML = `<!doctype html><html><body style="margin:0;background:transparent">
<svg width="100%" height="100%" style="position:fixed;inset:0">
<rect x="203" y="203" width="294" height="94" rx="14" fill="none" stroke="#fff" stroke-width="12"/>
<rect x="203" y="203" width="294" height="94" rx="14" fill="none" stroke="#2563EB" stroke-width="6"/>
</svg></body></html>`;

/** POINTY_PROBE: bare overlay windows drawing a fixed ring (checks click-through/capture exclusion). */
function startProbe(contentProtection: boolean): void {
  new OverlayWindowManager({
    platform: getOverlayPlatform(),
    preloadPath: join(PRELOAD_DIR, "overlay.js"),
    loadPage: (win) => win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PROBE_HTML)}`),
    contentProtection,
  }).start();
}

async function main(): Promise<void> {
  if (!app.isPackaged) loadRepoEnv(repoRoot); // OPENAI_API_KEY (gitignored .env)
  await app.whenReady();
  const contentProtection = env("POINTY_CAPTURABLE") !== "1";
  if (env("POINTY_PROBE") === "1") {
    startProbe(contentProtection);
    console.log(`[pointy] probe overlay started (contentProtection=${contentProtection})`);
    return;
  }
  await startProduction({ repoRoot, contentProtection, devServer: env("POINTY_DEV_SERVER") === "1" });
}

app.on("window-all-closed", () => {
  // Overlay windows are always present; keep running until explicitly quit.
});

// One Pointy per user session (isolated test runs with their own POINTY_DEV_FILE are exempt).
const isolated = Boolean(env("POINTY_DEV_FILE"));
if (!isolated && !app.requestSingleInstanceLock()) {
  console.log("[pointy] already running");
  app.quit();
} else {
  main().catch((err: unknown) => {
    console.error("[pointy] startup failed:", err);
    dialog.showErrorBox("Pointy could not start", String(err instanceof Error ? (err.stack ?? err.message) : err));
  });
}
