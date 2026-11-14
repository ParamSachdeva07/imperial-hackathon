import type { ActiveZone } from "./config";

/**
 * Builds the active zone from samples of the (raw, unmirrored) index fingertip
 * recorded while the user points at each screen corner in turn.
 * `margin` slightly shrinks the zone so the corners are reachable without strain.
 */
export function computeActiveZone(
  samples: { x: number; y: number }[],
  mirror: boolean,
  margin = 0.03,
): ActiveZone {
  if (samples.length < 4) throw new Error("Need at least 4 samples (one per corner)");
  const xs = samples.map((s) => (mirror ? 1 - s.x : s.x));
  const ys = samples.map((s) => s.y);
  const x0 = Math.min(...xs) + margin;
  const x1 = Math.max(...xs) - margin;
  const y0 = Math.min(...ys) + margin;
  const y1 = Math.max(...ys) - margin;
  if (x1 - x0 < 0.05 || y1 - y0 < 0.05) throw new Error("Calibration zone too small, try again");
  return { x0, y0, x1, y1 };
}
