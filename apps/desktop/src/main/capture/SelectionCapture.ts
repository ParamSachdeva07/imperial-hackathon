/**
 * SelectionCapture: when the user selects with a gesture (circled region or held point), capture the
 * screen once, instantly, and build the two images the AI gets (see @pointy/shared/context/selection):
 *   full  - whole display, downscaled (<=1280 wide), selection outlined, the rest dimmed, JPEG q70
 *   focus - unmarked close-up of the selection (<=768 px), JPEG q80
 * Total size is kept under a budget by stepping quality, then size. No Electron import: the capture,
 * image ops, clock and hiding are injected (see nativeImageOps.ts / DesktopCapturerProvider.ts).
 * Never throws; failures are logged (a missing Screen Recording permission loudly, once per session).
 */
import type { GestureEvent } from "@pointy/gestures";
import type { DisplayInfo } from "@pointy/shared/overlay";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import { type BgraImage, dimOutside, drawMarker, drawPolyline } from "./annotate";
import { isScreenPermissionError } from "./errors";
import { normToPx, planSelection, type SelectionPlan } from "./selectionGeometry";

export type { BgraImage } from "./annotate";

export interface ImageOps {
  resize(img: BgraImage, width: number, height: number): BgraImage;
  crop(img: BgraImage, rect: { x: number; y: number; width: number; height: number }): BgraImage;
  encodeJpeg(img: BgraImage, quality: number): Buffer;
}

export interface CaptureLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface SelectionSource {
  onAny(cb: (e: GestureEvent) => void): () => void;
  readonly sessionActive: boolean;
  /** Optional: lets the "permission error logged once per session" flag reset. */
  onSession?(cb: (active: boolean) => void): () => void;
}

export interface SelectionCaptureDeps {
  screen: { getDisplays(): DisplayInfo[] };
  /** One full-display capture at native pixels (BGRA). Must throw on failure. */
  capture(displayId: string): Promise<{ image: BgraImage; display: DisplayInfo }>;
  hiding: { withHidden<T>(fn: () => Promise<T>): Promise<T> };
  ops: ImageOps;
  now(): number;
  log: CaptureLogger;
  store: { set(snapshot: SelectionSnapshot): void };
  /** Total encoded budget in bytes (default 180_000: base64 inflates by 4/3, so both images fit one 256KB data-channel message). */
  budgetBytes?: number;
  newId?: () => string;
}

export interface SelectionCaptureHandle {
  dispose(): void;
  /** Resolves when no capture is in flight (for tests and shutdown). */
  idle(): Promise<void>;
}

export const DEFAULT_BUDGET_BYTES = 180_000;
export const DIM_FACTOR = 0.65;

/** (full quality, focus quality, size scale), tried in order until the total fits the budget. */
export const BUDGET_STEPS: ReadonlyArray<readonly [number, number, number]> = [
  [70, 80, 1],
  [55, 65, 1],
  [40, 50, 1],
  [40, 50, 0.8],
  [40, 50, 0.64],
  [40, 50, 0.5],
];

const dataUrl = (jpeg: Buffer): string => `data:image/jpeg;base64,${jpeg.toString("base64")}`;
const scaled = (n: number, s: number): number => Math.max(1, Math.round(n * s));

function annotateFull(img: BgraImage, plan: SelectionPlan): void {
  const size = { width: img.width, height: img.height };
  if (plan.kind === "region" && plan.polygonNorm) {
    const poly = plan.polygonNorm.map((p) => normToPx(p, size));
    dimOutside(img, { polygon: poly }, DIM_FACTOR);
    drawPolyline(img, poly, { closed: true, thickness: 3 });
  } else if (plan.pointNorm) {
    const b = plan.display.bounds;
    const f = plan.focusBoxGlobal;
    const rect = {
      x: ((f.x - b.x) / b.width) * size.width,
      y: ((f.y - b.y) / b.height) * size.height,
      width: (f.width / b.width) * size.width,
      height: (f.height / b.height) * size.height,
    };
    dimOutside(img, { rect }, DIM_FACTOR);
    const p = normToPx(plan.pointNorm, size);
    drawMarker(img, p.x, p.y, { radius: 20 });
  }
}

/** Build the snapshot from one captured image. Pure given ops. */
export function buildSnapshot(
  plan: SelectionPlan,
  image: BgraImage,
  ops: ImageOps,
  meta: { id: string; capturedAt: number; budgetBytes: number },
): { snapshot: SelectionSnapshot; totalBytes: number; overBudget: boolean } {
  // The capture may not be at the nominal native size: scale the focus crop to what we got.
  const sx = image.width / plan.displayPx.width;
  const sy = image.height / plan.displayPx.height;
  const c = plan.focusCropPx;
  const x = Math.min(image.width - 1, Math.round(c.x * sx));
  const y = Math.min(image.height - 1, Math.round(c.y * sy));
  const focusRaw = ops.crop(image, {
    x,
    y,
    width: Math.max(1, Math.min(image.width - x, Math.round(c.width * sx))),
    height: Math.max(1, Math.min(image.height - y, Math.round(c.height * sy))),
  });

  const fullCache = new Map<number, BgraImage>();
  const focusCache = new Map<number, BgraImage>();
  let last: { full: Buffer; focus: Buffer; fw: number; fh: number; cw: number; ch: number } | null = null;
  let overBudget = true;
  for (const [qFull, qFocus, scale] of BUDGET_STEPS) {
    let fullBase = fullCache.get(scale);
    if (!fullBase) {
      fullBase = ops.resize(image, scaled(plan.fullSize.width, scale), scaled(plan.fullSize.height, scale));
      fullCache.set(scale, fullBase);
    }
    let focusImg = focusCache.get(scale);
    if (!focusImg) {
      focusImg = ops.resize(focusRaw, scaled(plan.focusSize.width, scale), scaled(plan.focusSize.height, scale));
      focusCache.set(scale, focusImg);
    }
    const marked: BgraImage = { data: Buffer.from(fullBase.data), width: fullBase.width, height: fullBase.height };
    annotateFull(marked, plan);
    const full = ops.encodeJpeg(marked, qFull);
    const focus = ops.encodeJpeg(focusImg, qFocus);
    last = { full, focus, fw: marked.width, fh: marked.height, cw: focusImg.width, ch: focusImg.height };
    if (full.length + focus.length <= meta.budgetBytes) {
      overBudget = false;
      break;
    }
  }
  if (!last) throw new Error("no encode attempt ran");
  const snapshot: SelectionSnapshot = {
    id: meta.id,
    kind: plan.kind,
    capturedAt: meta.capturedAt,
    displayId: plan.display.id,
    regionGlobal: plan.regionGlobal,
    ...(plan.polygonGlobal ? { polygonGlobal: plan.polygonGlobal } : {}),
    ...(plan.pointGlobal ? { pointGlobal: plan.pointGlobal } : {}),
    full: { mime: "image/jpeg", dataUrl: dataUrl(last.full), width: last.fw, height: last.fh, markedRegion: plan.markedRegion },
    focus: { mime: "image/jpeg", dataUrl: dataUrl(last.focus), width: last.cw, height: last.ch },
  };
  return { snapshot, totalBytes: last.full.length + last.focus.length, overBudget };
}

export function attachSelectionCapture(source: SelectionSource, deps: SelectionCaptureDeps): SelectionCaptureHandle {
  const budget = deps.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  let seq = 0;
  let counter = 0;
  let permissionLogged = false;
  const inFlight = new Set<Promise<void>>();

  async function handle(event: GestureEvent, mine: number): Promise<void> {
    if (event.type !== "region_selected" && event.type !== "point_selected") return;
    try {
      const planned = planSelection(event, deps.screen.getDisplays());
      if (!planned.ok) {
        deps.log.info(`selection ignored: ${planned.reason}`);
        return;
      }
      const { plan } = planned;
      const shot = await deps.hiding.withHidden(() => deps.capture(plan.display.id));
      const capturedAt = deps.now();
      if (mine !== seq) return; // a newer selection superseded this one
      const id = deps.newId ? deps.newId() : `sel-${capturedAt}-${++counter}`;
      const built = buildSnapshot(plan, shot.image, deps.ops, { id, capturedAt, budgetBytes: budget });
      if (mine !== seq || !source.sessionActive) return;
      if (built.overBudget) deps.log.warn(`selection ${id} is ${built.totalBytes} bytes, over the ${budget} byte budget at the smallest step`);
      deps.store.set(built.snapshot);
      deps.log.info(`selection ${id} captured (${plan.kind}, ${built.totalBytes} bytes)`);
    } catch (e) {
      if (isScreenPermissionError(e)) {
        if (!permissionLogged) {
          permissionLogged = true;
          deps.log.error(`SELECTION CAPTURE BLOCKED: ${e.message}`);
        }
      } else {
        deps.log.warn(`selection capture failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const offAny = source.onAny((e) => {
    if (e.type !== "region_selected" && e.type !== "point_selected") return;
    if (!source.sessionActive) return;
    const p = handle(e, ++seq);
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  });
  const offSession = source.onSession?.((active) => {
    if (!active) {
      permissionLogged = false;
      seq++; // a capture still in flight belongs to the closed session: never publish it
    }
  });

  return {
    dispose() {
      seq++; // drop anything in flight
      offAny();
      offSession?.();
    },
    async idle() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
}
