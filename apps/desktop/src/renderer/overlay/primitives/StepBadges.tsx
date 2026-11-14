import type { RenderStep, StepsItem } from "@pointy/shared/overlay/render";
import { theme } from "@pointy/shared/overlay/theme";
import { Icon } from "../icons/Icon";
import { Connector } from "./Connector";
import { Label } from "./Label";
import { Ring } from "./Ring";

export function StepBadge({ step }: { step: RenderStep }) {
  const at = step.badge;
  if (!at) return null;
  const size = theme.stepBadgeSize;
  return (
    <div
      className={`step-badge step-${step.status}`}
      data-step={step.index}
      data-status={step.status}
      style={{ left: at.x - size / 2, top: at.y - size / 2, width: size, height: size }}
    >
      {step.status === "past" ? <Icon name="check" size={32} strokeWidth={6} /> : <span>{step.index + 1}</span>}
    </div>
  );
}

/** Dotted path joining consecutive found badges (trimmed to the badge edges). */
function pathD(steps: RenderStep[]): string[] {
  const found = steps.filter((s) => s.badge);
  const r = theme.stepBadgeSize / 2 + 6;
  const out: string[] = [];
  for (let i = 0; i + 1 < found.length; i++) {
    const a = found[i]!.badge!;
    const b = found[i + 1]!.badge!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= 2 * r + 4) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    out.push(`M${a.x + ux * r} ${a.y + uy * r} L${b.x - ux * r} ${b.y - uy * r}`);
  }
  return out;
}

export function StepsView({ item }: { item: StepsItem }) {
  const current = item.steps.find((s) => s.status === "current");
  return (
    <div className={`item item-steps ${item.state}${item.completed ? " completed" : ""}`} data-item={item.id}>
      <svg className="layer" width="1" height="1" aria-hidden="true">
        {pathD(item.steps).map((d, i) => (
          <g key={i} className="step-path">
            <path className="step-path-outline" d={d} />
            <path className="step-path-dots" d={d} />
          </g>
        ))}
        {current?.target ? <Ring target={current.target} tone="info" /> : null}
        {current?.labelBox?.connector ? <Connector segment={current.labelBox.connector} /> : null}
      </svg>
      {item.steps.map((s) => (
        <StepBadge key={s.index} step={s} />
      ))}
      {current?.labelBox ? <Label label={current.labelBox} /> : null}
    </div>
  );
}
