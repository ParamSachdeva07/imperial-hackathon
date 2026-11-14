/**
 * MockScreenCaptureProvider (spec §6): real crops via Electron desktopCapturer (needs the macOS
 * Screen Recording permission), falling back to a static placeholder image when capture fails.
 */
import { desktopCapturer, nativeImage } from "electron";
import type { DisplayInfo, Rect, ScreenCaptureProvider } from "@pointy/shared/overlay";
import { findDisplay, globalDipToDisplayPx } from "../coords";

export class MockScreenCaptureProvider implements ScreenCaptureProvider {
  constructor(
    private readonly getDisplays: () => DisplayInfo[],
    private readonly opts: { staticOnly?: boolean } = {},
  ) {}

  async captureRegion(displayId: string, rectDip: Rect): Promise<Buffer> {
    const display = findDisplay(displayId, this.getDisplays());
    if (!display) throw new Error(`display ${displayId} not found`);
    const px = globalDipToDisplayPx(rectDip, display);
    if (!px) throw new Error("region is not on the display");
    if (!this.opts.staticOnly) {
      try {
        const size = {
          width: Math.round(display.bounds.width * display.scaleFactor),
          height: Math.round(display.bounds.height * display.scaleFactor),
        };
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
        const source = sources.find((s) => s.display_id === displayId) ?? (sources.length === 1 ? sources[0] : undefined);
        if (source && !source.thumbnail.isEmpty()) {
          const img = source.thumbnail;
          // Thumbnails may come back at a different size than requested: rescale the crop rect.
          const sx = img.getSize().width / size.width;
          const sy = img.getSize().height / size.height;
          const crop = {
            x: Math.round(px.x * sx),
            y: Math.round(px.y * sy),
            width: Math.max(1, Math.round(px.width * sx)),
            height: Math.max(1, Math.round(px.height * sy)),
          };
          return img.crop(crop).toPNG();
        }
      } catch {
        // fall through to the static image
      }
    }
    return staticPlaceholder(px.width, px.height);
  }
}

/** A calm grey checker image of the requested pixel size (no text). */
export function staticPlaceholder(width: number, height: number): Buffer {
  const w = Math.max(1, Math.min(4096, Math.round(width)));
  const h = Math.max(1, Math.min(4096, Math.round(height)));
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((x >> 5) + (y >> 5)) % 2 ? 0xd1 : 0xe5;
      const i = (y * w + x) * 4;
      buf[i] = v; // B
      buf[i + 1] = v; // G
      buf[i + 2] = v; // R
      buf[i + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG();
}
