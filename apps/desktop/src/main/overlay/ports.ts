/**
 * Ports that keep OverlayService free of Electron, so it can be integration-tested in Node with
 * fakes. The Electron implementations are OverlayWindowManager (SceneSink) and ElectronScreen
 * (ScreenSource).
 */
import type { DisplayInfo, Rect, RenderItem } from "@pointy/shared/overlay";
import type { GestureFeedbackMessage } from "@pointy/shared/overlay/render";

export interface ScreenSource {
  getDisplays(): DisplayInfo[];
  getPrimaryDisplayId(): string;
  /** Fires after displays are added, removed, or change metrics. Returns unsubscribe. */
  onDisplaysChanged(cb: () => void): () => void;
}

export interface SceneSink {
  /** Replace the full set of items drawn on every overlay window. */
  publish(items: RenderItem[], opts: { reduceMotion: boolean }): void;
  /** Item ids reported painted by any overlay window. Returns unsubscribe. */
  onPainted(cb: (ids: string[]) => void): () => void;
  /** A ready picture failed to decode in an overlay window. Returns unsubscribe. */
  onImageFailed(cb: (overlayId: string, panel: number) => void): () => void;
  /** Native window ids (macOS CGWindowID) of the overlay windows. */
  getWindowIds(): number[];
  withHidden<T>(fn: () => Promise<T>): Promise<T>;
}

/** Where gesture feedback goes (the overlay windows). Kept off SceneSink: it is a separate ~30 fps stream. */
export interface GestureSink {
  /** Send one batch to every ready overlay window. No scene, no seq. */
  sendGesture(msg: GestureFeedbackMessage): void;
}

/** Dev-only introspection (dev server / CLI), kept off the OverlayControl contract. */
export interface OverlayDebug {
  /** One row per live annotation. */
  state(): { id: string; tool: string; state: string; bounds: Rect | null; steps: unknown }[];
  /** An anatomy card's captured image (data URL), to verify capture exclusion; null if none. */
  anatomyImage(id: string): string | null;
}
