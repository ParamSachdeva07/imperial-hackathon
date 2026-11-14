import type { CompareSideBody, ExplainerBody } from "@pointy/shared/overlay/render";
import { compareImageHeight } from "@pointy/shared/overlay/measure";
import { ToneGlyph } from "../primitives/ToneGlyph";
import { ImageSlotView } from "./ImageSlot";

type Body = Extract<ExplainerBody, { kind: "compare" }>;

function Side({ side, tone, imageScale }: { side: CompareSideBody; tone: "success" | "warning"; imageScale: number }) {
  return (
    <div className={`cmp-col cmp-${tone}`} data-side={tone === "success" ? "left" : "right"}>
      {side.image ? <ImageSlotView slot={side.image} style={{ height: compareImageHeight(imageScale) }} /> : null}
      <div className="cmp-head">{side.title}</div>
      {side.points.length > 0 ? (
        <ul className="cmp-points">
          {side.points.map((p, i) => (
            <li key={i} className="bullet-row">
              <ToneGlyph tone={tone} size={28} />
              <span className="bullet-text">{p}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CompareTemplate({ body, imageScale = 1 }: { body: Body; imageScale?: number }) {
  return (
    <div className="cmp">
      <Side side={body.left} tone="success" imageScale={imageScale} />
      <Side side={body.right} tone="warning" imageScale={imageScale} />
    </div>
  );
}
