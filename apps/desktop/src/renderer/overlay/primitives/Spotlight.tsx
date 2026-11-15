import type { RenderTarget } from "@pointy/shared/overlay/render";
import type { Rect, Tone } from "@pointy/shared/overlay/schemas";
import { roundedRectPath, targetBox, targetPath } from "../geometry";

/** The hole is the target padded slightly. */
export const SPOTLIGHT_PAD = 8;
const RADIUS = 14;

export function spotlightBox(target: RenderTarget) {
  return targetBox(target, SPOTLIGHT_PAD);
}

/**
 * Dim over the whole display window with a rounded hole (true polygon path for polygon targets),
 * outlined in white + tone. Display bounds are global, so across displays only the hole's own
 * window shows it.
 */
export function Spotlight({ target, tone, display }: { target: RenderTarget; tone: Tone; display: Rect }) {
  const hole = targetPath(target, SPOTLIGHT_PAD, RADIUS);
  const dim = `${roundedRectPath({ x: display.x - 2, y: display.y - 2, width: display.width + 4, height: display.height + 4 }, 0)} ${hole}`;
  const holeStyle = { d: `path("${hole}")` };
  const dimStyle = { d: `path("${dim}")` };
  return (
    <g className={`spotlight tone-${tone}`} data-shape="spotlight">
      <path className="spotlight-dim" d={dim} style={dimStyle} fillRule="evenodd" />
      <path className="shape-outline" d={hole} style={holeStyle} />
      <path className="shape-stroke" d={hole} style={holeStyle} />
    </g>
  );
}
