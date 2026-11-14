/** Tone marker (colour is never the only signal): (i) info, warning triangle, check mark. */
import type { Tone } from "@pointy/shared/overlay/schemas";
import { toneGlyph } from "@pointy/shared/overlay/theme";

/** Filled, white-outlined glyph; works on dark label backgrounds and on any desktop. */
export function ToneGlyph({ tone, size = 28 }: { tone: Tone; size?: number }) {
  const glyph = toneGlyph[tone];
  return (
    <span className={`tone-glyph tone-${tone}`} data-glyph={glyph} style={{ width: size, height: size }}>
      {tone === "warning" ? (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 3.5L30 28H2z" className="glyph-shape" strokeLinejoin="round" />
          <path d="M16 12v8M16 24v.5" className="glyph-mark" />
        </svg>
      ) : (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="14" className="glyph-shape" />
          {tone === "info" ? (
            <path d="M16 14.5v8M16 9v.5" className="glyph-mark" />
          ) : (
            <path d="M9.5 16.5l4.5 4.5 8.5-9.5" className="glyph-mark" />
          )}
        </svg>
      )}
    </span>
  );
}

/** Large glyph placed just outside a ring/spotlight/underline that has no label. */
export function GlyphBadge({ tone, x, y, size = 48 }: { tone: Tone; x: number; y: number; size?: number }) {
  return (
    <div className="glyph-badge" data-glyph-badge={tone} style={{ left: x - size / 2, top: y - size / 2, width: size, height: size }}>
      <ToneGlyph tone={tone} size={size} />
    </div>
  );
}
