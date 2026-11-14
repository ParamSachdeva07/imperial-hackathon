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

export function startSteps(total: number, startAt: number): StepsState {
  const max = Math.max(0, total - 1);
  return { total, current: Math.min(Math.max(startAt, 0), max), completed: false };
}

export function advanceSteps(s: StepsState): StepsState {
  if (s.completed) return s;
  const current = s.current + 1;
  if (current >= s.total) return { ...s, current: s.total, completed: true };
  return { ...s, current };
}

export function statusOf(s: StepsState, i: number): StepStatus {
  if (i < s.current) return "past";
  if (i === s.current) return "current";
  return "future";
}
