import type { ExplainerBody } from "@pointy/shared/overlay/render";
import { conceptImageHeight } from "@pointy/shared/overlay/measure";
import { ImageSlotView } from "./ImageSlot";

type Body = Extract<ExplainerBody, { kind: "concept" }>;

export function ConceptPanels({ body, imageScale = 1 }: { body: Body; imageScale?: number }) {
  return (
    <div className="concept">
      {body.panels.map((p, i) => (
        <div className="concept-panel" key={i} data-panel={i}>
          <ImageSlotView slot={p.image} style={{ height: conceptImageHeight(body.panels.length, imageScale) }} />
          <div className="concept-caption">{p.caption}</div>
        </div>
      ))}
    </div>
  );
}
