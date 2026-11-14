import { FilesetResolver, GestureRecognizer, type GestureRecognizerResult } from "@mediapipe/tasks-vision";
import type { FrameObservation, HandLabel, HandObservation } from "./events";

export interface DetectorOptions {
  /** Folder holding the MediaPipe wasm files. Bundle them locally (see scripts/copy-wasm.mjs). */
  wasmPath: string;
  /** Path or URL of gesture_recognizer.task (see scripts/fetch-model.mjs). */
  modelPath: string;
  delegate?: "GPU" | "CPU";
  numHands?: number;
}

/** Converts a MediaPipe result into our MediaPipe-independent FrameObservation. */
export function toObservation(result: GestureRecognizerResult, t: number): FrameObservation {
  const hands: HandObservation[] = result.landmarks.map((lm, i) => {
    const label = (result.handedness[i]?.[0]?.categoryName ?? "Right") as HandLabel;
    const g = result.gestures[i]?.[0];
    return {
      label,
      landmarks: lm.map(({ x, y, z }) => ({ x, y, z })),
      worldLandmarks: result.worldLandmarks[i]?.map(({ x, y, z }) => ({ x, y, z })),
      gesture: g ? { name: g.categoryName, score: g.score } : undefined,
    };
  });
  return { t, hands };
}

export class HandDetector {
  private constructor(private recognizer: GestureRecognizer) {}

  static async create(opts: DetectorOptions): Promise<HandDetector> {
    const fileset = await FilesetResolver.forVisionTasks(opts.wasmPath);
    const recognizer = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opts.modelPath, delegate: opts.delegate ?? "GPU" },
      runningMode: "VIDEO",
      numHands: opts.numHands ?? 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    return new HandDetector(recognizer);
  }

  /** `t` must increase strictly between calls (use performance.now()). */
  detect(frame: HTMLVideoElement | ImageBitmap | VideoFrame, t: number): FrameObservation {
    return toObservation(this.recognizer.recognizeForVideo(frame, t), t);
  }

  close(): void {
    this.recognizer.close();
  }
}
