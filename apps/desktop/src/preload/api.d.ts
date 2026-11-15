/** Globals exposed by the preload scripts (contextIsolation bridge). */
import type { FixtureBoundsMessage, ImageFailedMessage, PaintedMessage, RenderScene } from "@pointy/shared/overlay/render";

export interface PointyOverlayApi {
  /** Subscribe to scenes from main. Returns unsubscribe. */
  onScene(cb: (scene: RenderScene) => void): () => void;
  /** Tell main which item ids were painted for a scene seq. */
  painted(msg: PaintedMessage): void;
  /** Image bytes referenced by key from scenes. Returns unsubscribe. */
  onImage(cb: (msg: { key: string; src: string }) => void): () => void;
  onImageDrop(cb: (msg: { keys: string[] }) => void): () => void;
  /** A ready picture failed to decode (main switches it to its fallback icon and tells the controller). */
  imageFailed(msg: ImageFailedMessage): void;
  /** Tell main the renderer is ready to receive scenes. */
  ready(): void;
}

export interface PointyFixtureApi {
  reportBounds(msg: FixtureBoundsMessage): void;
}

declare global {
  interface Window {
    pointyOverlay?: PointyOverlayApi;
    pointyFixture?: PointyFixtureApi;
  }
}
