/**
 * Real screen capture via Electron desktopCapturer. Unlike MockScreenCaptureProvider it never
 * falls back to a placeholder: every failure throws (ScreenPermissionError for the macOS permission).
 */
import { desktopCapturer, systemPreferences, type NativeImage } from "electron";
import type { DisplayInfo, Rect, ScreenCaptureProvider } from "@pointy/shared/overlay";
import { findDisplay, globalDipToDisplayPx } from "../overlay/coords";
import { ScreenPermissionError } from "./errors";

export { ScreenPermissionError } from "./errors";

export class DesktopCapturerProvider implements ScreenCaptureProvider {
  constructor(private readonly getDisplays: () => DisplayInfo[]) {}

  /** One full-display thumbnail at native pixels. Throws on missing permission, source or image. */
  async captureDisplay(displayId: string): Promise<{ image: NativeImage; display: DisplayInfo }> {
    // Not-yet-granted status is checked AFTER the attempt: calling getSources is what makes macOS
    // show the Screen Recording prompt and list the app, so it must not be skipped.
    const status = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "granted";
    const display = findDisplay(displayId, this.getDisplays());
    if (!display) throw new Error(`display ${displayId} not found`);
    const size = {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    const source = sources.find((s) => s.display_id === displayId) ?? (sources.length === 1 ? sources[0] : undefined);
    if (status !== "granted") throw new ScreenPermissionError(status);
    if (!source) throw new Error(`no screen source for display ${displayId}`);
    if (source.thumbnail.isEmpty()) throw new Error(`empty screen capture for display ${displayId}`);
    return { image: source.thumbnail, display };
  }

  async captureRegion(displayId: string, rectDip: Rect): Promise<Buffer> {
    const { image, display } = await this.captureDisplay(displayId);
    const px = globalDipToDisplayPx(rectDip, display);
    if (!px) throw new Error("region is not on the display");
    const nominal = { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) };
    const sx = image.getSize().width / nominal.width;
    const sy = image.getSize().height / nominal.height;
    return image
      .crop({ x: Math.round(px.x * sx), y: Math.round(px.y * sy), width: Math.max(1, Math.round(px.width * sx)), height: Math.max(1, Math.round(px.height * sy)) })
      .toPNG();
  }
}
