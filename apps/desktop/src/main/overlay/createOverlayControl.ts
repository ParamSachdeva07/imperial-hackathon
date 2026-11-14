/**
 * Integration entry point for teammates:
 *
 *   const overlay = createOverlayControl({ boundsProvider, captureProvider, avoidRects, assetsDir });
 *   // register exportToolDefinitions() with the voice model; route its calls to overlay.control.handleTool
 *   // forward overlay.control.onEvent(...) to the model; call onTurnStart/onContextChange/onTargetSelected
 *   overlay.dispose();
 *
 * Everything else (windows, layout, anchors, expiry, images) is internal.
 */
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { AvatarController, AvoidRectsProvider, BoundsProvider, OverlayControl, ScreenCaptureProvider } from "@pointy/shared/overlay";
import { loadRendererPage, PRELOAD_DIR } from "../rendererPages";
import { FalClient, type ImageSource } from "./explainer/falClient";
import { createGestureFeedbackBridge, type GestureEventSource } from "./GestureFeedbackBridge";
import { OverlayService } from "./OverlayService";
import { ElectronScreen, OverlayWindowManager } from "./OverlayWindowManager";
import { getOverlayPlatform } from "./platform";
import type { OverlayDebug, ScreenSource } from "./ports";

export const DEFAULT_BROKER_URL = "http://127.0.0.1:47620";

export interface CreateOverlayOptions {
  /** Accessibility teammate: where elements are (spec §6). */
  boundsProvider: BoundsProvider;
  /** Capture teammate: screen crops for `anatomy` cards (spec §6). */
  captureProvider: ScreenCaptureProvider;
  /** Rects to keep clear, e.g. the avatar window. */
  avoidRects?: AvoidRectsProvider;
  /** The voice avatar window: enables the `move_avatar` tool and auto-dodge. Usually the same object as `avoidRects`. */
  avatar?: AvatarController;
  /**
   * Folder with pre-generated explainer pictures (assets/explainers). Enables concept/compare
   * pictures (local assets first, then the fal.ai broker). Without it — and without `imageSource` —
   * those panels show their large fallback icon.
   */
  assetsDir?: string;
  /** fal.ai broker (backend/explainer-broker). Default DEFAULT_BROKER_URL. */
  brokerUrl?: string;
  /** Replace the picture source entirely (tests, other backends). */
  imageSource?: ImageSource;
  /** Share one display source with your own code (default: Electron's `screen`). */
  screen?: ScreenSource;
  /** Development-only switches. */
  dev?: {
    /** false lets screenshots include the overlay (dev screenshots only). Default true. */
    contentProtection?: boolean;
    /** Hide the overlay while capturing anatomy crops (if capture ignores content protection). */
    hideDuringCapture?: boolean;
    /** Force reduce-motion (otherwise the macOS accessibility setting decides). */
    forceReduceMotion?: boolean;
    /** Custom overlay page/preload (default: the built ones next to the main bundle). */
    renderer?: { preloadPath: string; loadPage: (win: BrowserWindow) => Promise<void> };
  };
}

export interface OverlayHandle {
  /** The contract the controller uses (packages/shared/src/overlay/interfaces.ts). */
  control: OverlayControl;
  /** Dev-only introspection (dev server / CLI). */
  debug: OverlayDebug;
  /**
   * Hand-gesture feedback (cursor, hold rings, trail, selections) drawn on every display. Feed it a
   * GestureService (`overlay.gestures.attach(gestureService)`) and mirror the controller's session
   * flag with `setSessionActive`. Separate from `control`: it never touches the scene.
   */
  gestures: {
    /** Subscribe to a source's events; returns detach. */
    attach(source: GestureEventSource): () => void;
    setSessionActive(active: boolean): void;
  };
  dispose(): void;
}

export function createOverlayControl(opts: CreateOverlayOptions): OverlayHandle {
  const platform = getOverlayPlatform();
  const screen = opts.screen ?? new ElectronScreen();
  const dev = opts.dev ?? {};
  const windows = new OverlayWindowManager(
    {
      platform,
      preloadPath: dev.renderer?.preloadPath ?? join(PRELOAD_DIR, "overlay.js"),
      loadPage: dev.renderer?.loadPage ?? ((win) => loadRendererPage(win, "overlay")),
      contentProtection: dev.contentProtection ?? true,
    },
    screen,
  );
  windows.start();
  const imageSource =
    opts.imageSource ??
    (opts.assetsDir ? new FalClient({ brokerUrl: opts.brokerUrl ?? DEFAULT_BROKER_URL, assetsDir: opts.assetsDir }) : undefined);
  const service = new OverlayService({
    boundsProvider: opts.boundsProvider,
    captureProvider: opts.captureProvider,
    screen,
    sink: windows,
    ...(opts.avoidRects ? { avoidRects: opts.avoidRects } : {}),
    ...(opts.avatar ? { avatar: opts.avatar } : {}),
    ...(imageSource ? { imageSource } : {}),
    hideDuringCapture: dev.hideDuringCapture ?? false,
    reduceMotion: () => Boolean(dev.forceReduceMotion) || platform.prefersReducedMotion(),
  });
  const bridge = createGestureFeedbackBridge({ screen, sink: windows });
  return {
    control: service,
    debug: service.createDebug(),
    gestures: {
      attach: (source) => bridge.attach(source),
      setSessionActive: (active) => bridge.setSessionActive(active),
    },
    dispose() {
      bridge.dispose();
      service.dispose();
      windows.stop();
    },
  };
}
