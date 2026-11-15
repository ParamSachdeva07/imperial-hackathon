/** Procedurally drawn menu-bar glyphs (template images: black + alpha). No electron imports. */
import type { AssistantStatus } from "./assistant/status";

export interface RgbaIcon {
  width: number;
  height: number;
  /** Straight RGBA, row-major. */
  data: Uint8Array;
}

/** Glyph: a cursor-like pointer arrow; the status shows as a ring/dot in the corner. */
export function drawTrayIcon(status: AssistantStatus, scale = 1): RgbaIcon {
  const size = 18 * scale;
  const data = new Uint8Array(size * size * 4);
  const put = (x: number, y: number, a: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    data[i + 3] = Math.max(data[i + 3]!, Math.round(a * 255));
  };
  // Arrow polygon in 18x18 units, supersampled 4x4 for antialiasing.
  const poly: [number, number][] = [
    [3, 2],
    [3, 14],
    [6.2, 11],
    [8.6, 16],
    [10.8, 15],
    [8.4, 10.2],
    [12.6, 10.2],
  ];
  const inside = (px: number, py: number) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const SS = 4;
  const cover = (shape: (x: number, y: number) => boolean) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let n = 0;
        for (let sy = 0; sy < SS; sy++)
          for (let sx = 0; sx < SS; sx++) if (shape((x + (sx + 0.5) / SS) / scale, (y + (sy + 0.5) / SS) / scale)) n++;
        if (n) put(x, y, n / (SS * SS));
      }
  };
  cover(inside);
  // Status badge at bottom-right, centre (14, 4)... keep top-right so the arrow tail stays clear.
  const cx = 14.5;
  const cy = 4;
  const d = (x: number, y: number) => Math.hypot(x - cx, y - cy);
  if (status === "listening" || status === "speaking") cover((x, y) => d(x, y) <= 2.6);
  else if (status === "thinking" || status === "opening") cover((x, y) => d(x, y) <= 2.6 && d(x, y) >= 1.3);
  else if (status === "error") cover((x, y) => Math.abs(x - cx) < 0.8 && y > 1 && y < 5 || (Math.abs(x - cx) < 0.9 && Math.abs(y - 6.6) < 0.9));
  return { width: size, height: size, data };
}

/** Electron wants BGRA bitmaps on little-endian macOS. */
export function toBgra(icon: RgbaIcon): Buffer {
  const out = Buffer.alloc(icon.data.length);
  for (let i = 0; i < icon.data.length; i += 4) {
    out[i] = icon.data[i + 2]!;
    out[i + 1] = icon.data[i + 1]!;
    out[i + 2] = icon.data[i]!;
    out[i + 3] = icon.data[i + 3]!;
  }
  return out;
}
