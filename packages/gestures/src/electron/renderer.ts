/**
 * Vision page logic, run inside the hidden gesture window:
 * camera → MediaPipe → GestureInterpreter → window.pointyGestures.emit(events).
 *
 * Call `startVisionRenderer()` from the page's entry script (see electron/dev/vision.ts).
 */
import type { GestureConfig } from "../config";
import type { DisplayInfo, FrameObservation, GestureEvent } from "../events";
import { GestureInterpreter } from "../interpreter";
import type { PointyGesturesApi } from "./api";
import type { GestureCommand } from "./protocol";

/** Produces one observation per tick, or null when no new camera frame is available. */
export type FrameSource = (t: number) => FrameObservation | null;

export interface VisionRendererOptions {
  /** Folder with MediaPipe's wasm files, relative to the page (bundle them; no CDN). */
  wasmPath: string;
  /** gesture_recognizer.task, relative to the page. */
  modelPath: string;
  /** Used if modelPath can't be fetched (dev convenience; bundle the model for real builds). */
  fallbackModelUrl?: string;
  /** Detection rate. Timers (not requestAnimationFrame) drive the loop: hidden windows don't paint. */
  fps?: number;
  /** Replace camera + MediaPipe, e.g. with synthetic frames for a self-test. */
  source?: FrameSource;
  /** Element to show the camera preview in (only visible if the window is shown for debugging). */
  previewParent?: HTMLElement;
  /** Called after every processed frame (debug views). */
  onFrame?: (obs: FrameObservation, events: GestureEvent[], display: DisplayInfo) => void;
}

const DEFAULT_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task";

function requireApi(): PointyGesturesApi {
  const api = window.pointyGestures;
  if (!api) throw new Error("window.pointyGestures is missing: load the gesture preload in this window.");
  return api;
}

async function firstReachable(urls: string[]): Promise<string> {
  for (const url of urls) {
    const ok = await fetch(url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
    if (ok) return url;
  }
  throw new Error(`gesture model not found (tried ${urls.join(", ")})`);
}

/** Camera + MediaPipe frame source. */
async function cameraSource(opts: VisionRendererOptions): Promise<FrameSource> {
  const { HandDetector } = await import("../detector");
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  if (opts.previewParent) {
    video.style.width = "100%";
    video.style.transform = "scaleX(-1)";
    opts.previewParent.append(video);
  }
  await video.play();

  const modelPath = await firstReachable([opts.modelPath, opts.fallbackModelUrl ?? DEFAULT_MODEL_URL]);
  let detector;
  try {
    detector = await HandDetector.create({ wasmPath: opts.wasmPath, modelPath, delegate: "GPU" });
  } catch {
    detector = await HandDetector.create({ wasmPath: opts.wasmPath, modelPath, delegate: "CPU" });
  }

  let lastVideoTime = -1;
  let lastT = -1;
  return (t) => {
    if (video.readyState < 2 || video.currentTime === lastVideoTime || t <= lastT) return null;
    lastVideoTime = video.currentTime;
    lastT = t;
    return detector.detect(video, t);
  };
}

export async function startVisionRenderer(opts: VisionRendererOptions): Promise<void> {
  const api = requireApi();
  api.status({ type: "starting" });

  // Commands can arrive before the interpreter exists (display comes first): queue them.
  let interp: GestureInterpreter | null = null;
  let sessionActive = false;
  let pendingConfig: Partial<GestureConfig> = {};
  let display: DisplayInfo | null = null;

  api.onCommand((cmd: GestureCommand) => {
    switch (cmd.type) {
      case "display":
        display = cmd.display;
        if (interp) interp.setDisplay(cmd.display);
        else {
          interp = new GestureInterpreter(cmd.display, pendingConfig);
          interp.setSessionActive(sessionActive);
        }
        break;
      case "session":
        sessionActive = cmd.active;
        interp?.setSessionActive(cmd.active);
        break;
      case "config":
        pendingConfig = { ...pendingConfig, ...cmd.config };
        interp?.setConfig(cmd.config);
        break;
    }
  });
  api.ready();

  let source: FrameSource;
  try {
    source = opts.source ?? (await cameraSource(opts));
  } catch (err) {
    api.status({ type: "error", message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const interval = 1000 / (opts.fps ?? 30);
  let frames = 0;
  let hands = 0;
  let windowStart = performance.now();

  const tick = () => {
    const t = performance.now();
    try {
      const obs = source(t);
      if (obs && interp && display) {
        frames++;
        hands = obs.hands.length;
        const events = interp.process(obs);
        api.emit(events);
        opts.onFrame?.(obs, events, display);
      }
    } catch (err) {
      api.status({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    if (t - windowStart >= 1000) {
      api.status({ type: "running", fps: Math.round((frames * 1000) / (t - windowStart)), hands });
      frames = 0;
      windowStart = t;
    }
    setTimeout(tick, Math.max(0, interval - (performance.now() - t)));
  };
  tick();
}
