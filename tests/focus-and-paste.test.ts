import { describe, expect, it, vi } from 'vitest';
import { canFocusAndPaste, focusAndPaste } from '../apps/desktop/electron/desktop/focus-and-paste';
import {
  type DesktopCandidate,
  type DesktopObservation,
  type Element,
} from '../packages/contracts/src/index';
import { NativeError } from '../apps/desktop/electron/desktop/native-client';
import { flattenTree, accessibilityTree } from '../apps/desktop/electron/desktop/accessibility-tree';

const target: Element = {
  ref: '@s1:e1',
  role: 'textfield',
  name: 'Editor',
  value: '',
  bounds: { x: 10, y: 20, width: 300, height: 200 },
  states: ['disabled', 'focused'],
  actions: ['SetValue', 'SetFocus'],
};
const candidate: DesktopCandidate = {
  id: 'paste',
  operation: 'FOCUS_AND_PASTE',
  app: 'Example',
  windowId: 'w-1',
  snapshotId: 's1',
  targetRef: target.ref,
  name: 'Editor',
  description: 'Replace full text',
};
function fixture(value = '', states = target.states, focused = true) {
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'list-windows') return [{ id: 'w-1', pid: 123, is_focused: focused }];
    if (args[0] === 'get') return { value: args[3] === 'states' ? states : value };
    return {};
  });
  const paste = vi.fn(async () => ({
    delivery: 'delivered_verified',
    verification: 'verified' as const,
    observedValue: 'Hello café 😊',
    clipboard: 'restored',
  }));
  const execute = (
    element = target,
    text: string | undefined = 'Hello café 😊',
    signal = new AbortController().signal,
  ) => focusAndPaste(run, paste, candidate, element, text, signal);
  return { run, paste, execute };
}
describe('Focus and paste', () => {
  it('allows a focused editor despite a disabled AX flag and dispatches once', async () => {
    const f = fixture();
    expect((await f.execute()).verification).toBe('verified');
    expect(f.paste).toHaveBeenCalledExactlyOnceWith({
      pid: 123,
      windowId: 1,
      role: 'textfield',
      bounds: target.bounds,
      nativeId: undefined,
      nativeIdKind: undefined,
      before: '',
      text: 'Hello café 😊',
    });
    expect(f.run.mock.calls.some(([args]) => args[0] === 'focus')).toBe(false);
  });
  it('focuses an enabled editor before invoking the guarded native transaction', async () => {
    const f = fixture('', []);
    await f.execute({ ...target, states: [] });
    expect(f.run.mock.calls.at(-1)).toEqual([['focus', target.ref]]);
    expect(f.paste).toHaveBeenCalledOnce();
  });
  it('returns already satisfied without touching focus or clipboard', async () => {
    const f = fixture('Hello café 😊');
    expect((await f.execute({ ...target, value: 'Hello café 😊' })).verification).toBe('already_satisfied');
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('does not replay a paste whose delivery is uncertain', async () => {
    const f = fixture();
    f.paste.mockRejectedValue(new NativeError('UNVERIFIED_ACTION', 'Input was not repeated'));
    await expect(f.execute()).rejects.toThrow('not repeated');
    expect(f.paste).toHaveBeenCalledOnce();
  });
  it('stops before overwriting an intervening user edit', async () => {
    const f = fixture('User change');
    await expect(f.execute()).rejects.toThrow('changed');
    expect(f.paste).not.toHaveBeenCalled();
  });
  it('stops if the window or the disabled editor loses focus', async () => {
    for (const f of [fixture('', target.states, false), fixture('', ['disabled'])]) {
      await expect(f.execute()).rejects.toMatchObject({
        code: 'PASTE_PRECONDITION', disposition: { delivery: 'not_delivered', retry: 'inspect' },
        details: { pasteAttempted: false },
      });
      expect(f.paste).not.toHaveBeenCalled();
    }
  });
  it('stops cancellation before dispatch', async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(f.execute(target, 'hello', abort.signal)).rejects.toThrow();
    expect(f.paste).not.toHaveBeenCalled();
  });
  it.each(['readonly', 'hidden', 'offscreen', 'secure', 'protected'])('rejects %s editors', (state) => {
    expect(canFocusAndPaste({ ...target, states: [...target.states, state] })).toBe(false);
  });
  it('rejects containers, missing bounds, and disabled unfocused editors', () => {
    expect(canFocusAndPaste({ ...target, role: 'group' })).toBe(false);
    expect(canFocusAndPaste({ ...target, bounds: undefined })).toBe(false);
    expect(canFocusAndPaste({ ...target, states: ['disabled'] })).toBe(false);
  });
});


describe('Native identifier namespaces', () => {
  it('preserves the identifier kind through flat and hierarchical observations and paste dispatch', async () => {
    const node = { ref_id: target.ref, role: target.role, value: '', bounds: target.bounds,
      states: target.states, native_id: { kind: 'ax_dom_identifier', value: 'view_1012' } };
    const flat = flattenTree(node)[0];
    expect(accessibilityTree(node).nativeIdKind).toBe('ax_dom_identifier');
    const f = fixture();
    await f.execute(flat);
    expect(f.paste).toHaveBeenCalledWith(expect.objectContaining({ nativeId: 'view_1012', nativeIdKind: 'ax_dom_identifier' }));
  });
});
