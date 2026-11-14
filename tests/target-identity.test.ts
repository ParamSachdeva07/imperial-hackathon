import { describe, expect, it } from 'vitest';
import { checkOutcomes } from '../apps/desktop/electron/controller/outcome-checks';
import { matchingTargets, sameBoundIdentity } from '../apps/desktop/electron/controller/target-identity';
import { decisionPage } from '../apps/desktop/electron/controller/decision-context';
import { DesktopDecisionRequestSchema, TaskInputSchema, type DesktopObservation, type Element, type OutcomeTarget } from '../packages/contracts/src/index';

const target: OutcomeTarget = { app: 'Example', windowId: 'w1', windowTitle: 'Old title',
  role: 'textfield', name: 'Value', nativeId: 'first', nativeIdKind: 'identifier', path: 'First panel' };
const field: Element = { ref: '@s1:e1', role: 'textfield', name: 'Value', nativeId: 'first',
  nativeIdKind: 'identifier', path: 'First panel', value: '24', actions: [], states: [] };
function observe(elements: Element[] = [field]): DesktopObservation {
  return { id: 'o1', capturedAt: 1, context: { app: 'Example', windowId: 'w1' }, applications: [], windows: [], notices: [],
    snapshots: [{ id: 's1', app: 'Example', windowId: 'w1', windowTitle: 'New title', elements, capturedAt: 1, complete: true }] };
}
describe('Observed target identity', () => {
  it('uses native IDs to distinguish equal labels across title and control-name changes', () => {
    const o = observe([{ ...field, name: 'Renamed' }, { ...field, ref: '@s1:e2', nativeId: 'second', value: '12' }]);
    expect(checkOutcomes(o, [{ kind: 'text_equals', target, value: '24' }], [], true).message).toBeUndefined();
    expect(sameBoundIdentity(target, { ...target, name: 'Renamed', windowTitle: 'New title' })).toBe(true);
  });
  it('never falls back to a matching label when the bound window or native ID is absent', () => {
    expect(matchingTargets(observe(), { ...target, windowId: 'other' })).toEqual([]);
    expect(matchingTargets(observe(), { ...target, nativeId: 'gone' })).toEqual([]);
    expect(matchingTargets(observe(), { ...target, nativeIdKind: 'different-kind' })).toEqual([]);
  });
  it('uses observed paths for reused IDs and rejects unresolved ambiguity', () => {
    const o = observe([field, { ...field, ref: '@s1:e2', path: 'Second panel', value: '12' }]);
    expect(matchingTargets(o, target)).toHaveLength(1);
    expect(checkOutcomes(o, [{ kind: 'text_equals', target: { ...target, path: undefined }, value: '24' }], [], true).message).toContain('ambiguous');
    expect(matchingTargets(o, { ...target, path: 'Unobserved panel' })).toEqual([]);
  });
  it('uses path and label when an adapter supplies no native ID', () => {
    const o = observe([field, { ...field, ref: '@s1:e2', path: 'Second panel', value: '12' }]);
    expect(matchingTargets(o, { ...target, nativeId: undefined, path: 'Second panel' })[0].element.value).toBe('12');
  });
  it('binds a renamed window by ID and measures advancement across renamed labels', () => {
    expect(matchingTargets(observe(), { ...target, role: 'window', nativeId: undefined }, true)).toHaveLength(1);
    const check = { kind: 'value_advances' as const, target, value: '' };
    const first = checkOutcomes(observe(), [check], [], false);
    expect(checkOutcomes(observe([{ ...field, name: 'Renamed', value: '25' }]), [check], first.measurements, true).message).toBeUndefined();
  });
  it('carries exact observed IDs through the request contract', () => {
    const request = decisionPage(observe(), [], TaskInputSchema.parse({ provider: 'jev', goal: 'Read the value' }),
      '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe', 1, 0, new Set([0]), []);
    const parsed = DesktopDecisionRequestSchema.parse(request);
    expect(parsed.observedTargets?.find(t => t.role === 'textfield')).toMatchObject({
      windowId: 'w1', nativeId: 'first', nativeIdKind: 'identifier', path: 'First panel',
    });
  });
  it('omits an oversized identity from the target catalog instead of silently truncating it', () => {
    const request = decisionPage(observe([{ ...field, nativeId: 'x'.repeat(2001) }]), [],
      TaskInputSchema.parse({ provider: 'jev', goal: 'Read the value' }),
      '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe', 1, 0, new Set([0]), []);
    expect(() => DesktopDecisionRequestSchema.parse(request)).not.toThrow();
    expect(request.observedTargets?.some(t => t.role === 'textfield')).toBe(false);
  });
});
