import { useId, type CSSProperties } from "react";
import type { PointerItem } from "@pointy/shared/overlay/render";
import { totalMs } from "../pointerTimeline";
import { Connector } from "./Connector";
import { Label } from "./Label";

/**
 * The pointer: a thin, chalk-drawn arrow. Drawn pointing RIGHT with the tip at the element origin
 * (x=94, y=48 of a 96 x 96 box, scaled to the theme's pointerSize), then rotated by `angle`. The
 * choreography is a single CSS keyframe set per motion (see pointerTimeline.ts); positions come from
 * CSS variables so a moved target just updates the variables.
 *
 * The shaft is a slightly wavy hand stroke whose tail fades and splits into a dry streak; the head is
 * two open strokes. A displacement filter roughens every edge like chalk on a board.
 */
const SHAFT = "M6 53 C 26 45, 52 55, 90 48";
const STREAK = "M3 58 C 16 53, 30 57, 44 53";
const HEAD = "M70 33 L93 48 L72 64";

function Arrow() {
  const id = useId();
  const fade = (name: string, color: string) => (
    <linearGradient id={`${id}${name}`} gradientUnits="userSpaceOnUse" x1="3" y1="0" x2="94" y2="0">
      <stop offset="0" stopColor={color} stopOpacity="0" />
      <stop offset="0.4" stopColor={color} stopOpacity="1" />
    </linearGradient>
  );
  return (
    <svg className="ptr-svg" viewBox="0 0 96 96" aria-hidden="true">
      <defs>
        <filter id={`${id}chalk`} x="-10%" y="-30%" width="120%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="grain" />
          <feDisplacementMap in="SourceGraphic" in2="grain" scale="2.2" />
        </filter>
        {fade("edge", "var(--outline-color)")}
        {fade("ink", "var(--info)")}
      </defs>
      <g className="ptr-chalk" filter={`url(#${id}chalk)`}>
        <path className="ptr-hand-outline" d={SHAFT} stroke={`url(#${id}edge)`} />
        <path className="ptr-hand-outline" d={HEAD} stroke="var(--outline-color)" />
        <path className="ptr-hand ptr-streak" d={STREAK} stroke={`url(#${id}ink)`} />
        <path className="ptr-hand" d={SHAFT} stroke={`url(#${id}ink)`} />
        <path className="ptr-hand" d={HEAD} stroke="var(--info)" />
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
          <Arrow />
        </div>
      </div>
      {item.label?.connector ? (
        <svg className="layer label-late" width="1" height="1" aria-hidden="true">
          <Connector segment={item.label.connector} />
        </svg>
      ) : null}
      {item.label ? <Label label={item.label} className="label-late" /> : null}
    </div>
  );
}
