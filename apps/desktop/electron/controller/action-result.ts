import type { ActionResult, DesktopCandidate, DesktopObservation } from '../../../../packages/contracts/src/index';
import type { ActionReport } from '../desktop/action-verification';
import { observedElements } from '../desktop/observation-facts';

export const readOperations = new Set(['BROWSE_TREE', 'BROWSE_APPS', 'READ_WINDOW', 'READ_SURFACE',
  'READ_BROWSER', 'INSPECT_REGION', 'SEARCH_APPS', 'WAIT']);

function location(o: DesktopObservation): string[] {
  return o.snapshots.map(s => JSON.stringify({ app: s.app, windowId: s.windowId, title: s.windowTitle,
    surface: s.surface || 'window', scope: o.context.scopePath?.map(p => p.name) || [] }));
}
function facts(o: DesktopObservation): string[] {
  return o.snapshots.flatMap(s => observedElements(s).filter(e =>
    !e.states.some(state => ['hidden', 'offscreen'].includes(state)) && (e.name || e.value || (e.childrenCount || 0) > 0)
  ).map(e => JSON.stringify({ role: e.role, name: e.name.slice(0, 250), value: e.value.slice(0, 400),
    states: e.states.filter(state => state !== 'focused').sort(),
    unreadChildren: e.childrenCount,
    // Anonymous lazy containers can carry the only exposed structural change
    // (e.g. another child). Preserve it without claiming the child was inspected.
    path: !e.name && e.childrenCount ? e.path : undefined })));
}
function difference(left: string[], right: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of right) counts.set(item, (counts.get(item) || 0) + 1);
  return left.filter(item => {
    const count = counts.get(item) || 0;
    if (!count) return true;
    counts.set(item, count - 1);
    return false;
  }).slice(0, 24);
}
/** Compare evidence, not ref IDs, geometry, or an unrelated tree-view fingerprint. */
export function actionResult(candidate: DesktopCandidate, before: DesktopObservation,
  after: DesktopObservation, text?: string, report?: ActionReport): ActionResult {
  const scope = (o: DesktopObservation) => JSON.stringify([o.context.windowId, o.context.surface || 'window',
    o.context.scopePath?.map(p => p.name) || []]);
  const scopeChanged = scope(before) !== scope(after);
  const beforeFacts = facts(before), afterFacts = facts(after);
  return {
    operation: candidate.operation, target: candidate.name || candidate.role || candidate.app,
    key: candidate.key, text,
    delivery: report?.delivery || 'dispatched', verification: report?.verification || 'unverified',
    before: location(before), after: location(after), scopeChanged,
    // Scope changes cannot prove objects appeared/disappeared.
    added: scopeChanged ? [] : difference(afterFacts, beforeFacts),
    removed: scopeChanged ? [] : difference(beforeFacts, afterFacts),
  };
}
