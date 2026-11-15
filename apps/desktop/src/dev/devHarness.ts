/**
 * Developer harness around the overlay (POINTY_DEV_SERVER=1): the localhost developer server with gesture
 * simulation, and renderer console logging.
 */
import { app } from "electron";
import type { MockBoundsProvider } from "../main/overlay/mocks/MockBoundsProvider";
import type { OverlayHandle, ScreenSource } from "../main/overlay";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import { snapshotMeta } from "@pointy/shared/context/selection";
import { launchGestureFeedback, primaryDisplayInfo } from "../main/gestures/feedbackHost";
import { SimGestureService } from "../main/gestures/SimGestureService";
import { startDevServer } from "./devServer";
import { assertEventsForDisplay, GestureBody, GestureSessionBody } from "./gestureSchema";

export interface DevHarnessOptions {
  overlay: OverlayHandle;
  boundsProvider: MockBoundsProvider;
  screen: ScreenSource;
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

  // A dev-server problem (e.g. port in use) must not stop the overlay.
  const server = await startDevServer({
    control: overlay.control,
    debug: overlay.debug,
    sim: boundsProvider,
    getDisplays: () => screen.getDisplays(),
    getPrimaryDisplayId: () => screen.getPrimaryDisplayId(),
    ...(opts.selection ? { getSelection: () => opts.selection!.store.latest() } : {}),
    routes: {
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
    console.error(`[pointy] dev server not started: ${String(err)}`);
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

