/**
 * Composition of the gesture layer for the Electron main process (see packages/gestures/GESTURES_HANDOFF.md).
 * Opt-in: nothing starts unless POINTY_GESTURES=1. Never throws to the caller.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { protocol, session, systemPreferences } from "electron";
import { startGestureService, type GestureService } from "@pointy/gestures/electron";
import type { GestureFeedback } from "@pointy/gestures/electron/feedback";
import { attachSystemMouse } from "@pointy/gestures/electron/mouse";
import { loadRendererPage, PRELOAD_DIR } from "../rendererPages";
import { GESTURE_ASSET_SCHEME, resolveAssetRequest } from "./assetResolver";
import { DevSessionController } from "./DevSessionController";
import type { CaptureHiding } from "./captureHiding";
import { feedbackCaptureHiding, launchGestureFeedback } from "./feedbackHost";
import { parseGestureConfig } from "./gestureConfig";
import { gateMouseToSession } from "./MouseGate";
import { ACCESSIBILITY_HINT, createMouseOffHint, MOUSE_OFF_STARTUP } from "./MouseHint";
import { SimGestureService } from "./SimGestureService";
import { MouseEventSink, mergeMouseSources, type MouseSource } from "./SimMouseSink";

/** Session partition the gesture service uses (service default); the asset scheme is handled on it only. */
export const GESTURE_PARTITION = "pointy-gestures";
const DEFAULT_IDLE_MS = 20_000;

const log = (msg: string) => console.log(`[gestures] ${msg}`);

/**
 * Must run before `app` is ready (call at module load in index.ts). Standard + secure so wasm/workers
 * work from a file:// or dev-server page; corsEnabled + our ACAO header so those pages may fetch it.
 */
export function registerGestureAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: GESTURE_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/** Serve packages/gestures/.cache/public/{mediapipe-wasm,models}/** on the gesture partition. */
export function registerGestureAssetProtocol(assetRoot: string): void {
  const ses = session.fromPartition(GESTURE_PARTITION);
  ses.protocol.handle(GESTURE_ASSET_SCHEME, async (req) => {
    const headers = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" };
    const r = await resolveAssetRequest(assetRoot, req.method, req.url);
    if (r.status !== 200) {
      if (r.status === 404) log(`asset 404: ${req.url}`);
      return new Response(null, { status: r.status, headers });
    }
    const h = { ...headers, "Content-Type": r.mime, "Content-Length": String(r.size) };
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: h });
    const body = Readable.toWeb(createReadStream(r.path)) as unknown as ReadableStream;
    return new Response(body, { status: 200, headers: h });
  });
}

export interface StartGesturesOptions {
  /** Repo root (to find packages/gestures/.cache/public). */
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
}

export interface GesturesHandle {
  service: GestureService;
  /**
   * The real service merged with the camera-free simulation (dev server POST /gesture): the feedback
   * window and the session controller see both. Simulated events never reach `service` (so never the real mouse).
   */
  sim: SimGestureService;
  session: DevSessionController;
  /** The gesture package's own feedback window (user's hand drawing), or null if it failed to start. */
  feedback: GestureFeedback | null;
  /** Remove the selected point/region from the feedback window (e.g. when the controller ends the turn). */
  clearSelection(): void;
  /** Capture exclusion for all feedback windows, also the lazy simulation one (same contract as the overlay's getOverlayWindowIds/withOverlayHidden). */
  captureHiding: CaptureHiding;
  dispose(): void;
}

export async function startGestures(opts: StartGesturesOptions): Promise<GesturesHandle | null> {
  const env = opts.env ?? process.env;
  if (env.POINTY_GESTURES !== "1") return null;
  const disposers: (() => void)[] = [];
  try {
    const mouseEnabled = env.POINTY_GESTURES_MOUSE === "1";
    const tuning = parseGestureConfig(env);
    for (const w of tuning.warnings) log(w);
    if (tuning.applied.length) log(`config overrides: ${tuning.applied.join(", ")}`);
    registerGestureAssetProtocol(join(opts.repoRoot, "packages", "gestures", ".cache", "public"));
    const service = await startGestureService({
      preloadPath: join(PRELOAD_DIR, "gestures.js"),
      loadPage: (w) => loadRendererPage(w, "gestures"),
      showWindow: env.POINTY_GESTURES_SHOW === "1",
      partition: GESTURE_PARTITION,
      ...(tuning.applied.length ? { config: tuning.config } : {}),
    });
    disposers.push(() => service.dispose());
    disposers.push(service.onStatus((s) => log(`status: ${JSON.stringify(s)}`)));

    // The service never queues events: subscribe the session controller right after it resolves, before
    // any other slow work (opening the feedback window), so an early wake_requested is not lost.
    // The merged adapter (real service + simulation) is what the controller and the feedback window see.
    const mouseSink = new MouseEventSink();
    const sim = new SimGestureService({ base: service, ...(mouseEnabled ? { mouseSink } : {}) });
    disposers.push(() => sim.dispose());
    const idleMs = Number(env.POINTY_GESTURES_IDLE_MS);
    const sessionCtl = new DevSessionController({
      service: sim,
      idleMs: Number.isFinite(idleMs) && idleMs > 0 ? idleMs : DEFAULT_IDLE_MS,
      log,
    });
    disposers.push(() => sessionCtl.dispose());

    // Feedback failure is logged and must not stop gestures. Disposed before the service (disposers run in reverse).
    const feedback = await launchGestureFeedback(sim, env, log);
    if (feedback) disposers.push(() => feedback.dispose());

    if (mouseEnabled) {
      // nut-js silently does nothing without Accessibility, while the log would still say "attached".
      if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(true)) log(ACCESSIBILITY_HINT);
      // Real events plus, because the flag is on, simulated ones (dev CLI) via the sink. attachSystemMouse is
      // attached only while the session is open, and the sim forwards only while it is open, so both are session-gated.
      const source = mergeMouseSources(service as MouseSource, mouseSink);
      disposers.push(gateMouseToSession(sessionCtl, () => attachSystemMouse(source as unknown as GestureService, { log }), log));
    } else {
      log(MOUSE_OFF_STARTUP);
      disposers.push(service.onAny(createMouseOffHint(log)));
    }
    log(`started (show=${env.POINTY_GESTURES_SHOW === "1"}, mouse=${mouseEnabled}, feedback=${feedback ? "on" : "off"})`);
    return {
      service,
      sim,
      session: sessionCtl,
      feedback,
      clearSelection: () => feedback?.clearSelection(),
      captureHiding: feedbackCaptureHiding,
      dispose() {
        for (const d of disposers.reverse()) {
          try {
            d();
          } catch (err) {
            log(`dispose error: ${String(err)}`);
          }
        }
      },
    };
  } catch (err) {
    log(`failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}
