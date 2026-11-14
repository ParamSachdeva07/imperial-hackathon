import type {
  Candidate,
  Element,
  PreparedDocument,
  Snapshot,
} from '../../../../packages/contracts/src/index';
export interface DesktopBridge {
  prepare(signal?: AbortSignal): Promise<PreparedDocument>;
  snapshot(document: PreparedDocument, signal?: AbortSignal): Promise<Snapshot>;
  execute(
    candidate: Candidate,
    text: string,
    expected: Element,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  health(): Promise<{ available: boolean; version?: string; accessibility: string; message?: string }>;
}
export function documentEditor(snapshot: Snapshot): Element | undefined {
  const editors = snapshot.elements.filter(
    (e) =>
      e.nativeId === 'First Text View' &&
      ['textfield', 'textarea'].includes(e.role) &&
      !e.states.some((s) => ['disabled', 'hidden', 'offscreen', 'readonly'].includes(s)),
  );
  return editors.length === 1 ? editors[0] : undefined;
}
