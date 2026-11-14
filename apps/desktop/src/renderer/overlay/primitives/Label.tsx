/** Caption box laid out by main. Sized exactly to `rect`; text never overflows (see measure.ts). */
import type { RenderLabel } from "@pointy/shared/overlay/render";
import { ToneGlyph } from "./ToneGlyph";

export function Label({ label, className = "" }: { label: RenderLabel; className?: string }) {
  const { rect, text, tone } = label;
  return (
    <div
      className={`label ${tone ? `tone-${tone}` : ""} ${className}`}
      data-measure="label"
      data-text={text}
      data-glyph={tone ? "1" : "0"}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      {tone ? <ToneGlyph tone={tone} /> : null}
      <span className="label-text">{text}</span>
    </div>
  );
}
