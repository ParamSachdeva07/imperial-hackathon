import { describe, expect, it } from 'vitest';
import { MilestonePlan } from '../apps/desktop/electron/controller/v2/milestone-plan';
import { TaskState } from '../apps/desktop/electron/controller/v2/task-state';
import type { NavigationMilestone, BranchDecision } from '../packages/contracts/src/index';

const milestones: NavigationMilestone[] = [
  { id: 'inspect', text: 'Check availability', doneWhen: 'The relevant results have been inspected',
    condition: '', dependsOn: [], kind: 'outcome', irreversible: false },
  { id: 'fallback', text: 'Open the general catalogue', doneWhen: 'The general catalogue is visible',
    condition: 'No matching result was found in the inspected results', dependsOn: ['inspect'], kind: 'outcome', irreversible: false },
];
const branch: BranchDecision = { milestoneId: 'fallback', disposition: 'run', sourceMilestoneIds: ['inspect'], reason: 'The inspected results show no matches.' };
function setup() {
  const plan = new MilestonePlan(), state = new TaskState('task', 'Check and use fallback if needed');
  plan.define(structuredClone(milestones)); state.declare(milestones);
  return { plan, state };
}

describe('orchestrator-owned milestone plan', () => {
  it('adds discovered work without rewriting or losing existing obligations', () => {
    const { plan } = setup();
    const added = { ...milestones[0], id: 'verify', text: 'Inspect a newly revealed result', dependsOn: ['inspect'] };
    expect(plan.define([added])).toBeUndefined();
    expect(plan.milestones).toEqual([...milestones, added]);
  });

  it('allows an honest unverified ending only after every planned obligation has a disposition', () => {
    const { plan, state } = setup();
    state.requirements[0].status = 'unverifiable';
    expect(plan.completeUnverified(state.requirements)).toBe(false);
    state.requirements[0].status = 'evidenced';
    state.requirements[0].evidence = [{ observationId: 'o1', row: 'No matching result' }];
    plan.decide([branch], state.requirements);
    state.requirements[1].status = 'unverifiable';
    expect(plan.completeUnverified(state.requirements)).toBe(true);
    expect(plan.complete(state.requirements)).toBe(false);
  });
  it('does not mistake a blocked search or an unverified mutation for absence', () => {
    const { plan, state } = setup();
    expect(plan.decide([branch], state.requirements)).toContain('not a negative finding');
    state.requirements[0].status = 'unverifiable';
    expect(plan.decide([branch], state.requirements)).toContain('not a negative finding');
    expect(plan.branches).toEqual([]);
    expect(plan.complete(state.requirements)).toBe(false);
    expect(plan.select('fallback', state.requirements)).toBe('Complete the prerequisite milestones first.');
  });

  it.each(['run', 'skip'] as const)('resolves a %s branch only from dependency evidence', disposition => {
    const { plan, state } = setup();
    state.setStatus('inspect', 'evidenced', 'o1', [{ row: 'e1', text: 'Results: no matches' }]);
    expect(plan.select('fallback', state.requirements)).toContain('Resolve this condition');
    expect(plan.decide([{ ...branch, disposition }], state.requirements)).toBeUndefined();
    expect(plan.complete(state.requirements)).toBe(disposition === 'skip');
    if (disposition === 'run') {
      expect(plan.select('fallback', state.requirements)).toEqual(milestones[1]);
      state.setStatus('fallback', 'evidenced', 'o2', [{ row: 'e2', text: 'General catalogue' }]);
      expect(plan.complete(state.requirements)).toBe(true);
    }
  });

  it('cannot erase obligations, skip unconditional work, or cite unrelated evidence', () => {
    const { plan, state } = setup();
    expect(plan.define([{ ...milestones[0], text: 'An easier task' }])).toContain('already defined');
    expect(plan.decide([{ ...branch, milestoneId: 'inspect', disposition: 'skip' }], state.requirements)).toContain('cannot be skipped');
    expect(plan.decide([{ ...branch, sourceMilestoneIds: ['unrelated'] }], state.requirements)).toContain('dependency evidence');
    expect(plan.milestones).toEqual(milestones);
  });

  it('accepts redundant run declarations without skipping prerequisites', () => {
    const { plan, state } = setup();
    expect(plan.decide([{ ...branch, milestoneId: 'inspect', disposition: 'run' }], state.requirements)).toBeUndefined();
    expect(plan.branches).toEqual([]);
    expect(plan.select('inspect', state.requirements)).toEqual(milestones[0]);
    expect(plan.select('fallback', state.requirements)).toBe('Complete the prerequisite milestones first.');
  });

  it('rejects cyclic or missing dependencies before accepting any plan', () => {
    const plan = new MilestonePlan();
    expect(plan.define([...milestones].reverse())).toContain('earlier milestones');
    expect(plan.milestones).toEqual([]);
  });
});
