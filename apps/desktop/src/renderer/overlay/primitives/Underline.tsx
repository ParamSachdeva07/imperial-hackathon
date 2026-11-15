import type { RenderTarget } from "@pointy/shared/overlay/render";
import type { Tone } from "@pointy/shared/overlay/schemas";
import { targetBox } from "../geometry";

const GAP = 12;

/** Line geometry: a bar just below the target's bounds, never touching it. */
export function underlineLine(target: RenderTarget) {
  const box = targetBox(target, 0);
  const y = box.y + box.height + GAP;
  return { x1: box.x, x2: box.x + box.width, y };
}

export function Underline({ target, tone }: { target: RenderTarget; tone: Tone }) {
  const { x1, x2, y } = underlineLine(target);
  const d = `M${x1} ${y} H${x2}`;
  const style = { d: `path("${d}")` };
  return (
    <g className={`underline tone-${tone}`} data-shape="underline">
      <path className="shape-outline" d={d} style={style} />
      <path className="shape-stroke" d={d} style={style} />
    </g>
  );
}
