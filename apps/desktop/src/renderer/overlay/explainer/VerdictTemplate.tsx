import type { ExplainerBody } from "@pointy/shared/overlay/render";
import { CARD } from "@pointy/shared/overlay/measure";
import { ToneGlyph } from "../primitives/ToneGlyph";

type Body = Extract<ExplainerBody, { kind: "verdict" }>;

/** One bullet row per reason (each with the tone glyph: never colour alone). The headline is the card title, which carries its own inline glyph (Card.tsx). */
export function VerdictTemplate({ body }: { body: Body }) {
  return (
    <div className={`verdict verdict-${body.tone}`} data-tone={body.tone}>
      <ul className="verdict-reasons">
        {body.reasons.map((r, i) => (
          <li key={i} className="bullet-row" data-reason={i + 1}>
            <ToneGlyph tone={body.tone} size={CARD.bullet} />
            <span className="bullet-text">{r}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
