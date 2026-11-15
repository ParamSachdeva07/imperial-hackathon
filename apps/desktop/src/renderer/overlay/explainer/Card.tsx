import type { ExplainerItem } from "@pointy/shared/overlay/render";
import { CARD } from "@pointy/shared/overlay/measure";
import { Connector } from "../primitives/Connector";
import { AnatomyTemplate } from "./AnatomyTemplate";
import { CompareTemplate } from "./CompareTemplate";
import { ConceptPanels } from "./ConceptPanel";
import { ImageErrorContext } from "./ImageSlot";
import { ToneGlyph } from "../primitives/ToneGlyph";
import { SequenceTemplate } from "./SequenceTemplate";
import { VerdictTemplate } from "./VerdictTemplate";

function Body({ item }: { item: ExplainerItem }) {
  const { body } = item;
  const imageScale = item.imageScale ?? 1;
  switch (body.kind) {
    case "sequence":
      return <SequenceTemplate body={body} />;
    case "compare":
      return <CompareTemplate body={body} imageScale={imageScale} />;
    case "anatomy":
      return <AnatomyTemplate body={body} imageScale={imageScale} />;
    case "verdict":
      return <VerdictTemplate body={body} />;
    case "concept":
      return <ConceptPanels body={body} imageScale={imageScale} />;
  }
}

/** Card laid out at `designSize`, scaled by `scale`, placed at `card` (global DIP). */
export function CardView({ item }: { item: ExplainerItem }) {
  const { card, designSize, scale } = item;
  return (
    <div className={`item item-explainer ${item.state}`} data-item={item.id} data-kind={item.body.kind} data-tone={item.body.kind === "verdict" ? item.body.tone : undefined}>
      <svg className="layer" width="1" height="1" aria-hidden="true">
        {item.connector ? <Connector segment={item.connector} /> : null}
      </svg>
      <div className="card-wrap" style={{ left: card.x, top: card.y, width: card.width, height: card.height }}>
        <div
          className={`card${item.body.kind === "verdict" ? ` tone-${item.body.tone}` : ""}`}
          data-measure="card"
          style={{ width: designSize.width, height: designSize.height, transform: `scale(${scale})` }}
        >
          <div className="card-flow">
            {item.body.kind === "verdict" ? (
              <div className="verdict-head" data-verdict-glyph={item.body.tone}>
                <span className="verdict-head-glyph" style={{ width: CARD.titleGlyph, height: CARD.titleGlyph, marginRight: CARD.titleGlyphGap }}>
                  <ToneGlyph tone={item.body.tone} size={CARD.titleGlyph} />
                </span>
                <h2 className="card-title">{item.title}</h2>
              </div>
            ) : (
              <h2 className="card-title">{item.title}</h2>
            )}
            <div className="card-body">
              <ImageErrorContext.Provider value={(panel) => window.pointyOverlay?.imageFailed({ overlayId: item.id, panel })}>
                <Body item={item} />
              </ImageErrorContext.Provider>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
