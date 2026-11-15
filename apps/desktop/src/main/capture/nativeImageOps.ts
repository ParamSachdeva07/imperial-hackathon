/** Electron adapter for SelectionCapture's image ops: BGRA buffers <-> nativeImage. */
import { nativeImage, type NativeImage } from "electron";
import type { DisplayInfo } from "@pointy/shared/overlay";
import type { BgraImage, ImageOps } from "./SelectionCapture";

export function nativeToBgra(img: NativeImage): BgraImage {
  const { width, height } = img.getSize();
  return { data: img.toBitmap(), width, height };
}

function fromBgra(img: BgraImage): NativeImage {
  return nativeImage.createFromBitmap(img.data, { width: img.width, height: img.height });
}

export const nativeImageOps: ImageOps = {
  resize(img, width, height) {
    if (img.width === width && img.height === height) return img;
    return nativeToBgra(fromBgra(img).resize({ width, height, quality: "best" }));
  },
  crop(img, rect) {
    return nativeToBgra(fromBgra(img).crop(rect));
  },
  encodeJpeg(img, quality) {
    return fromBgra(img).toJPEG(quality);
  },
};

/** Adapts DesktopCapturerProvider.captureDisplay to SelectionCaptureDeps.capture. */
export function bgraCapture(provider: {
  captureDisplay(displayId: string): Promise<{ image: NativeImage; display: DisplayInfo }>;
}): (displayId: string) => Promise<{ image: BgraImage; display: DisplayInfo }> {
  return async (displayId) => {
    const { image, display } = await provider.captureDisplay(displayId);
    return { image: nativeToBgra(image), display };
  };
}
