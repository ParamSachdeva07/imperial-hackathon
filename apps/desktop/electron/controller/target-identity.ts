import type { DesktopObservation, OutcomeTarget, Snapshot } from '../../../../packages/contracts/src/index';
import { observedElements, type ObservedElement } from '../desktop/observation-facts';

export function matchesWindow(target: OutcomeTarget, snapshot: Snapshot): boolean {
  return (!target.app || snapshot.app === target.app) &&
    (target.windowId ? snapshot.windowId === target.windowId : !target.windowTitle || snapshot.windowTitle === target.windowTitle);
}

/** Prefer observed IDs; never fall back to a similar label when an ID disappears. */
export function matchingTargets(observation: DesktopObservation, target: OutcomeTarget, presence = false) {
  return observation.snapshots.filter(s => matchesWindow(target, s)).flatMap(snapshot => {
    if (presence && (target.role === 'window' || (!target.role && !target.name && (target.windowId || target.windowTitle))) &&
        (target.windowId || !target.name || target.name === snapshot.windowTitle || target.name === snapshot.tree?.name)) {
      const element: ObservedElement = { role: 'window', name: snapshot.windowTitle, value: '', actions: [], states: [] };
      return [{ snapshot, element }];
    }
    const matches = observedElements(snapshot).filter(e =>
      !e.states.some(s => ['hidden', 'offscreen'].includes(s)) && (!target.role || e.role === target.role) &&
      (target.nativeId
        ? e.nativeId === target.nativeId && (!target.nativeIdKind || e.nativeIdKind === target.nativeIdKind)
        : (!target.name || e.name === target.name) && (!target.path || e.path === target.path)));
    // Native IDs can be repeated by reusable controls. Use the observed ancestor
    // path to disambiguate, but allow a uniquely identified control to move.
    const resolved = target.nativeId && matches.length > 1 && target.path
      ? matches.filter(e => e.path === target.path) : matches;
    return resolved.map(element => ({ snapshot, element }));
  });
}

/** Only strong shared identity can establish that changed labels are the same target. */
export function sameBoundIdentity(a: OutcomeTarget, b: OutcomeTarget): boolean {
  return !!a.app && a.app === b.app && !!a.windowId && a.windowId === b.windowId && a.role === b.role &&
    (a.role === 'window' || (!!a.nativeId && a.nativeId === b.nativeId && a.nativeIdKind === b.nativeIdKind &&
      (!a.path || !b.path || a.path === b.path)));
}
