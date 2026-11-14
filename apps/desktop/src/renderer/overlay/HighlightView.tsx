import type { HighlightItem } from "@pointy/shared/overlay/render";
import type { Rect } from "@pointy/shared/overlay/schemas";
import { Connector } from "./primitives/Connector";
import { Label } from "./primitives/Label";
import { Ring, ringBox } from "./primitives/Ring";
import { Spotlight, spotlightBox } from "./primitives/Spotlight";
import { GlyphBadge } from "./primitives/ToneGlyph";
import { Underline, underlineLine } from "./primitives/Underline";

function badgeCentre(item: HighlightItem): { x: number; y: number } {
  if (item.style === "underline") {
    const { x2, y } = underlineLine(item.target);
    return { x: x2 + 34, y };
  }
  const box = item.style === "ring" ? ringBox(item.target) : spotlightBox(item.target);
  // Just outside the top-right corner of the drawn shape, clear of the target itself.
  return { x: box.x + box.width + 14, y: box.y - 14 };
}

export function HighlightView({ item, display }: { item: HighlightItem; display: Rect }) {
  const { style, tone, target, label } = item;
  const badge = label ? null : badgeCentre(item);
  return (
    <div className={`item item-highlight style-${style} ${item.state}`} data-item={item.id} data-style={style} data-tone={tone}>
      <svg className="layer" width="1" height="1" aria-hidden="true">
        {style === "ring" ? <Ring target={target} tone={tone} /> : null}
        {style === "spotlight" ? <Spotlight target={target} tone={tone} display={display} /> : null}
        {style === "underline" ? <Underline target={target} tone={tone} /> : null}
        {label?.connector ? <Connector segment={label.connector} /> : null}
      </svg>
      {badge ? <GlyphBadge tone={tone} x={badge.x} y={badge.y} /> : null}
      {label ? <Label label={label} /> : null}
    </div>
  );
}
