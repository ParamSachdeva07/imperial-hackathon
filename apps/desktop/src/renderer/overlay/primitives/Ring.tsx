import type { RenderTarget } from "@pointy/shared/overlay/render";
import type { Tone } from "@pointy/shared/overlay/schemas";
import { targetBox, targetPath } from "../geometry";

/** Gap between the target and the inside edge of the ring stroke. */
export const RING_GAP = 10;
const RADIUS = 14;

export function ringBox(target: RenderTarget) {
  return targetBox(target, RING_GAP);
}

/** Just the pulsing halo (exactly pulseCount calm pulses, then gone) — keyed by callers to re-pulse. */
export function RingHalo({ target, tone }: { target: RenderTarget; tone: Tone }) {
  const d = targetPath(target, RING_GAP, RADIUS);
  return (
    <g className={`ring tone-${tone}`} data-shape="ring-halo">
      <path className="ring-halo" d={d} style={{ d: `path("${d}")` }} />
    </g>
  );
}

/** SVG group: halo pulse (exactly pulseCount times, then gone), white outline, tone stroke. */
export function Ring({ target, tone, pulse = true }: { target: RenderTarget; tone: Tone; pulse?: boolean }) {
  const d = targetPath(target, RING_GAP, RADIUS);
  const style = { d: `path("${d}")` };
  return (
    <g className={`ring tone-${tone}`} data-shape="ring">
      {pulse ? <path className="ring-halo" d={d} style={style} /> : null}
      <path className="shape-outline" d={d} style={style} />
      <path className="shape-stroke" d={d} style={style} />
    </g>
  );
}
