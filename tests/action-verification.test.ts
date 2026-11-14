import { describe, expect, it } from 'vitest';
import { ActionVerifier, type NativeRunner } from '../apps/desktop/electron/desktop/action-verification';
import { NativeError } from '../apps/desktop/electron/desktop/native-client';
import { WriteHistory } from '../apps/desktop/electron/controller/write-history';
import type { DesktopCandidate, Element } from '../packages/contracts/src/index';

const target: Element = {
  ref: '@s1:e1',
  role: 'textfield',
  name: 'Destination',
  value: '',
  actions: ['SetValue', 'TypeText'],
  states: [],
};
const action: DesktopCandidate = {
  id: 'write',
  operation: 'SET_VALUE',
  app: 'Example',
  windowId: 'w1',
  name: 'Destination',
  description: 'Fill the destination',
  targetRef: target.ref,
};
const signal = () => new AbortController().signal;
function failedWrite(expected?: string) {
  return new NativeError(
    'ACTION_FAILED',
    'Native readback mismatch',
    { delivery: 'delivered_unverified', retry: 'unsafe' },
    { kind: 'post_action_verification', after_action: { details: { expected_value: expected } } },
  );
}
function fixture(reads: (string | Error)[], result: unknown = failedWrite('hello'), settleMs = 200) {
  const commands: string[] = [];
  const run: NativeRunner = async (args) => {
    commands.push(args[0]);
    if (args[0] === 'get') {
      const value = reads.length > 1 ? reads.shift()! : reads[0];
      if (value instanceof Error) throw value;
      return { value };
    }
    if (result instanceof Error) throw result;
    return result;
  };
  return { verifier: new ActionVerifier(run, settleMs), commands };
}
describe('Action reconciliation without replay', () => {
  it('returns an ambiguous press for fresh workspace reconciliation without replay', async () => {
    const failure = new NativeError(
      'ACTION_FAILED',
      'AXPress did not establish a verifiable effect; mutation outcome is uncertain',
      { delivery: 'delivered_unverified', retry: 'unsafe' },
      { after_action: { changed: false } },
    );
    const f = fixture([], failure);
    const result = await f.verifier.execute(
      { ...action, operation: 'CLICK' }, target, undefined, ['click'], signal(),
    );
    expect(result.report).toMatchObject({
      delivery: 'delivered_unverified', verification: 'unverified',
      nativeError: { code: 'ACTION_FAILED', message: failure.message, disposition: failure.disposition },
    });
    expect(result.result).toEqual({ changed: false });
    expect(f.commands).toEqual(['click']);
  });
  it('preserves an unknown delivery timeout as uncertainty, not success or another press', async () => {
    const f = fixture([], new NativeError('TIMEOUT', 'Delivery is unknown'));
    const result = await f.verifier.execute(
      { ...action, operation: 'CLICK' }, target, undefined, ['click'], signal(),
    );
    expect(result.report).toMatchObject({
      delivery: 'unknown', verification: 'unverified', nativeError: { code: 'TIMEOUT' },
    });
    expect(f.commands).toEqual(['click']);
  });
  it('does not reconcile an explicitly undelivered press', async () => {
    const failure = new NativeError('ACTION_FAILED', 'Target not actionable', {
      delivery: 'not_delivered', retry: 'safe',
    });
    const f = fixture([], failure);
    await expect(f.verifier.execute(
      { ...action, operation: 'CLICK' }, target, undefined, ['click'], signal(),
    )).rejects.toBe(failure);
    expect(f.commands).toEqual(['click']);
  });
  it('does not treat a contradictory error disposition as verified', async () => {
    const f = fixture([], new NativeError('ACTION_FAILED', 'No effect established', {
      delivery: 'delivered_verified', retry: 'unsafe',
    }));
    const result = await f.verifier.execute(
      { ...action, operation: 'CLICK' }, target, undefined, ['click'], signal(),
    );
    expect(result.report.verification).toBe('unverified');
    expect(f.commands).toEqual(['click']);
  });
  it('does not dispatch a press after cancellation', async () => {
    const f = fixture([], {});
    const abort = new AbortController();
    abort.abort();
    await expect(f.verifier.execute(
      { ...action, operation: 'CLICK' }, target, undefined, ['click'], abort.signal,
    )).rejects.toThrow();
    expect(f.commands).toEqual([]);
  });
  it('honors cancellation after an ambiguous press without replay', async () => {
    const abort = new AbortController();
    let calls = 0;
    const run: NativeRunner = async () => {
      calls++;
      abort.abort();
      throw new NativeError('ACTION_FAILED', 'Effect unknown', { delivery: 'delivered_unverified' });
    };
    await expect(new ActionVerifier(run).execute(
      { ...action, operation: 'CLICK' }, target, undefined, ['click'], abort.signal,
    )).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('recovers a delivered error only after exact fresh evidence, with one write', async () => {
    const f = fixture(['', 'hello']);
    const { report } = await f.verifier.execute(
      action,
      target,
      'hello',
      ['set-value', target.ref, '--stdin'],
      signal(),
    );
    expect(report.verification).toBe('reconciled');
    expect(report.nativeError?.code).toBe('ACTION_FAILED');
    expect(f.commands.filter((c) => c === 'set-value')).toHaveLength(1);
  });
  it('polls a delayed text update without sending the text twice', async () => {
    const f = fixture(['', '', 'hel', 'hello']);
    expect(
      (await f.verifier.execute(action, target, 'hello', ['set-value'], signal())).report.observedValue,
    ).toBe('hello');
    expect(f.commands.filter((c) => c === 'set-value')).toHaveLength(1);
  });
  it('does not turn a contradiction into success or a retry', async () => {
    const f = fixture(['', 'different'], failedWrite(), 0);
    await expect(f.verifier.execute(action, target, 'hello', ['set-value'], signal())).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      details: { reconciliation: { observedValue: 'different', replayed: false } },
    });
    expect(f.commands.filter((c) => c === 'set-value')).toHaveLength(1);
  });
  it('does not trust a success envelope when the field stayed unchanged', async () => {
    const f = fixture(['', ''], { disposition: { delivery: 'delivered_unverified' } }, 0);
    await expect(f.verifier.execute(action, target, 'hello', ['set-value'], signal())).rejects.toMatchObject({
      code: 'UNVERIFIED_ACTION',
    });
  });
  it('leaves an already satisfied field alone', async () => {
    const f = fixture(['hello']);
    const result = await f.verifier.execute(
      action,
      { ...target, value: 'hello' },
      'hello',
      ['set-value'],
      signal(),
    );
    expect(result.report.verification).toBe('already_satisfied');
    expect(f.commands).toEqual(['get']);
  });
  it('protects an intervening user edit', async () => {
    const f = fixture(['user edit']);
    await expect(f.verifier.execute(action, target, 'hello', ['set-value'], signal())).rejects.toThrow(
      'changed since observation',
    );
    expect(f.commands).toEqual(['get']);
  });
  it('uses the native insertion postcondition rather than guessing append position', async () => {
    const f = fixture(['ac', 'a🙂c'], failedWrite('a🙂c'));
    const result = await f.verifier.execute(
      { ...action, operation: 'TYPE' },
      { ...target, value: 'ac' },
      '🙂',
      ['type'],
      signal(),
    );
    expect(result.report.expectedValue).toBe('a🙂c');
    expect(f.commands.filter((c) => c === 'type')).toHaveLength(1);
  });
  it('stops when the insertion position is unknown', async () => {
    const f = fixture(['existing'], failedWrite());
    await expect(
      f.verifier.execute(
        { ...action, operation: 'TYPE' },
        { ...target, value: 'existing' },
        'hello',
        ['type'],
        signal(),
      ),
    ).rejects.toThrow('Native readback mismatch');
    expect(f.commands.filter((c) => c === 'type')).toHaveLength(1);
  });
  it('never reconciles a known pre-delivery permission rejection', async () => {
    const f = fixture(
      [''],
      new NativeError('PERM_DENIED', 'Denied', { delivery: 'not_delivered', retry: 'safe' }),
    );
    await expect(f.verifier.execute(action, target, 'hello', ['set-value'], signal())).rejects.toThrow(
      'Denied',
    );
    expect(f.commands).toEqual(['get', 'set-value']);
  });
  it('does not use a replacement element to verify an old write', async () => {
    const f = fixture(['', new NativeError('STALE_REF', 'Gone')]);
    await expect(f.verifier.execute(action, target, 'hello', ['set-value'], signal())).rejects.toMatchObject({
      details: { reconciliation: { outcome: 'unverified', replayed: false } },
    });
    expect(f.commands.filter((c) => c === 'set-value')).toHaveLength(1);
  });
  it('stops polling on cancellation without replaying delivered input', async () => {
    const abort = new AbortController();
    let writes = 0;
    const run: NativeRunner = async (args) => {
      if (args[0] === 'get') return { value: '' };
      writes++;
      abort.abort();
      throw failedWrite();
    };
    await expect(
      new ActionVerifier(run).execute(action, target, 'hello', ['set-value'], abort.signal),
    ).rejects.toThrow();
    expect(writes).toBe(1);
  });
  it('reconciles observed state changes as well as text', async () => {
    let calls = 0;
    const run: NativeRunner = async (args) => {
      if (args[0] === 'get') return { value: ['checked'] };
      calls++;
      throw failedWrite();
    };
    const result = await new ActionVerifier(run).execute(
      { ...action, operation: 'CHECK' },
      target,
      undefined,
      ['check'],
      signal(),
    );
    expect(result.report.verification).toBe('reconciled');
    expect(calls).toBe(1);
  });
});
describe('Write history', () => {
  it('suppresses a verified insertion only while the same target still has the verified value', () => {
    const history = new WriteHistory();
    const candidate = { ...action, operation: 'TYPE' as const };
    history.record(0, candidate, target, 'hello', 'hello');
    expect(history.alreadyApplied(0, candidate, { ...target, ref: '@s2:e8', value: 'hello' }, 'hello')).toBe(
      true,
    );
    expect(
      history.alreadyApplied(
        0,
        { ...candidate, operation: 'SET_VALUE' },
        { ...target, value: '\ufffc', path: 'new root' },
        'hello',
      ),
    ).toBe(false);
    expect(history.alreadyApplied(1, candidate, { ...target, value: 'hello' }, 'hello')).toBe(false);
    expect(history.alreadyApplied(0, candidate, { ...target, value: '' }, 'hello')).toBe(false);
    expect(history.alreadyApplied(0, candidate, { ...target, value: 'a later edit' }, 'hello')).toBe(false);
    expect(
      history.alreadyApplied(
        0,
        { ...candidate, windowId: 'different' },
        { ...target, value: 'hello' },
        'hello',
      ),
    ).toBe(false);
  });
});
