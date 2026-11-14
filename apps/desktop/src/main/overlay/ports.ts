/**
 * Ports that keep OverlayService free of Electron, so it can be integration-tested in Node with
 * fakes. The Electron implementations are OverlayWindowManager (SceneSink) and ElectronScreen
 * (ScreenSource).
 */
import type { DisplayInfo, RenderItem } from "@pointy/shared/overlay";

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
  /** Native window ids (macOS CGWindowID) of the overlay windows. */
  getWindowIds(): number[];
  withHidden<T>(fn: () => Promise<T>): Promise<T>;
}
