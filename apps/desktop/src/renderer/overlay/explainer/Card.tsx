import type { ExplainerItem } from "@pointy/shared/overlay/render";
import { Connector } from "../primitives/Connector";
import { AnatomyTemplate } from "./AnatomyTemplate";
import { CompareTemplate } from "./CompareTemplate";
import { ConceptPanels } from "./ConceptPanel";
import { SequenceTemplate } from "./SequenceTemplate";

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
    case "concept":
      return <ConceptPanels body={body} imageScale={imageScale} />;
  }
}

/** Card laid out at `designSize`, scaled by `scale`, placed at `card` (global DIP). */
export function CardView({ item }: { item: ExplainerItem }) {
  const { card, designSize, scale } = item;
  return (
    <div className={`item item-explainer ${item.state}`} data-item={item.id} data-kind={item.body.kind}>
      <svg className="layer" width="1" height="1" aria-hidden="true">
        {item.connector ? <Connector segment={item.connector} /> : null}
      </svg>
      <div className="card-wrap" style={{ left: card.x, top: card.y, width: card.width, height: card.height }}>
        <div
          className="card"
          data-measure="card"
          style={{ width: designSize.width, height: designSize.height, transform: `scale(${scale})` }}
        >
          <div className="card-flow">
            <h2 className="card-title">{item.title}</h2>
            <div className="card-body">
              <Body item={item} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
