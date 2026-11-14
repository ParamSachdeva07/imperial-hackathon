/**
 * The overlay's public entry point (what teammates import). See README.md in this folder.
 */
export { createOverlayControl, DEFAULT_BROKER_URL, type CreateOverlayOptions, type OverlayHandle } from "./createOverlayControl";
export type { OverlayDebug, ScreenSource } from "./ports";
/** imagePrompts that have pre-generated pictures in assetsDir → exportToolDefinitions({ pregeneratedImagePrompts }). */
export { readManifestPrompts } from "./explainer/manifest";
export {
  exportToolDefinitions,
  type AvoidRectsProvider,
  type BoundsProvider,
  type Caller,
  type ElementBounds,
  type FunctionToolDefinition,
  type OverlayControl,
  type OverlayEvent,
  type ScreenCaptureProvider,
  type ToolCallOptions,
  type ToolResult,
} from "@pointy/shared/overlay";
