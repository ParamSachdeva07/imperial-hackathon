import { describe, expect, it } from 'vitest';
import { gate, percentile, summarize, wilson, type TrialResult } from '../scripts/eval/metrics';

const trial = (over: Partial<TrialResult>): TrialResult => ({ task: 'new-tab', family: 'browser', arm: 'current', startState: 'app-focused',
  trial: 1, status: 'completed', oraclePass: true, oracleDetail: '', duplicateAttempt: false, irreversible: false, elapsedMs: 9000,
  steps: 4, modelCalls: { '/navigation/decide': 4, '/navigation/supervise': 3 }, modelMs: 4800, ...over });

describe('evaluation metrics', () => {
  it('keeps small samples honest', () => {
    const [low, high] = wilson(10, 10);
    expect(low).toBeGreaterThan(0.69);
    expect(low).toBeLessThan(0.73);
    expect(high).toBe(1);
    expect(wilson(0, 0)).toEqual([0, 1]);
    expect(percentile([5, 1, 9, 3], 50)).toBe(3);
    expect(percentile([5, 1, 9, 3], 90)).toBe(9);
  });
  it('counts success by the oracle and false completion by disagreement with it', () => {
    const [summary] = summarize([trial({}), trial({ oraclePass: false }), trial({ status: 'completed_unverified', oraclePass: false }),
      trial({ status: 'blocked', oraclePass: false, guard: 'duplicate', duplicateAttempt: true })]);
    expect(summary).toMatchObject({ n: 4, success: 1, falseCompletion: 1, duplicateAttempts: 1, guardStops: 1,
      statuses: { completed: 2, completed_unverified: 1, blocked: 1 }, modelCallsMean: 7 });
    expect(summary.nativeAndOtherMsP50).toBe(4200);
  });
  it('applies the gates per task against the baseline arm', () => {
    const results = [trial({}), trial({ oraclePass: false }),
      trial({ arm: 'a', elapsedMs: 6000 }), trial({ arm: 'a', elapsedMs: 6000 })];
    expect(gate(summarize(results), 'current', 'a', { minTrials: 2 })).toEqual({ pass: true, reasons: [] });
    // Too few trials, a task the candidate never ran, and matching a baseline that never succeeds all fail.
    expect(gate(summarize(results), 'current', 'a').reasons.join(' ')).toContain('fewer than the 10 needed');
    const uncovered = [...results, trial({ task: 'word' })];
    expect(gate(summarize(uncovered), 'current', 'a', { minTrials: 2 }).reasons.join(' ')).toContain('word: arm a has no results');
    const bothFail = [trial({ oraclePass: false }), trial({ oraclePass: false }), trial({ arm: 'a', oraclePass: false, status: 'blocked' }), trial({ arm: 'a', oraclePass: false, status: 'blocked' })];
    expect(gate(summarize(bothFail), 'current', 'a', { minTrials: 2 }).reasons.join(' ')).toContain('below the floor');
    const worse = [...results, trial({ arm: 'a', oraclePass: false, elapsedMs: 20000 }), trial({ arm: 'a', oraclePass: false, elapsedMs: 20000 }),
      trial({ arm: 'a', oraclePass: false, duplicateAttempt: true, irreversible: true, elapsedMs: 20000 })];
    const verdict = gate(summarize(worse), 'current', 'a', { minTrials: 2 });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/duplicate irreversible.*false completion.*slower/s);
    expect(gate(summarize(results), 'current', 'b').pass).toBe(false);
  });
});
