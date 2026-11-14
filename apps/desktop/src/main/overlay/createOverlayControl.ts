/**
 * Integration entry point for teammates: build the overlay with real (or mock) providers.
 *
 *   const overlay = createOverlayControl({ boundsProvider, captureProvider, avoidRects, preloadPath, loadPage });
 *   controller.registerTools(exportToolDefinitions(), (name, input) => overlay.control.handleTool(name, input));
 */
import type { BrowserWindow } from "electron";
import type { AvoidRectsProvider, BoundsProvider, ScreenCaptureProvider } from "@pointy/shared/overlay";
import { FalClient, type ImageSource } from "./explainer/falClient";
import { OverlayService } from "./OverlayService";
import { ElectronScreen, OverlayWindowManager } from "./OverlayWindowManager";
import { getOverlayPlatform } from "./platform";

export interface CreateOverlayOptions {
  boundsProvider: BoundsProvider;
  captureProvider: ScreenCaptureProvider;
  avoidRects?: AvoidRectsProvider;
  /** Path to the built overlay preload (out/preload/overlay.js). */
  preloadPath: string;
  /** Loads the overlay renderer page into a window. */
  loadPage: (win: BrowserWindow) => Promise<void>;
  /** Image source for concept/compare images. Default: FalClient → local broker + bundled assets. */
  imageSource?: ImageSource;
  brokerUrl?: string;
  assetsDir?: string;
  /** Disable only for dev screenshots of the overlay itself. Default true. */
  contentProtection?: boolean;
  /** Hide overlays while capturing for anatomy (if content protection doesn't exclude them). */
  hideDuringCapture?: boolean;
}

export function createOverlayControl(opts: CreateOverlayOptions) {
  const platform = getOverlayPlatform();
  const screen = new ElectronScreen();
  const windows = new OverlayWindowManager(
    {
      platform,
      preloadPath: opts.preloadPath,
      loadPage: opts.loadPage,
      contentProtection: opts.contentProtection ?? true,
    },
    screen,
  );
  windows.start();
  const imageSource =
    opts.imageSource ??
    (opts.assetsDir
      ? new FalClient({ brokerUrl: opts.brokerUrl ?? "http://127.0.0.1:47620", assetsDir: opts.assetsDir })
      : undefined);
  const control = new OverlayService({
    boundsProvider: opts.boundsProvider,
    captureProvider: opts.captureProvider,
    screen,
    sink: windows,
    ...(opts.avoidRects ? { avoidRects: opts.avoidRects } : {}),
    ...(imageSource ? { imageSource } : {}),
    ...(opts.hideDuringCapture !== undefined ? { hideDuringCapture: opts.hideDuringCapture } : {}),
    reduceMotion: () => process.env.POINTY_REDUCE_MOTION === "1" || platform.prefersReducedMotion(),
  });
  return {
    control,
    dispose() {
      control.dispose();
      windows.stop();
    },
  };
}
