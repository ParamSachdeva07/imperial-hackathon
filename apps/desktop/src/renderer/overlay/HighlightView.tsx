import type { HighlightItem } from "@pointy/shared/overlay/render";
import type { Rect } from "@pointy/shared/overlay/schemas";
import { Connector } from "./primitives/Connector";
import { Label } from "./primitives/Label";
import { Ring, ringBox } from "./primitives/Ring";
import { Spotlight, spotlightBox } from "./primitives/Spotlight";
import { GlyphBadge } from "./primitives/ToneGlyph";
import { Underline, underlineLine } from "./primitives/Underline";

const BADGE_HALF = 24; // GlyphBadge default size 48

/**
 * Where the tone glyph badge goes when there's no label (the non-colour cue). Preferred: just
 * outside the shape's top-right corner; if that is off this display (menu bar, right edge), the
 * first other corner — then the underline's end/start — that keeps the badge fully on screen.
 */
export function badgeCentre(item: HighlightItem, display?: Rect): { x: number; y: number } {
  const fits = (p: { x: number; y: number }) =>
    !display ||
    (p.x - BADGE_HALF >= display.x &&
      p.y - BADGE_HALF >= display.y &&
      p.x + BADGE_HALF <= display.x + display.width &&
      p.y + BADGE_HALF <= display.y + display.height);
  let candidates: { x: number; y: number }[];
  if (item.style === "underline") {
    const { x1, x2, y } = underlineLine(item.target);
    candidates = [
      { x: x2 + 34, y },
      { x: x1 - 34, y },
      { x: x2 - 14, y: y + 34 },
    ];
  } else {
    // Just outside a corner of the drawn shape, clear of the target itself.
    const box = item.style === "ring" ? ringBox(item.target) : spotlightBox(item.target);
    const r = box.x + box.width + 14;
    const l = box.x - 14;
    const t = box.y - 14;
    const b = box.y + box.height + 14;
    candidates = [
      { x: r, y: t },
      { x: l, y: t },
      { x: r, y: b },
      { x: l, y: b },
    ];
  }
  return candidates.find(fits) ?? candidates[0]!;
}

export function HighlightView({ item, display }: { item: HighlightItem; display: Rect }) {
  const { style, tone, target, label } = item;
  const badge = label ? null : badgeCentre(item, display);
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
