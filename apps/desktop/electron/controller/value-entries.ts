import type { DesktopCandidate, DesktopObservation, OutcomeTarget } from '../../../../packages/contracts/src/index';
import type { ActionReport } from '../desktop/action-verification';
import { readOperations } from './action-result';
import { matchingTargets } from './target-identity';

type Entry = {
  target: OutcomeTarget;
  enteredValue: string;
  current?: { value: string; focused: boolean };
  visibility: 'observed' | 'not_in_scope' | 'ambiguous';
  interactions: { operation: string; target: string; key?: string; delivery: string }[];
};

/** Track evidence without assuming a particular key, blur or click commits a value. */
export class ValueEntries {
  private entries = new Map<string, Entry>();
  clear() { this.entries.clear(); }

  record(candidate: DesktopCandidate, before: DesktopObservation, report?: ActionReport) {
    if (readOperations.has(candidate.operation)) return;
    for (const entry of this.entries.values()) {
      if (entry.target.app !== candidate.app || entry.target.windowId !== candidate.windowId) continue;
      entry.interactions.push({ operation: candidate.operation, target: candidate.name.slice(0, 70),
        key: candidate.key, delivery: report?.delivery || 'dispatched' });
      entry.interactions = entry.interactions.slice(-3);
    }
    if (!['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE'].includes(candidate.operation) ||
        !report || report.observedValue === undefined ||
        !['verified', 'reconciled', 'already_satisfied'].includes(report.verification)) return;
    const snapshot = before.snapshots.find(s => s.id === candidate.snapshotId);
    const target = snapshot?.elements.find(e => e.ref === candidate.targetRef);
    if (!snapshot || !target) return;
    const identity: OutcomeTarget = { app: snapshot.app, windowId: snapshot.windowId,
      windowTitle: snapshot.windowTitle, role: target.role, name: target.name,
      nativeId: target.nativeId, nativeIdKind: target.nativeIdKind, path: target.path };
    const key = JSON.stringify([identity.app, identity.windowId, identity.role,
      identity.nativeId, identity.nativeIdKind, identity.path, identity.nativeId ? undefined : identity.name]);
    const previous = this.entries.get(key);
    if (report.verification === 'already_satisfied' && previous?.enteredValue === report.observedValue) return;
    this.entries.delete(key);
    this.entries.set(key, { target: identity, enteredValue: report.observedValue,
      visibility: 'not_in_scope', interactions: [] });
  }

  observe(observation: DesktopObservation) {
    for (const entry of this.entries.values()) {
      const matches = matchingTargets(observation, entry.target);
      entry.visibility = matches.length === 1 ? 'observed' : matches.length ? 'ambiguous' : 'not_in_scope';
      entry.current = matches.length === 1
        ? { value: matches[0].element.value, focused: matches[0].element.states.includes('focused') }
        : undefined;
    }
  }

  notices(): string[] {
    return [...this.entries.values()].slice(-4).map(entry => {
      const context = { field: entry.target.name.slice(0, 70), enteredValue: entry.enteredValue.slice(0, 150),
        visibility: entry.visibility, current: entry.current &&
          { ...entry.current, value: entry.current.value.slice(0, 150) }, interactions: entry.interactions };
      return ('Field-entry evidence (previews): ' + JSON.stringify(context)).slice(0, 720) +
        '. Entry and later interactions do not prove the requested effect. Inspect the result first; controls may apply immediately or require a commit. Missing here means unknown. Do not submit a prefill-only request.';
    });
  }
}
