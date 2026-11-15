/**
 * Production composition (POINTY_MODE=production, see mode.ts): the real desktop instead of the fake mail
 * app. Accessibility elements (AxBoundsProvider) + screenshots feed GPT Realtime (text out); the answer is
 * spoken by the Anam avatar and drawn with the overlay tools. A menu-bar app: tray, Cmd+Alt+P, no Dock icon.
 * The dev composition lives in index.ts and is untouched by this file. See INTEGRATION.md section 10.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, screen } from "electron";
import { exportToolDefinitions, type ScreenCaptureProvider } from "@pointy/shared/overlay";
import { createOverlayControl, AnamAvatarClient, anamControlFile, readManifestPrompts } from "./overlay";
import { CompositeAvoidRects } from "./overlay/avatar/CompositeAvoidRects";
import { MockAvoidRects } from "./overlay/mocks/MockAvoidRects";
import { MockBoundsProvider } from "./overlay/mocks/MockBoundsProvider";
import { ElectronScreen } from "./overlay/OverlayWindowManager";
import { combineCaptureHiding, hideFeedbackDuringCapture } from "./gestures/captureHiding";
import { feedbackCaptureHiding } from "./gestures/feedbackHost";
import { startGestures, type GesturesHandle } from "./gestures/startGestures";
import { attachSelectionCapture, type SelectionSource } from "./capture/SelectionCapture";
import { bgraCapture, nativeImageOps } from "./capture/nativeImageOps";
import { DesktopCapturerProvider } from "./capture/DesktopCapturerProvider";
import { clearOnSessionClose, SelectionStore } from "./capture/SelectionStore";
import { AxBoundsProvider, AxHelperClient } from "./ax";
import { AssistantController } from "./assistant/AssistantController";
import { AnamSpeaker } from "./assistant/AnamSpeaker";
import { createAssistantWindow } from "./assistant/assistantWindow";
import { buildAssistantInstructions } from "./assistant/instructions";
import { mintAssistantSecret } from "./assistant/secret";
import { captureScreenContext } from "./assistant/screenContext";
import { realClock } from "./overlay/clock";
import { checkPermissions, hideDockInProduction, openMissingSettings, registerAssistantHotkey } from "./permissions";
import { createTray } from "./tray";
import { createQuitGuard, createScrollInvalidator } from "./productionLogic";
import { loadRendererPage, PRELOAD_DIR } from "./rendererPages";
import { startDevHarness } from "../dev/devHarness";

const plog = (msg: string) => console.log(`[pointy] ${msg}`);

/** Pids the AX helper must never snapshot: Pointy itself and the Anam avatar app (from its discovery file). */
function anamPid(): number | null {
  try {
    const j = JSON.parse(readFileSync(anamControlFile(), "utf8")) as { pid?: unknown };
    return typeof j.pid === "number" && Number.isInteger(j.pid) ? j.pid : null;
  } catch {
    return null;
  }
}

export interface ProductionOptions {
  repoRoot: string;
  contentProtection: boolean;
  /** Mode.devServer: also start the localhost dev server (pointy-draw) against the real AX ids. */
  devServer: boolean;
}

export async function startProduction(opts: ProductionOptions): Promise<void> {
  const { repoRoot } = opts;
  hideDockInProduction(true);
  const env = process.env;
  const displays = new ElectronScreen();
  const primary = () => displays.getDisplays().find((d) => d.id === displays.getPrimaryDisplayId());
  const assetsDir = join(repoRoot, "assets", "explainers");

  // --- real screen elements (Accessibility); without a grant the assistant falls back to screenshots
  const ax = new AxBoundsProvider({
    client: new AxHelperClient({ binPath: join(repoRoot, "apps/desktop/resources/bin/pointy-ax"), log: plog }),
    getDisplayMatching: (r) => screen.getDisplayMatching({ x: r.x, y: r.y, width: r.width, height: r.height }),
    excludePids: () => [process.pid, ...(anamPid() === null ? [] : [anamPid() as number])],
    // Screen/AX data is read only while the assistant is open (setSessionActive below); the dev server keeps it live.
    active: opts.devServer,
    log: plog,
  });
  await ax.start();
  plog(ax.trusted ? "accessibility: trusted (element list on)" : "accessibility: NOT granted, screenshot-only until it is granted");

  // --- avatar: the real Anam app drives avoid rects / move_avatar; nothing is avoided while it is unreachable
  const anam = new AnamAvatarClient();
  anam.start();

  const provider = new DesktopCapturerProvider(() => displays.getDisplays());
  const hideFeedback = (p: ScreenCaptureProvider): ScreenCaptureProvider =>
    env.POINTY_HIDE_DURING_CAPTURE === "1" ? hideFeedbackDuringCapture(p, feedbackCaptureHiding) : p;
  const overlay = createOverlayControl({
    boundsProvider: ax,
    captureProvider: hideFeedback(provider),
    avoidRects: new CompositeAvoidRects(anam, new MockAvoidRects(primary, "none")),
    avatar: anam,
    assetsDir,
    screen: displays,
    dev: {
      contentProtection: opts.contentProtection,
      hideDuringCapture: env.POINTY_HIDE_DURING_CAPTURE === "1",
      forceReduceMotion: env.POINTY_REDUCE_MOTION === "1",
    },
  });

  const offAxContext = ax.onContextEvent(() => overlay.control.onContextChange());

  // --- gestures: camera on, mouse on (kill switch in the tray), session driven only by the assistant
  const gestures: GesturesHandle | null = await startGestures({
    repoRoot,
    manualSession: true,
    env: {
      ...env,
      POINTY_GESTURES: env.POINTY_GESTURES === "0" ? "0" : "1",
      POINTY_GESTURES_MOUSE: env.POINTY_GESTURES_MOUSE === "0" ? "0" : "1",
    },
  });
  let gesturesEnabled = gestures !== null;

  const selectionStore = new SelectionStore();
  const hiding = combineCaptureHiding(
    { getWindowIds: () => overlay.control.getOverlayWindowIds(), withHidden: (fn) => overlay.control.withOverlayHidden(fn) },
    feedbackCaptureHiding,
  );
  const stopSelection: (() => void)[] = [];
  const clog = (level: "info" | "warn" | "error") => (msg: string) => console[level](`[selection] ${msg}`);
  const attachSelection = (source: SelectionSource & { onSession(cb: (active: boolean) => void): () => void }): (() => void) => {
    const cap = attachSelectionCapture(source, {
      screen: { getDisplays: () => displays.getDisplays() },
      capture: bgraCapture(provider),
      hiding,
      ops: nativeImageOps,
      now: Date.now,
      log: { info: clog("info"), warn: clog("warn"), error: clog("error") },
      store: selectionStore,
    });
    const offClear = clearOnSessionClose(selectionStore, source);
    return () => {
      cap.dispose();
      offClear();
    };
  };
  if (gestures) {
    try {
      stopSelection.push(attachSelection(gestures.sim));
    } catch (err) {
      console.error(`[selection] capture not available: ${String(err)}`);
    }
  }

  // --- assistant: hidden Realtime window + controller
  const tools = exportToolDefinitions({ pregeneratedImagePrompts: await readManifestPrompts(assetsDir) });
  const assistantWin = createAssistantWindow({
    preloadDir: PRELOAD_DIR,
    loadPage: (w) => loadRendererPage(w, "assistant"),
    mintSecret: () => mintAssistantSecret({ apiKey: process.env.OPENAI_API_KEY, instructions: buildAssistantInstructions(), tools }),
    log: plog,
  });
  const controller = new AssistantController({
    transport: assistantWin.transport,
    buildContext: () =>
      captureScreenContext({
        getDisplays: () => displays.getDisplays(),
        primaryDisplayId: () => displays.getPrimaryDisplayId(),
        cursorDisplayId: () => String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id),
        capture: bgraCapture(provider),
        hiding,
        ops: nativeImageOps,
        ax,
        log: plog,
      }),
    anam: new AnamSpeaker(),
    overlay: overlay.control,
    gestures: {
      // The gesture session (and with it the mouse) is active only while the assistant is open.
      setSessionActive: (active) => {
        ax.setActive(active || opts.devServer);
        if (!gestures) return;
        if (active && gesturesEnabled) gestures.session.open();
        else gestures.session.close();
      },
    },
    selection: selectionStore,
    clock: realClock,
    log: plog,
  });
  controller.status.onChange((s) => {
    if (s === "idle" || s === "error") {
      ax.clearAnchors();
      gestures?.clearSelection();
    }
  });
  const scrollInvalidates = createScrollInvalidator({
    mouseAttached: () => !!gestures && gestures.mouseEnabled && gestures.session.isActive(),
    now: () => Date.now(),
  });
  const offWake = gestures?.sim.onAny((e) => {
    if (scrollInvalidates(e)) overlay.control.onContextChange();
    if (e.type === "wake_requested" && gesturesEnabled) void controller.wake();
  });

  // --- menu bar, hotkey, permissions
  const tray = createTray({
    status: controller.status,
    getToggles: () => ({ mouseEnabled: gestures?.mouseEnabled ?? false, gesturesEnabled }),
    actions: {
      openAssistant: () => void controller.open("tray"),
      closeAssistant: () => void controller.close("tray"),
      setMouseEnabled: (on) => {
        gestures?.setMouseEnabled(on);
        tray.refresh();
      },
      setGesturesEnabled: (on) => {
        gesturesEnabled = on;
        if (!on) gestures?.session.close();
        else if (controller.isOpen()) gestures?.session.open();
        tray.refresh();
      },
      checkPermissions: () => {
        const c = checkPermissions();
        plog(c.summary);
        tray.refresh(c.summary);
        void openMissingSettings(c);
      },
      quit: () => app.quit(),
    },
  });
  const hotkey = registerAssistantHotkey(() => void controller.hotkey());
  plog(hotkey.ok ? "hotkey Cmd+Option+P registered" : "hotkey Cmd+Option+P is taken by another app; use the menu-bar item");
  const perms = checkPermissions();
  plog(perms.summary);
  for (const d of perms.degraded) plog(`degraded: ${d}`);
  tray.refresh(perms.summary);
  if (perms.missing.length > 0) void openMissingSettings(perms);

  // --- optional dev server (POINTY_DEV_SERVER=1): pointy-draw against the real AX ids
  if (opts.devServer) {
    await ax.snapshotNow("dev-server").catch(() => undefined); // seed the element cache (observer events only fire on later changes)
    const sim = new MockBoundsProvider((rect) => String(screen.getDisplayMatching(rect).id));
    Object.assign(sim, {
      listElementIds: () => ax.listElements().map((e) => e.id),
      listElementRects: () => ax.listElements().map((e) => ({ id: e.id, rect: e.rect })),
    });
    await startDevHarness({
      overlay,
      boundsProvider: sim,
      screen: displays,
      assetsDir,
      openFixture: false,
      openVoice: false,
      selection: { store: selectionStore, attach: attachSelection },
      gestures: gestures ? { sim: gestures.sim, session: gestures.session } : null,
    });
  }

  const quitGuard = createQuitGuard({ close: () => controller.close("quit"), quit: () => app.quit() });
  app.on("before-quit", (event) => {
    // Let the Anam /session end go out before Electron exits (otherwise the external call stays open and billed).
    if (quitGuard()) {
      event.preventDefault();
      return;
    }
    offWake?.();
    hotkey.unregister();
    tray.destroy();
    controller.dispose();
    assistantWin.dispose();
    for (const d of stopSelection.splice(0)) d();
    gestures?.dispose();
    anam.dispose();
    offAxContext();
    ax.stop();
    overlay.dispose();
  });
  plog(`production overlay ready (contentProtection=${opts.contentProtection}, gestures=${gestures ? "on" : "off"})`);
}
