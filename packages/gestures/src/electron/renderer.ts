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
  /**
   * Upper bound on frames processed per second (default 60). Every new camera frame is picked up
   * within a few ms: a fast timer polls for it (timers, not requestAnimationFrame: hidden windows
   * don't paint).
   */
  fps?: number;
  /** Frame rate asked of the camera (default 30). Higher = less latency if the camera supports it. */
  cameraFps?: number;
  /** Hands tracked at once (default 2). 1 is cheaper: MediaPipe skips palm detection while tracking. */
  numHands?: number;
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
type CameraInfo = { width: number; height: number; frameRate: number };

async function cameraSource(opts: VisionRendererOptions, onInfo: (c: CameraInfo) => void): Promise<FrameSource> {
  const { HandDetector } = await import("../detector");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: opts.cameraFps ?? 30 } },
  });
  const settings = stream.getVideoTracks()[0]?.getSettings();
  if (settings) onInfo({ width: settings.width ?? 0, height: settings.height ?? 0, frameRate: Math.round(settings.frameRate ?? 0) });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  // Always keep the video in the page. A detached <video> in a hidden window can be
  // deprioritised by Chromium (fewer / late frames), which degrades fine gestures.
  if (opts.previewParent) {
    video.style.width = "100%";
    video.style.transform = "scaleX(-1)";
    opts.previewParent.append(video);
  } else {
    Object.assign(video.style, { position: "fixed", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01" });
    document.body.append(video);
  }
  await video.play();

  const numHands = opts.numHands ?? 2;
  const modelPath = await firstReachable([opts.modelPath, opts.fallbackModelUrl ?? DEFAULT_MODEL_URL]);
  let detector;
  try {
    detector = await HandDetector.create({ wasmPath: opts.wasmPath, modelPath, delegate: "GPU", numHands });
  } catch {
    detector = await HandDetector.create({ wasmPath: opts.wasmPath, modelPath, delegate: "CPU", numHands });
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
  let camera: CameraInfo | undefined;
  try {
    source = opts.source ?? (await cameraSource(opts, (c) => (camera = c)));
  } catch (err) {
    api.status({ type: "error", message: err instanceof Error ? err.message : String(err) });
    return;
  }

  // Poll often and process each new camera frame as soon as it exists. A 33 ms timer would add
  // ~16 ms of waiting on average (and sometimes skip a frame) on top of the camera's own delay.
  const POLL_MS = 4;
  const minInterval = (1000 / (opts.fps ?? 60)) * 0.8;
  let lastProcessed = -Infinity;
  let frames = 0;
  let hands = 0;
  let procTotal = 0;
  let windowStart = performance.now();

  const tick = () => {
    const t = performance.now();
    if (t - lastProcessed >= minInterval) {
      try {
        const obs = source(t);
        if (obs && interp && display) {
          lastProcessed = t;
          frames++;
          hands = obs.hands.length;
          const events = interp.process(obs);
          procTotal += performance.now() - t;
          api.emit(events);
          opts.onFrame?.(obs, events, display);
        }
      } catch (err) {
        api.status({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (t - windowStart >= 1000) {
      api.status({
        type: "running",
        fps: Math.round((frames * 1000) / (t - windowStart)),
        hands,
        procMs: frames ? Math.round(procTotal / frames) : 0,
        ...(camera ? { camera } : {}),
      });
      frames = 0;
      procTotal = 0;
      windowStart = t;
    }
    setTimeout(tick, POLL_MS);
  };
  tick();
}
