import { describe, expect, it } from 'vitest';
import { TaskState } from '../apps/desktop/electron/controller/v2/task-state';
import { handoffEffects, sessionHandoff } from '../apps/desktop/electron/controller/v2/session-handoff';
import { OrchestratorRequestSchema } from '../packages/contracts/src/index';

function ledger() {
  const state = new TaskState('task', 'Create a document and enter text');
  state.declare([{ id: 'create', text: 'Create a new document', irreversible: false },
    { id: 'text', text: 'Enter the text', kind: 'text_entry', irreversible: false }]);
  return state;
}
const effect = (state: TaskState, step: number, delivery: 'delivered' | 'uncertain' = 'delivered') => {
  const e = state.propose({ step, requirementId: 'create', operation: 'CLICK', targetLabel: 'Create',
    args: {}, expect: 'New document', risk: 'reversible' });
  state.delivered(e, { delivery });
  return e;
};

describe('navigation session handoff', () => {
  it.each(['native', 'browser'])('preserves location, uncertainty and diagnostic context for %s', driver => {
    const state = ledger();
    effect(state, 1, 'uncertain');
    const result = sessionHandoff({ ledger: state.toJSON(), outcome: 'blocked', reason: 'Editor not found in current region',
      context: { app: 'Editor', windowId: 'document-2', driver: driver as 'native' | 'browser', surface: 'window' },
      issues: ['Read another scope; current tree is incomplete'], attemptedScopes: ['surface:focused'] });
    expect(result).toMatchObject({ app: 'Editor', windowId: 'document-2', completion: 'incomplete',
      remainingRequirements: ['create', 'text'], unresolvedEffects: ['fx1'], unresolvedEffectCount: 1,
      next: 'inspect_unresolved_effects', issues: ['Read another scope; current tree is incomplete'] });
    expect(OrchestratorRequestSchema.shape.handoff.parse(result)).toEqual(result);
  });

  it('cannot turn a successful-sounding summary into verified completion', () => {
    const result = sessionHandoff({ ledger: ledger().toJSON(), outcome: 'completed', reason: 'Everything is done!',
      context: {}, issues: [], attemptedScopes: [] });
    expect(result.completion).toBe('incomplete');
    expect(result.completedRequirements).toEqual([]);
  });

  it('distinguishes delivered but unverified work from unfinished work', () => {
    const state = ledger();
    state.requirements.forEach(r => { r.status = 'unverifiable'; });
    const result = sessionHandoff({ ledger: state.toJSON(), outcome: 'completed_unverified', reason: 'No readable output',
      context: {}, issues: ['Only the input field is visible'], attemptedScopes: ['surface:window'] });
    expect(result.completion).toBe('unverified');
    expect(result.next).toBe('inspect_or_report_unverified');
    expect(result.reason).toBe('No readable output');
  });

  it('retains old unresolved effects when recent history is compacted, and reports truncation honestly', () => {
    const state = ledger();
    effect(state, 1, 'uncertain');
    for (let i = 2; i <= 30; i++) {
      const e = effect(state, i);
      state.reconcile(e.id, 'confirmed', 'o', ['result']);
    }
    expect(handoffEffects(state.effects)).toHaveLength(16);
    expect(handoffEffects(state.effects)[0].id).toBe('fx1');
    for (let i = 31; i <= 50; i++) effect(state, i, 'uncertain');
    const result = sessionHandoff({ ledger: state.toJSON(), outcome: 'yielded', reason: '', context: {}, issues: [], attemptedScopes: [] });
    expect(result.unresolvedEffects).toHaveLength(16);
    expect(result.unresolvedEffectCount).toBe(21);
    expect(handoffEffects(state.effects).every(e => e.outcome === 'unknown')).toBe(true);
  });
});
