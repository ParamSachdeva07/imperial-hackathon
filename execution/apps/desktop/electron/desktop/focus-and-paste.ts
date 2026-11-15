import path from 'node:path';
import type { DesktopCandidate, Element } from '../../../../packages/contracts/src/index';
import { NativeClient, NativeError } from './native-client';
import { readValue, type ActionReport, type NativeRunner } from './action-verification';

const textRoles = new Set(['textfield', 'textarea', 'combobox']);

export function canFocusAndPaste(element: Element): boolean {
  return (
    textRoles.has(element.role) &&
    !!element.bounds &&
    element.bounds.width > 0 &&
    element.bounds.height > 0 &&
    !element.states.some((state) =>
      ['hidden', 'offscreen', 'readonly', 'protected', 'secure'].includes(state),
    ) &&
    (element.states.includes('focused') ||
      (!element.states.includes('disabled') && element.actions.includes('SetFocus')))
  );
}

type PasteRequest = {
  pid: number;
  windowId: number;
  role: string;
  bounds: NonNullable<Element['bounds']>;
  nativeId?: string;
  nativeIdKind?: string;
  before: string;
  text: string;
};
type PasteResult = Pick<ActionReport, 'delivery' | 'verification' | 'observedValue'> & {
  clipboard: string;
  expectedValue?: string;
};
type PasteRunner = (request: PasteRequest) => Promise<PasteResult>;

function precondition(message: string): NativeError {
  return new NativeError('PASTE_PRECONDITION', message,
    { delivery: 'not_delivered', retry: 'inspect' }, { pasteAttempted: false });
}

class PasteClient extends NativeClient {
  execute(request: PasteRequest): Promise<PasteResult> {
    return this.run([], JSON.stringify(request));
  }
}

export function nativePasteRunner(binary: string, stateRoot: string): PasteRunner {
  const client = new PasteClient(path.join(path.dirname(binary), 'focus-and-paste'), stateRoot);
  return (request) => client.execute(request);
}

export async function focusAndPaste(
  run: NativeRunner,
  paste: PasteRunner,
  candidate: DesktopCandidate,
  target: Element,
  text: string | undefined,
  signal: AbortSignal,
): Promise<ActionReport> {
  if (!canFocusAndPaste(target))
    throw new Error('Paste needs a visible, readable text editor with verifiable focus.');
  if (text === undefined || Buffer.byteLength(text) > 131072 || text.includes('\0'))
    throw new Error('Paste needs exact text of at most 128 KiB without NUL characters.');
  const current = await readValue(run, target.ref, signal);
  if (current !== target.value)
    throw precondition('Text changed since observation. Refresh before replacing a user edit.');
  const report: ActionReport = {
    operation: candidate.operation,
    target: candidate.name,
    expectedValue: text,
    delivery: 'not_delivered',
    verification: 'already_satisfied',
    observedValue: current,
  };
  if (current === text) return report;
  const windows = await run(['list-windows', '--app', candidate.app], undefined, signal);
  const window = windows.find((item: any) => item.id === candidate.windowId && item.is_focused);
  if (!window?.pid || !/^w-\d+$/.test(candidate.windowId || ''))
    throw precondition('Paste target window lost focus or its process identity is unavailable.');
  const statesResult = await run(['get', target.ref, '--property', 'states'], undefined, signal);
  const states = Array.isArray(statesResult) ? statesResult : statesResult?.states || statesResult?.value;
  if (!Array.isArray(states)) throw precondition('Cannot verify editor focus.');
  if (!states.includes('focused')) {
    if (states.includes('disabled') || !target.actions.includes('SetFocus'))
      throw precondition('This editor must already have keyboard focus before pasting.');
    signal.throwIfAborted();
    await run(['focus', target.ref]);
  }
  signal.throwIfAborted();
  // The platform helper rechecks exact focus, identity, value and full selection,
  // owns the clipboard transaction, and dispatches Paste once without cancellation.
  const result = await paste({
    pid: window.pid,
    windowId: Number(candidate.windowId!.slice(2)),
    role: target.role,
    bounds: target.bounds!,
    nativeId: target.nativeId,
    nativeIdKind: target.nativeIdKind,
    before: current,
    text,
  });
  return { ...report, ...result };
}
