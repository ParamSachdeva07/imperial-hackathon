import type { CSSProperties } from "react";
import type { PointerItem } from "@pointy/shared/overlay/render";
import { totalMs } from "../pointerTimeline";
import { Label } from "./Label";

/**
 * The pointing hand. Drawn pointing RIGHT with the fingertip at the element origin, then rotated
 * by `angle`. The choreography is a single CSS keyframe set per motion (see pointerTimeline.ts);
 * positions come from CSS variables so a moved target just updates the variables.
 */
const HAND = [
  // palm, thumb, index finger (the fingertip is at x=94, y=48)
  { x: 6, y: 30, w: 46, h: 42, r: 14 },
  { x: 26, y: 20, w: 26, h: 22, r: 11 },
  { x: 34, y: 38, w: 60, h: 20, r: 10 },
];

function Hand() {
  return (
    <svg className="ptr-svg" width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
      <g className="ptr-hand-outline">
        {HAND.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={r.r} />
        ))}
      </g>
      <g className="ptr-hand">
        {HAND.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={r.r} />
        ))}
      </g>
    </svg>
  );
}

export function PointerView({ item }: { item: PointerItem }) {
  const vars: Record<string, string> = {
    "--p-entry-x": `${item.entry.x}px`,
    "--p-entry-y": `${item.entry.y}px`,
    "--p-tap-x": `${item.tap.x}px`,
    "--p-tap-y": `${item.tap.y}px`,
    "--p-dragEnd-x": `${(item.dragEnd ?? item.tap).x}px`,
    "--p-dragEnd-y": `${(item.dragEnd ?? item.tap).y}px`,
    "--p-rest-x": `${item.rest.x}px`,
    "--p-rest-y": `${item.rest.y}px`,
    "--p-angle": `${item.angle}deg`,
    "--ptr-total": `${totalMs(item.motion)}ms`,
  };
  return (
    <div className={`item item-pointer ${item.state}`} data-item={item.id} data-motion={item.motion}>
      <div className={`ptr motion-${item.motion}`} style={vars as CSSProperties}>
        <div className="ptr-body">
          <Hand />
        </div>
      </div>
      {item.label ? <Label label={item.label} className="label-late" /> : null}
    </div>
  );
}
