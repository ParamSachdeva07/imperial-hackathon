/**
 * A frozen snapshot of what the user selected with a gesture (dragged rectangle or held point), taken
 * the moment the selection happened. Producers: apps/desktop/src/main/capture (SelectionCapture).
 * Consumers: the GPT Realtime dev voice loop today; the brain/controller (Jev) later.
 *
 * The AI gets two images: `full` is the whole display (downscaled) with the selection marked and the
 * rest dimmed, for context; `focus` is a sharper, unmarked close-up of the selection.
 * All geometry is global DIP (origin = top-left of the primary display), like the overlay contract.
 */
import type { Point, Rect } from "../overlay/schemas";

export type SelectionKind = "region" | "point";

export interface SelectionImage {
  mime: "image/jpeg";
  /** `data:image/jpeg;base64,...` */
  dataUrl: string;
  /** Pixel size of the encoded image. */
  width: number;
  height: number;
}

export interface SelectionSnapshot {
  /** Unique per capture. */
  id: string;
  kind: SelectionKind;
  /** Epoch ms when the screen was captured (wall clock, main process). */
  capturedAt: number;
  /** Overlay display id (String(electron display.id)). */
  displayId: string;
  /** Region: the selection's bounding box. Point: the focus box around the point. Global DIP. */
  regionGlobal: Rect;
  /**
   * The exact global-DIP box the `focus` close-up was cropped from (padded / grown to a minimum size / clamped to the display, so
   * it differs from `regionGlobal`). Map focus-image pixel (px, py) to global: x = focusGlobal.x + px / focus.width * focusGlobal.width,
   * y likewise. Optional for older producers.
   */
  focusGlobal?: Rect;
  /** Region only: the selected rectangle's corners, global DIP. */
  polygonGlobal?: Point[];
  /** Point only: the selected point, global DIP. */
  pointGlobal?: Point;
  /** Whole display, downscaled, selection marked; `markedRegion` = selection bbox as 0..1 fractions of the image. */
  full: SelectionImage & { markedRegion: Rect };
  /** Close-up of the selection (unmarked). */
  focus: SelectionImage;
}

/** Metadata safe to log or stream (no image bytes). */
export type SelectionSnapshotMeta = Omit<SelectionSnapshot, "full" | "focus"> & {
  full: Omit<SelectionSnapshot["full"], "dataUrl"> & { bytes: number };
  focus: Omit<SelectionImage, "dataUrl"> & { bytes: number };
};

/** Approximate decoded byte size of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export function snapshotMeta(s: SelectionSnapshot): SelectionSnapshotMeta {
  const { full, focus, ...rest } = s;
  const { dataUrl: fullUrl, ...fullRest } = full;
  const { dataUrl: focusUrl, ...focusRest } = focus;
  return {
    ...rest,
    full: { ...fullRest, bytes: dataUrlBytes(fullUrl) },
    focus: { ...focusRest, bytes: dataUrlBytes(focusUrl) },
  };
}
