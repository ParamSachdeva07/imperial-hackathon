import type { PartsItem } from "@pointy/shared/overlay/render";
import { Connector } from "./primitives/Connector";
import { Label } from "./primitives/Label";
import { Ring } from "./primitives/Ring";

/** `label_parts`: a ring plus a caption (with its tone glyph) on each part, one drawing. */
export function PartsView({ item }: { item: PartsItem }) {
  return (
    <div className={`item item-parts ${item.state}`} data-item={item.id} data-parts={item.parts.length}>
      <svg className="layer" width="1" height="1" aria-hidden="true">
        {item.parts.map((p) => (
          <g key={p.index} data-part={p.index} data-tone={p.tone}>
            <Ring target={p.target} tone={p.tone} />
            {p.label?.connector ? <Connector segment={p.label.connector} /> : null}
          </g>
        ))}
      </svg>
      {item.parts.map((p) => (p.label ? <Label key={p.index} label={p.label} /> : null))}
      {item.title ? <Label label={item.title} className="parts-title" /> : null}
    </div>
  );
}
