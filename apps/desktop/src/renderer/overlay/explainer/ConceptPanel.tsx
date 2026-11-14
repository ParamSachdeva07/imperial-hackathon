import type { ExplainerBody } from "@pointy/shared/overlay/render";
import { ImageSlotView } from "./ImageSlot";

type Body = Extract<ExplainerBody, { kind: "concept" }>;

export function ConceptPanels({ body }: { body: Body }) {
  return (
    <div className="concept">
      {body.panels.map((p, i) => (
        <div className="concept-panel" key={i} data-panel={i}>
          <ImageSlotView slot={p.image} style={{ height: "var(--concept-image-h)" }} />
          <div className="concept-caption">{p.caption}</div>
        </div>
      ))}
    </div>
  );
}
