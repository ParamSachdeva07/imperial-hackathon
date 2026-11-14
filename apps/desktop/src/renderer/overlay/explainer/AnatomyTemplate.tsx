import type { AnatomyCallout, ExplainerBody } from "@pointy/shared/overlay/render";
import { CARD_INNER, ANATOMY_IMAGE_H } from "@pointy/shared/overlay/measure";
import { fitContain } from "../geometry";
import { ImageSlotView } from "./ImageSlot";

type Body = Extract<ExplainerBody, { kind: "anatomy" }>;

const DOT = 36;

/** Where a callout's number dot sits inside the image box: top-left corner of its bounds. */
export function calloutDot(c: AnatomyCallout, aspect: number): { x: number; y: number } {
  const fit = fitContain({ width: CARD_INNER, height: ANATOMY_IMAGE_H }, aspect);
  return { x: fit.x + c.nx * fit.width, y: fit.y + c.ny * fit.height };
}

export function AnatomyTemplate({ body }: { body: Body }) {
  const fit = fitContain({ width: CARD_INNER, height: ANATOMY_IMAGE_H }, body.aspect);
  return (
    <div className="ana">
      <ImageSlotView slot={body.image} fit="contain" style={{ height: "var(--anatomy-image-h)" }}>
        {body.callouts
          .filter((c) => c.inside)
          .map((c) => {
            const dot = calloutDot(c, body.aspect);
            return (
              <div key={c.n}>
                <div
                  className="ana-box"
                  style={{ left: fit.x + c.nx * fit.width, top: fit.y + c.ny * fit.height, width: c.nw * fit.width, height: c.nh * fit.height }}
                />
                <div className="ana-dot" data-callout={c.n} style={{ left: dot.x - DOT / 2, top: dot.y - DOT / 2, width: DOT, height: DOT }}>
                  {c.n}
                </div>
              </div>
            );
          })}
      </ImageSlotView>
      <ol className="ana-legend">
        {body.callouts.map((c) => (
          <li key={c.n} className="cap-row" data-legend={c.n}>
            <span className="num">{c.n}</span>
            <span className="cap-text">{c.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
