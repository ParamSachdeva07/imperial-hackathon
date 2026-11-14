import type { Segment } from "@pointy/shared/overlay/render";

/** White-outlined line between a label/card and its anchor. Rendered inside an item's SVG layer. */
export function Connector({ segment, className = "" }: { segment: Segment; className?: string }) {
  const { from, to } = segment;
  return (
    <g className={`connector ${className}`} data-connector="1">
      <line className="connector-outline" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
      <line className="connector-line" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
      <circle className="connector-dot-outline" cx={to.x} cy={to.y} r={9} />
      <circle className="connector-dot" cx={to.x} cy={to.y} r={6} />
    </g>
  );
}
