/** API the gesture preload exposes to the vision page as `window.pointyGestures`. */
import type { GestureEvent } from "../events";
import type { FeedbackMessage, GestureCommand, VisionStatus } from "./protocol";

export interface PointyGesturesApi {
  /** Send the events of one frame to main. */
  emit(events: GestureEvent[]): void;
  status(status: VisionStatus): void;
  /** Subscribe to commands from main. Returns unsubscribe. */
  onCommand(cb: (cmd: GestureCommand) => void): () => void;
  /** Tell main the page is ready to receive commands. */
  ready(): void;
}

export interface PointyGestureFeedbackApi {
  onMessage(cb: (msg: FeedbackMessage) => void): () => void;
}

declare global {
  interface Window {
    pointyGestures?: PointyGesturesApi;
    pointyGestureFeedback?: PointyGestureFeedbackApi;
  }
}
