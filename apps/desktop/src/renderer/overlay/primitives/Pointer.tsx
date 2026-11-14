import type { CSSProperties } from "react";
import type { PointerItem } from "@pointy/shared/overlay/render";
import { totalMs } from "../pointerTimeline";
import { Label } from "./Label";

/**
 * The pointer: a bold arrow (clearer than a hand at a glance for older eyes). Drawn pointing RIGHT
 * with the tip at the element origin (x=94, y=48), then rotated by `angle`. The choreography is a
 * single CSS keyframe set per motion (see pointerTimeline.ts); positions come from CSS variables so
 * a moved target just updates the variables.
 */
const ARROW = "M94 48 L56 14 L56 34 L6 34 L6 62 L56 62 L56 82 Z";

function Arrow() {
  return (
    <svg className="ptr-svg" width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
      <path className="ptr-hand-outline" d={ARROW} />
      <path className="ptr-hand" d={ARROW} />
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
          <Arrow />
        </div>
      </div>
      {item.label ? <Label label={item.label} className="label-late" /> : null}
    </div>
  );
}
