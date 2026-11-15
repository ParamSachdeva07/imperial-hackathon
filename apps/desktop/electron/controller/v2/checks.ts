import { measuredValue } from '../outcome-checks';
import type { ObservationIndex } from './observation-index';
import type { BoundCheck } from './task-state';

export type Baselines = Map<string, { value: number; unit: string; observationId: string }>;

/** Typed predicates on one uniquely identified element of the current observation. */
export function evaluateCheck(check: BoundCheck, index: ObservationIndex, baselines: Baselines): { pass: boolean; reason?: string } {
  if (check.kind === 'target_present')
    return index.find(check.target, 'weak').length ? { pass: true } : { pass: false, reason: 'The target is not in this scope.' };
  const matches = index.find(check.target, 'strong');
  if (matches.length !== 1) return { pass: false, reason: 'The target is absent or ambiguous in this scope; inspect it first.' };
  const node = matches[0];
  if (check.kind === 'text_equals')
    return node.value === check.value ? { pass: true } : { pass: false, reason: 'The full value does not equal the expected text.' };
  if (check.kind === 'state_present')
    return node.states.includes(check.value) ? { pass: true } : { pass: false, reason: 'The expected state is not present.' };
  if (check.kind === 'state_absent')
    return !node.states.includes(check.value) ? { pass: true } : { pass: false, reason: 'The unwanted state is still present.' };
  const parsed = measuredValue(node.value);
  if (!parsed) return { pass: false, reason: 'No measurable numeric or clock value is exposed.' };
  const key = JSON.stringify(check.target);
  const baseline = baselines.get(key);
  if (!baseline || baseline.unit !== parsed.unit) {
    baselines.set(key, { ...parsed, observationId: index.observation.id });
    return { pass: false, reason: 'A first measurement was recorded; it must advance in a later observation.' };
  }
  return baseline.observationId !== index.observation.id && parsed.value > baseline.value
    ? { pass: true } : { pass: false, reason: 'The measured value has not advanced across observations.' };
}
