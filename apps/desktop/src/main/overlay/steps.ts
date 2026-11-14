/**
 * Step-guide state machine (show_steps / advance_step). Pure.
 * STUB (Phase 0): implemented by the logic track.
 *
 *  - startSteps(total, startAt): current = clamp(startAt, 0, total - 1), completed = false.
 *  - advanceSteps(s): no-op when completed; otherwise current + 1; when that reaches `total`,
 *    completed = true and current = total (every step is then "past").
 *  - statusOf(s, i): i < current → "past", i === current → "current", else "future".
 */
import type { StepStatus } from "@pointy/shared/overlay";

export interface StepsState {
  total: number;
  current: number;
  completed: boolean;
}

export function startSteps(_total: number, _startAt: number): StepsState {
  throw new Error("not implemented: steps.startSteps");
}

export function advanceSteps(_s: StepsState): StepsState {
  throw new Error("not implemented: steps.advanceSteps");
}

export function statusOf(_s: StepsState, _i: number): StepStatus {
  throw new Error("not implemented: steps.statusOf");
}
