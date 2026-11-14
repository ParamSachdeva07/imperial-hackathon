/**
 * Electron main entry: the dev composition of the overlay with mock providers (fake mail app,
 * MockBoundsProvider, desktopCapturer crops). Teammates compose the real app the same way via
 * `createOverlayControl` (./overlay) with their own providers; the dev harness is separate.
 *
 * Dev env flags:
 *   POINTY_VOICE=1          open the GPT Realtime test window (needs OPENAI_API_KEY in .env)
 *   POINTY_NO_FIXTURE=1     don't open the fake mail app
 *   POINTY_ELEMENTS=path    extra element rects (JSON) for MockBoundsProvider
 *   POINTY_AVATAR_RECT=x,y,w,h | none   where the (mock) avatar window is, for layout avoidance
 *   POINTY_AVATAR=anam|mock  anam (default): always watch for the real Anam voice avatar (control API,
 *                           ANAM_CONTROL_FILE, default ~/.pointy/anam-control.json) whichever app starts
 *                           first; while it is reachable it drives avoidance, move_avatar and auto-dodge,
 *                           otherwise the mock rect (POINTY_AVATAR_RECT) is used. mock: never talk to Anam.
 *   POINTY_CAPTURABLE=1     disable content protection (dev screenshots of the overlay itself)
 *   POINTY_HIDE_DURING_CAPTURE=1  hide overlays while capturing anatomy crops
 *   POINTY_REDUCE_MOTION=1  force reduce-motion
 *   POINTY_PROBE=1          overlay windows draw a fixed ring only (canvas check)
 *   POINTY_GESTURES=1       start the hand-gesture layer (hidden camera window + MediaPipe); needs
 *                           `npm run gestures:assets` once. `npm run app:gestures` builds and runs it.
 *   POINTY_GESTURES_SHOW=1  show the gesture vision window (camera preview, debug)
 *   POINTY_GESTURES_MOUSE=1 let gestures drive the real OS mouse/clicks, only while the session is open
 *   POINTY_GESTURES_IDLE_MS gesture session idle timeout (default 20000)
 *                           The user's own hand drawing (cursor, trail, rings, wake ring, selection) is the
 *                           gestures package's feedback window (contentProtection follows POINTY_CAPTURABLE);
 *                           the AI overlay draws none of it.
 *   (no flag needed to simulate gestures without a camera: dev server POST /gesture, CLI
 *   `pointy-draw gesture ...`; the feedback window then starts lazily on the first call)
 *   POINTY_DEV_PORT / POINTY_DEV_FILE   dev server port / connection file (isolated test runs)
 */
import { join, resolve } from "node:path";
import { app, dialog, screen } from "electron";
import { loadRepoEnv } from "@pointy/shared/node/env";
import { createOverlayControl } from "./overlay";
import { AnamAvatarClient } from "./overlay/avatar/AnamAvatarClient";
import { CompositeAvoidRects } from "./overlay/avatar/CompositeAvoidRects";
import { MockAvoidRects } from "./overlay/mocks/MockAvoidRects";
import { MockBoundsProvider } from "./overlay/mocks/MockBoundsProvider";
import { MockScreenCaptureProvider } from "./overlay/mocks/MockScreenCaptureProvider";
import { ElectronScreen, OverlayWindowManager } from "./overlay/OverlayWindowManager";
import { getOverlayPlatform } from "./overlay/platform";
import type { ScreenCaptureProvider } from "@pointy/shared/overlay";
import { hideFeedbackDuringCapture } from "./gestures/captureHiding";
import { feedbackCaptureHiding } from "./gestures/feedbackHost";
import { registerGestureAssetScheme, startGestures, type GesturesHandle } from "./gestures/startGestures";
import { PRELOAD_DIR } from "./rendererPages";
import { installDevLogging, startDevHarness } from "../dev/devHarness";

const repoRoot = resolve(__dirname, "../../../..");
const env = (name: string) => process.env[name];

// Privileged schemes must be registered before app ready.
registerGestureAssetScheme();

/** Gesture layer (null unless POINTY_GESTURES=1). */
let gestures: GesturesHandle | null = null;

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
  if (!app.isPackaged) loadRepoEnv(repoRoot); // OPENAI_API_KEY for the voice test (gitignored .env)
  await app.whenReady();
  const contentProtection = env("POINTY_CAPTURABLE") !== "1";
  if (env("POINTY_PROBE") === "1") {
    startProbe(contentProtection);
    console.log(`[pointy] probe overlay started (contentProtection=${contentProtection})`);
    return;
  }

  const displays = new ElectronScreen();
  const primary = () => displays.getDisplays().find((d) => d.id === displays.getPrimaryDisplayId());
  const boundsProvider = new MockBoundsProvider((rect) => String(screen.getDisplayMatching(rect).id));
  const elementsFile = env("POINTY_ELEMENTS");
  if (elementsFile) boundsProvider.loadJsonFile(elementsFile);
  const assetsDir = join(repoRoot, "assets", "explainers");

  // Always watch for the real Anam avatar (it may start after us); the mock rect is the fallback.
  const anam = env("POINTY_AVATAR") === "mock" ? null : new AnamAvatarClient();
  anam?.start();

  // Gesture feedback lives in its own windows, which the overlay's hideDuringCapture does not know:
  // hide them around every capture too when that flag is on.
  const hideFeedback = (p: ScreenCaptureProvider): ScreenCaptureProvider =>
    env("POINTY_HIDE_DURING_CAPTURE") === "1" ? hideFeedbackDuringCapture(p, feedbackCaptureHiding) : p;

  const overlay = createOverlayControl({
    boundsProvider,
    captureProvider: hideFeedback(new MockScreenCaptureProvider(() => displays.getDisplays())),
    avoidRects: anam ? new CompositeAvoidRects(anam, new MockAvoidRects(primary)) : new MockAvoidRects(primary),
    ...(anam ? { avatar: anam } : {}),
    assetsDir,
    screen: displays,
    dev: {
      contentProtection,
      hideDuringCapture: env("POINTY_HIDE_DURING_CAPTURE") === "1",
      forceReduceMotion: env("POINTY_REDUCE_MOTION") === "1",
    },
  });
  gestures = await startGestures({ repoRoot });
  app.on("before-quit", () => {
    gestures?.dispose(); // feedback window first, then the gesture service (see startGestures)
    anam?.dispose();
    overlay.dispose();
  });

  if (!app.isPackaged) {
    await startDevHarness({
      overlay,
      boundsProvider,
      screen: displays,
      assetsDir,
      openFixture: env("POINTY_NO_FIXTURE") !== "1",
      openVoice: env("POINTY_VOICE") === "1",
      gestures: gestures ? { sim: gestures.sim, session: gestures.session } : null,
    });
  }
  console.log(`[pointy] overlay ready (contentProtection=${contentProtection})`);
}

app.on("window-all-closed", () => {
  // Overlay windows are always present; keep running until explicitly quit.
});

if (!app.isPackaged) installDevLogging(); // before any window exists, so overlay windows are covered too

// One Pointy per user session (isolated test runs with their own POINTY_DEV_FILE are exempt). A
// second `npm run voice` hands over to the running instance, which opens its voice window.
const isolated = Boolean(env("POINTY_DEV_FILE"));
if (!isolated && !app.requestSingleInstanceLock({ voice: env("POINTY_VOICE") === "1" })) {
  console.log("[pointy] already running — handed over to the running instance");
  app.quit();
} else {
  main().catch((err: unknown) => {
    console.error("[pointy] startup failed:", err);
    dialog.showErrorBox("Pointy could not start", String(err instanceof Error ? (err.stack ?? err.message) : err));
  });
}
