import { describe, expect, it } from 'vitest';
import { accessibilityTree, flattenTree } from '../apps/desktop/electron/desktop/accessibility-tree';
import { checkOutcomes } from '../apps/desktop/electron/controller/outcome-checks';
import { actionResult } from '../apps/desktop/electron/controller/action-result';
import type { DesktopObservation, OutcomeCheck } from '../packages/contracts/src/index';

function observation(raw: any, title = 'Workspace'): DesktopObservation {
  return { id: 'o1', capturedAt: 1, applications: [], windows: [], notices: [],
    context: { app: 'Example', windowId: 'w1', surface: 'window' },
    snapshots: [{ id: 's1', app: 'Example', windowId: 'w1', windowTitle: title,
      complete: true, capturedAt: 1, tree: accessibilityTree(raw), elements: flattenTree(raw) }] };
}
const check = (kind: OutcomeCheck['kind'], role: string, name: string, value = ''): OutcomeCheck =>
  ({ kind, target: { app: 'Example', windowTitle: 'Workspace', role, name }, value });
describe('Observable facts versus executable controls', () => {
  it('preserves child-count changes in anonymous unread containers', () => {
    const before = observation({ role: 'list', children_count: 2 });
    const after = observation({ role: 'list', children_count: 3 });
    const result = actionResult({ id: 'create', operation: 'CLICK', app: 'Example', name: 'Create', description: '' }, before, after);
    expect(result.added.join()).toContain('"unreadChildren":3');
    expect(result.removed.join()).toContain('"unreadChildren":2');
  });
  it('verifies a label without requiring a native action reference', () => {
    const o = observation({ role: 'heading', name: 'Created object' });
    expect(o.snapshots[0].elements).toHaveLength(0);
    expect(checkOutcomes(o, [check('target_present', 'heading', 'Created object')], [], false).message).toBeUndefined();
  });
  it('allows multiple presence matches but refuses ambiguous value checks', () => {
    const o = observation({ role: 'group', children: [1, 2].map(() => ({ role: 'textfield', name: 'Name', value: 'Hello' })) });
    expect(checkOutcomes(o, [check('target_present', 'textfield', 'Name')], [], false).message).toBeUndefined();
    expect(checkOutcomes(o, [check('text_equals', 'textfield', 'Name', 'Hello')], [], false).message).toContain('ambiguous');
  });
  it('supports a window-title target without inventing a control reference', () => {
    const o = observation({ role: 'group' });
    expect(checkOutcomes(o, [check('target_present', '', '')], [], false).message).toBeUndefined();
  });
  it('does not verify invisible labels', () => {
    const o = observation({ role: 'heading', name: 'Hidden', states: ['hidden'] });
    expect(checkOutcomes(o, [check('target_present', 'heading', 'Hidden')], [], false).message).toBeDefined();
  });
  it('does not treat descendants of a hidden container as visible evidence', () => {
    const o = observation({ role: 'group', states: ['hidden'], children: [{ role: 'heading', name: 'Hidden' }] });
    expect(checkOutcomes(o, [check('target_present', 'heading', 'Hidden')], [], false).message).toBeDefined();
  });
  it('retains window transitions, ignores snapshot refs and focus noise, and labels scope changes', () => {
    const before = observation({ role: 'textfield', name: 'Search', ref_id: '@s1:e1', states: ['focused'] });
    const after = observation({ role: 'textfield', name: 'Search', ref_id: '@s2:e4' }, 'Created workspace');
    const candidate = { id: 'key', operation: 'PRESS' as const, app: 'Example', name: 'shortcut', description: '', key: 'cmd+n' };
    const result = actionResult(candidate, before, after);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.after.join()).toContain('Created workspace');
    after.context.scopePath = [{ ref: '@s2:e4', name: 'Search' }];
    expect(actionResult(candidate, before, after)).toMatchObject({ scopeChanged: true, added: [], removed: [] });
  });
});
