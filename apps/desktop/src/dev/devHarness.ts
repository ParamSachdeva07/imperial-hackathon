/**
 * DEV-ONLY harness around the overlay: the fake mail app (fixture), the localhost dev server for
 * `pointy-draw`, the GPT Realtime voice test window, the second-instance hand-off and console logging.
 * Kept out of the production composition in main/index.ts.
 */
import { app, type BrowserWindow } from "electron";
import { delay } from "@pointy/shared/node/env";
import { readManifestPrompts } from "../main/overlay/explainer/manifest";
import type { MockBoundsProvider } from "../main/overlay/mocks/MockBoundsProvider";
import type { OverlayHandle, ScreenSource } from "../main/overlay";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import { snapshotMeta } from "@pointy/shared/context/selection";
import { launchGestureFeedback, primaryDisplayInfo } from "../main/gestures/feedbackHost";
import { SimGestureService } from "../main/gestures/SimGestureService";
import { loadRendererPage, PRELOAD_DIR } from "../main/rendererPages";
import { startDevServer } from "./devServer";
import { assertEventsForDisplay, GestureBody, GestureSessionBody } from "./gestureSchema";
import { openFixtureWindow } from "./fixtureWindow";
import { openVoiceWindow } from "./realtime/voiceWindow";

export interface DevHarnessOptions {
  overlay: OverlayHandle;
  boundsProvider: MockBoundsProvider;
  screen: ScreenSource;
  assetsDir: string;
  openFixture: boolean;
  openVoice: boolean;
  /**
   * The real gesture layer (POINTY_GESTURES=1), else null. Real: POST /gesture is merged into its
   * feedback window and session controller. Null: the feedback window is started lazily on the first
   * /gesture or /gesture/session call, driven by a standalone simulation.
   */
  /**
   * Selection capture (gesture selection -> screenshots for the AI). `store` is the shared latest
   * snapshot; `attach` hooks the capture onto a gesture source (used for the lazy camera-free sim)
   * and returns its dispose function. Null/absent: capture unavailable.
   */
  selection?: {
    store: {
      latest(): SelectionSnapshot | null;
      onSnapshot(cb: (s: SelectionSnapshot) => void): () => void;
    };
    attach(source: SimGestureService): () => void;
  } | null;
  gestures?: { sim: SimGestureService; session: { open(): void; close(): void } } | null;
}

/**
 * Renderer errors/warnings in the terminal, with the page they came from. Install at startup,
 * before any window exists (web-contents-created doesn't fire for windows created earlier).
 */
export function installDevLogging(): void {
  app.on("web-contents-created", (_e, wc) => {
    wc.on("console-message", (details) => {
      if (details.level === "error" || details.level === "warning") {
        const page = wc.getURL().split("/").slice(-2).join("/").split("?")[0];
        console.log(`[renderer ${details.level}] ${page}: ${details.message}`);
      }
    });
  });
}

export async function startDevHarness(opts: DevHarnessOptions): Promise<void> {
  const { overlay, boundsProvider, screen } = opts;

  // The fake mail app is the test surface: reopenable (CLI `pointy-draw fixture`, the voice
  // window's button, and automatically when a voice session starts).
  let fixtureWindow: BrowserWindow | null = null;
  const ensureFixture = async (): Promise<void> => {
    if (fixtureWindow && !fixtureWindow.isDestroyed()) {
      if (fixtureWindow.isMinimized()) fixtureWindow.restore();
      fixtureWindow.show();
    } else {
      fixtureWindow = openFixtureWindow(boundsProvider, (win) => loadRendererPage(win, "fixture"), PRELOAD_DIR);
    }
    // Wait (briefly) until its elements have been reported, so targets resolve right away.
    for (let i = 0; i < 30 && boundsProvider.listElementIds().length === 0; i++) await delay(100);
  };
  if (opts.openFixture) void ensureFixture();

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
      preloadDir: PRELOAD_DIR,
      loadPage: (win) => loadRendererPage(win, "voice"),
      ensureFixture,
      ...(opts.selection ? { selectionSource: opts.selection.store } : {}),
      ctx: {
        listElements: () => boundsProvider.listElementRects(),
        getDisplays: () => screen.getDisplays(),
        primaryDisplayId: () => screen.getPrimaryDisplayId(),
        pregeneratedImagePrompts: () => readManifestPrompts(opts.assetsDir),
      },
    });
    console.log("[pointy] voice test window opened");
  };
  if (opts.openVoice) openVoice();
  // `npm run voice` while Pointy is already running: open the voice window in this instance.
  app.on("second-instance", (_e, _argv, _cwd, data) => {
    if ((data as { voice?: boolean } | undefined)?.voice) openVoice();
  });

  overlay.control.onEvent((e) => console.log(`[pointy] event ${JSON.stringify(e)}`));

  // Camera-free gestures drive the gestures package's own feedback window (not the AI overlay). With the
  // real layer running they are merged into it; otherwise a standalone simulation + window start lazily.
  let lazySim: Promise<SimGestureService> | null = null;
  const lazyStop: (() => void)[] = [];
  const ensureSim = (): Promise<SimGestureService> => {
    if (opts.gestures) return Promise.resolve(opts.gestures.sim);
    lazySim ??= (async () => {
      const svc = new SimGestureService({ display: primaryDisplayInfo });
      lazyStop.push(() => svc.dispose());
      if (opts.selection) {
        try {
          lazyStop.push(opts.selection.attach(svc));
        } catch (err) {
          console.error(`[pointy] selection capture not attached to the simulation: ${String(err)}`);
        }
      }
      const feedback = await launchGestureFeedback(svc, process.env, (m) => console.log(`[gestures] ${m}`));
      if (feedback) lazyStop.unshift(() => feedback.dispose());
      return svc;
    })();
    return lazySim;
  };
  app.on("before-quit", () => {
    for (const d of lazyStop.splice(0)) d();
  });

  // A dev-server problem (e.g. port in use) must not stop the overlay or the voice window.
  const server = await startDevServer({
    control: overlay.control,
    debug: overlay.debug,
    sim: boundsProvider,
    getDisplays: () => screen.getDisplays(),
    getPrimaryDisplayId: () => screen.getPrimaryDisplayId(),
    ...(opts.selection ? { getSelection: () => opts.selection!.store.latest() } : {}),
    routes: {
      "/fixture": async () => {
        await ensureFixture();
        return { ok: true, elements: boundsProvider.listElementIds().length };
      },
      "/gesture": async (body) => {
        const b = GestureBody.parse(body);
        const sim = await ensureSim();
        assertEventsForDisplay(b.events, sim.display.id); // the feedback window covers one display only
        void sim.play(b.events, b.intervalMs);
        return { ok: true, count: b.events.length, real: Boolean(opts.gestures) };
      },
      "/gesture/session": async (body) => {
        const { active } = GestureSessionBody.parse(body);
        if (opts.gestures) {
          if (active) opts.gestures.session.open();
          else opts.gestures.session.close();
        } else {
          (await ensureSim()).setSessionActive(active);
        }
        return { ok: true, active, real: Boolean(opts.gestures) };
      },
    },
  }).catch((err: unknown) => {
    console.error(`[pointy] dev server not started (pointy-draw unavailable): ${String(err)}`);
    return null;
  });
  if (server) {
    console.log(`[pointy] dev server on 127.0.0.1:${server.port}`);
    if (opts.selection) {
      const offSel = opts.selection.store.onSnapshot((s) => server.publish({ type: "selection.captured", selection: snapshotMeta(s) }));
      app.on("before-quit", offSel);
    }
    app.on("before-quit", () => void server.close());
  }
}

