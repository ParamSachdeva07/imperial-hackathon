import { describe, expect, it } from 'vitest';
import { CompletionVerifier } from '../apps/desktop/electron/controller/completion-verifier';
import type { Decision, DesktopDecisionRequest, DesktopObservation } from '../packages/contracts/src/index';

const observation = {
  id: 'o1', capturedAt: 1000,
  context: { app: 'Example', windowId: 'w1' },
  snapshots: [{ app: 'Example', windowId: 'w1', complete: true }],
} as DesktopObservation;
const request = {
  goal: 'Fill the field',
  phase: { index: 0, count: 2 },
  tree: { view: 'tree' },
} as DesktopDecisionRequest;
const decision = {
  candidateId: 'DONE',
  confidence: 0.01,
  goalStatus: 'completed',
  goalConfidence: 0.01,
} as Decision;

describe('Completion verification', () => {
  it('requires two fresh assessments regardless of confidence', () => {
    const verifier = new CompletionVerifier();
    expect(verifier.assess(request, decision, observation).kind).toBe('refresh');
    expect(verifier.assess(request, decision, observation).kind).toBe('refresh');
    expect(verifier.assess(request, decision, { ...observation, id: 'o2', capturedAt: 2000 }).kind).toBe('confirmed');
  });
  it('stops when the goal assessment does not confirm completion', () => {
    const verifier = new CompletionVerifier();
    const final = { ...request, phase: { index: 1, count: 2 } };
    expect(verifier.assess(final, { ...decision, goalStatus: 'continue' }, observation).kind).toBe(
      'refresh',
    );
    expect(verifier.assess(final, { ...decision, goalStatus: 'continue' }, observation).kind).toBe(
      'refresh',
    );
    expect(verifier.assess(final, { ...decision, goalStatus: 'continue' }, observation).kind).toBe(
      'blocked',
    );
  });
  it('does not carry a verified completion through a desktop action or different window', () => {
    const verifier = new CompletionVerifier();
    verifier.assess(request, decision, observation);
    verifier.clear();
    expect(verifier.assess(request, decision, observation).kind).toBe('refresh');
    const another = { ...observation, context: { app: 'Example', windowId: 'w2' } };
    expect(verifier.assess(request, decision, another).kind).toBe('refresh');
  });
});
