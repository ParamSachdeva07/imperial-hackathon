import type {
  Candidate,
  Element,
  PreparedDocument,
  Snapshot,
} from '../../../../packages/contracts/src/index';
import { documentEditor, type DesktopBridge } from './types';
import { NativeClient, NativeError } from './native-client';
import { flattenTree } from './accessibility-tree';

type WindowInfo = { id: string; title: string };
export class NativeDesktopBridge extends NativeClient implements DesktopBridge {
  private async windows(signal?: AbortSignal): Promise<WindowInfo[]> {
    const value = await this.run(['list-windows', '--app', 'TextEdit'], undefined, signal);
    if (!Array.isArray(value)) throw new NativeError('INVALID_OUTPUT', 'Expected a window list.');
    return value;
  }

  private async read(windowId?: string, surface?: string, signal?: AbortSignal): Promise<any> {
    const args = [
      'snapshot',
      '--app',
      'TextEdit',
      '--include-bounds',
      '--max-depth',
      '12',
      '--timeout-ms',
      '5000',
    ];
    if (windowId) args.push('--window-id', windowId);
    if (surface) args.push('--surface', surface);
    return this.run(args, undefined, signal);
  }

  async prepare(signal?: AbortSignal): Promise<PreparedDocument> {
    signal?.throwIfAborted();
    const health = await this.health();
    if (!health.available) throw new Error(health.message);
    if (health.accessibility !== 'granted')
      throw new NativeError(
        'PERM_DENIED',
        'Grant Accessibility access to the app that launches this helper, then retry.',
      );
    if (process.platform !== 'darwin')
      throw new Error('The macOS adapter is implemented first. Add a Windows adapter behind DesktopBridge.');

    await this.run(['launch', 'com.apple.TextEdit', '--activate'], undefined, signal);
    const existing = await this.windows(signal);
    const before = new Set(existing.map((w) => w.id));
    // This isolated TextEdit regression fixture creates a document with its
    // application shortcut; a menu item's existence does not make it visible.
    // Dispatch once and establish creation from the fresh window/editor below.
    signal?.throwIfAborted();
    await this.run(['press', 'cmd+n', '--app', 'TextEdit']);

    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const fresh = (await this.windows(signal)).filter((w) => !before.has(w.id));
      for (const window of fresh) {
        const document: PreparedDocument = {
          app: 'TextEdit',
          windowId: window.id,
          windowTitle: window.title,
          createdAt: Date.now(),
        };
        const snapshot = await this.snapshot(document, signal);
        const editor = documentEditor(snapshot);
        if (editor && editor.value === '') return document;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        }, 150);
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('Cancelled', 'AbortError'));
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error(
      'A fresh, empty TextEdit document was not observed. Existing documents were not modified.',
    );
  }

  async snapshot(document: PreparedDocument, signal?: AbortSignal): Promise<Snapshot> {
    const data = await this.read(document.windowId, undefined, signal);
    if (data.complete !== true)
      throw new Error('Accessibility snapshot is incomplete; no action will be selected.');
    if (data.window?.id !== document.windowId) throw new Error('TextEdit window identity changed.');
    return {
      id: data.snapshot_id,
      app: data.app,
      windowId: data.window.id,
      windowTitle: data.window.title ?? document.windowTitle,
      complete: true,
      capturedAt: Date.now(),
      elements: flattenTree(data.tree),
    };
  }

  async execute(
    candidate: Candidate,
    text: string,
    expected: Element,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (candidate.targetRef !== expected.ref) throw new Error('Target reference mismatch.');
    // Re-read the same native reference immediately before dispatch. Never overwrite a user's intervening edit.
    const current = await this.run(['get', expected.ref, '--property', 'value'], undefined, signal);
    signal?.throwIfAborted();
    const value = typeof current === 'string' ? current : String(current?.value ?? current?.text ?? '');
    if (value !== expected.value)
      throw new Error('Document changed after observation. Stopped before writing.');
    switch (candidate.operation) {
      case 'SET_VALUE':
        if (!expected.actions.includes('SetValue')) throw new Error('Target does not support SetValue.');
        return this.run(['set-value', candidate.targetRef, '--stdin'], text);
      case 'FOCUS':
        if (!expected.actions.includes('SetFocus')) throw new Error('Target does not support focus.');
        return this.run(['focus', candidate.targetRef]);
      case 'CLICK':
        if (!expected.actions.includes('Click')) throw new Error('Target does not support click.');
        return this.run(['click', candidate.targetRef]);
    }
  }
}
