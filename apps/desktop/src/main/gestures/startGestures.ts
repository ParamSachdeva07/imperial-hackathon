/**
 * Composition of the gesture layer for the Electron main process (see packages/gestures/GESTURES_HANDOFF.md).
 * Opt-in: nothing starts unless POINTY_GESTURES=1. Never throws to the caller.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { protocol, session } from "electron";
import { startGestureService, type GestureService } from "@pointy/gestures/electron";
import { attachSystemMouse } from "@pointy/gestures/electron/mouse";
import { loadRendererPage, PRELOAD_DIR } from "../rendererPages";
import { GESTURE_ASSET_SCHEME, resolveAssetRequest } from "./assetResolver";
import { DevSessionController } from "./DevSessionController";
import { gateMouseToSession } from "./MouseGate";

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
  session: DevSessionController;
  dispose(): void;
}

export async function startGestures(opts: StartGesturesOptions): Promise<GesturesHandle | null> {
  const env = opts.env ?? process.env;
  if (env.POINTY_GESTURES !== "1") return null;
  const disposers: (() => void)[] = [];
  try {
    registerGestureAssetProtocol(join(opts.repoRoot, "packages", "gestures", ".cache", "public"));
    const service = await startGestureService({
      preloadPath: join(PRELOAD_DIR, "gestures.js"),
      loadPage: (w) => loadRendererPage(w, "gestures"),
      showWindow: env.POINTY_GESTURES_SHOW === "1",
      partition: GESTURE_PARTITION,
    });
    disposers.push(() => service.dispose());
    disposers.push(service.onStatus((s) => log(`status: ${JSON.stringify(s)}`)));

    const idleMs = Number(env.POINTY_GESTURES_IDLE_MS);
    const sessionCtl = new DevSessionController({
      service,
      idleMs: Number.isFinite(idleMs) && idleMs > 0 ? idleMs : DEFAULT_IDLE_MS,
      log,
    });
    disposers.push(() => sessionCtl.dispose());

    if (env.POINTY_GESTURES_MOUSE === "1") {
      disposers.push(gateMouseToSession(sessionCtl, () => attachSystemMouse(service, { log }), log));
    }
    log(`started (show=${env.POINTY_GESTURES_SHOW === "1"}, mouse=${env.POINTY_GESTURES_MOUSE === "1"})`);
    return {
      service,
      session: sessionCtl,
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
