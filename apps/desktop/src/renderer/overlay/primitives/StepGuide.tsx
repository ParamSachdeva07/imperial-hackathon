import type { RenderStep, StepsItem } from "@pointy/shared/overlay/render";
import { theme } from "@pointy/shared/overlay/theme";
import { Connector } from "./Connector";
import { Label } from "./Label";
import { Ring, RingHalo } from "./Ring";

/** Small, faint numbered circle on the NEXT step's control — a hint of what comes next. */
export function StepHint({ step }: { step: RenderStep }) {
  const at = step.hint;
  if (!at) return null;
  const size = theme.stepHintSize;
  return (
    <div
      className="step-hint"
      data-step={step.index}
      data-status={step.status}
      style={{ left: at.x - size / 2, top: at.y - size / 2, width: size, height: size }}
    >
      <span>{step.index + 1}</span>
    </div>
  );
}

/**
 * One step at a time (calm, uncluttered): a ring + "Step i of n · label" on the current control and
 * a faint hint on the next one. The ring and label are the SAME elements for the whole guide, so
 * when the guide advances they glide to the next control (theme.anim.stepGlideMs) instead of
 * jumping; the halo is re-keyed per step so it pulses again once the glide has landed.
 * Completed: the ring turns green with "✓ All done" on the last control, then the guide fades.
 */
export function StepsView({ item }: { item: StepsItem }) {
  const focus = item.steps.find((s) => s.labelBox) ?? item.steps.find((s) => s.status === "current" && s.target);
  const hint = item.steps.find((s) => s.hint);
  const tone = item.completed ? "success" : "info";
  return (
    <div className={`item item-steps ${item.state}${item.completed ? " completed" : ""}`} data-item={item.id}>
      <svg className="layer" width="1" height="1" aria-hidden="true">
        {/* Fixed slots (no conditional shifting) so React keeps the same DOM nodes across steps. */}
        <g className="step-ring">{focus?.target ? <Ring target={focus.target} tone={tone} pulse={false} /> : null}</g>
        <g className="step-halo">
          {focus?.target ? <RingHalo key={`${focus.index}-${item.completed}`} target={focus.target} tone={tone} /> : null}
        </g>
        <g className="step-connector">{focus?.labelBox?.connector ? <Connector segment={focus.labelBox.connector} /> : null}</g>
      </svg>
      {hint ? <StepHint step={hint} /> : null}
      <div className="step-label">{focus?.labelBox ? <Label label={focus.labelBox} /> : null}</div>
    </div>
  );
}
