/** API the gesture preload exposes to the vision page as `window.pointyGestures`. */
import type { GestureEvent } from "../events";
import type { GestureCommand, VisionStatus } from "./protocol";

export interface PointyGesturesApi {
  /** Send the events of one frame to main. */
  emit(events: GestureEvent[]): void;
  status(status: VisionStatus): void;
  /** Subscribe to commands from main. Returns unsubscribe. */
  onCommand(cb: (cmd: GestureCommand) => void): () => void;
  /** Tell main the page is ready to receive commands. */
  ready(): void;
}

declare global {
  interface Window {
    pointyGestures?: PointyGesturesApi;
  }
}
