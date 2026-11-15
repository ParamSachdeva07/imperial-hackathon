import type { ExplainerBody } from "@pointy/shared/overlay/render";
import { Icon } from "../icons/Icon";

type Body = Extract<ExplainerBody, { kind: "sequence" }>;

/** Row of large icons with arrows between them; numbered captions listed underneath. */
export function SequenceTemplate({ body }: { body: Body }) {
  return (
    <div className="seq">
      <div className="seq-row">
        {body.steps.map((s, i) => (
          <div className="seq-cell" key={i}>
            {i > 0 ? (
              <span className="seq-arrow" data-arrow="1">
                <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                  <path d="M4 14h18M15 6l8 8-8 8" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            ) : null}
            <div className="seq-tile" data-icon-tile={s.icon}>
              <Icon name={s.icon} size={48} />
              <span className="seq-n">{i + 1}</span>
            </div>
          </div>
        ))}
      </div>
      <ol className="seq-captions">
        {body.steps.map((s, i) => (
          <li key={i} className="cap-row" data-caption={i + 1}>
            <span className="num">{i + 1}</span>
            <span className="cap-text">{s.caption}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
