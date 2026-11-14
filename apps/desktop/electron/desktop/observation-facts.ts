import type { AccessibilityNode, Element, Snapshot } from '../../../../packages/contracts/src/index';

export type ObservedElement = Omit<Element, 'ref'> & { ref?: string };

/** Observability does not require a native action reference. Never fabricate refs. */
export function observedElements(snapshot: Snapshot): ObservedElement[] {
  if (!snapshot.tree) return snapshot.elements || [];
  const result: ObservedElement[] = [];
  const refs = new Set<string>();
  const visit = (node: AccessibilityNode, parents: string[], hidden = false) => {
    const { children, id: _id, ...element } = node;
    hidden ||= node.states.includes('hidden');
    result.push({ ...element, path: parents.join(' > '),
      states: hidden ? [...new Set([...element.states, 'hidden'])] : element.states });
    if (node.ref) refs.add(node.ref);
    for (const child of children) visit(child, [...parents, node.name || node.role], hidden);
  };
  visit(snapshot.tree, []);
  // Some adapters attach focused controls outside their tree projection.
  result.push(...(snapshot.elements || []).filter(e => !refs.has(e.ref)));
  return result;
}
