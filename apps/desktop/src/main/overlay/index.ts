/**
 * The overlay's public entry point (what teammates import). See README.md in this folder.
 */
export { createOverlayControl, type CreateOverlayOptions, type OverlayHandle } from "./createOverlayControl";
export type { OverlayDebug, ScreenSource } from "./ports";
/** The Anam voice avatar: an AvatarController + AvoidRectsProvider (see avatar/AnamAvatarClient.ts). */
export { AnamAvatarClient, anamControlFile } from "./avatar/AnamAvatarClient";
export {
  exportToolDefinitions,
  type AvatarController,
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
