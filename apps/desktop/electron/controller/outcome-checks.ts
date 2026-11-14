import type { DesktopObservation, OutcomeCheck } from '../../../../packages/contracts/src/index';
import { matchingTargets } from './target-identity';

export type Measurement = { identity: string; value: number; unit: string };
export function measuredValue(raw: string): { value: number; unit: string } | undefined {
  const value = raw.trim();
  if (/^\d+(?::[0-5]\d){1,2}(?:\.\d+)?$/.test(value))
    return { value: value.split(':').reduce((total, part) => total * 60 + Number(part), 0), unit: 'clock' };
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s*([^\d]*)$/u);
  if (!match) return;
  return { value: Number(match[1]), unit: match[2].trim() };
}

/** Predicates use supervisor-bound observed descriptors, with no app or language recipes. */
export function checkOutcomes(observation: DesktopObservation, checks: OutcomeCheck[],
  previous: Measurement[], fresh: boolean): { message?: string; measurements: Measurement[]; needsInspection: boolean } {
  const measurements: Measurement[] = [];
  let message: string | undefined;
  let needsInspection = false;
  for (const check of checks) {
    const matches = matchingTargets(observation, check.target, check.kind === 'target_present');
    const bound = check.target.name || check.target.role || check.target.windowTitle || check.target.windowId || check.target.nativeId;
    // Presence is existential. Value/state/measurement predicates still need a
    // unique object; matching one of several identically named fields is unsafe.
    if (bound && check.kind === 'target_present' && matches.length > 0) continue;
    if (!bound || matches.length !== 1) {
      message ||= 'Outcome target is absent or ambiguous in this scope: ' + (check.target.name || '(unbound)') + '. Inspect its branch.';
      needsInspection = true;
      continue;
    }
    const { snapshot, element } = matches[0];
    const fail = (reason: string) => { message ||= `${check.target.name}: ${reason}`; };
    if (check.kind === 'text_equals' && element.value !== check.value) fail('the full value does not equal the requested text.');
    if (check.kind === 'state_present' && !element.states.includes(check.value)) fail('the expected state is not present.');
    if (check.kind === 'state_absent' && element.states.includes(check.value)) fail('the unwanted state is still present.');
    if (check.kind === 'value_advances') {
      const parsed = measuredValue(element.value);
      if (!parsed) {
        fail('no measurable numeric or clock value is exposed.');
        needsInspection = true;
        continue;
      }
      const identity = JSON.stringify([snapshot.app, snapshot.windowId, element.role,
        check.target.nativeId ? [check.target.nativeId, check.target.nativeIdKind, check.target.path] : [element.name, element.path]]);
      measurements.push({ identity, ...parsed });
      const earlier = previous.find(p => p.identity === identity && p.unit === parsed.unit);
      if (!fresh || !earlier || parsed.value <= earlier.value) fail('the measured value has not advanced across fresh observations.');
    }
  }
  return { message, measurements, needsInspection };
}
