import type { AccessibilityNode } from '../../../../packages/contracts/src/index';

/** A role alone does not make an alert or dialog blocking. Native sheets are
 * attached modal surfaces; other nodes must explicitly expose modal state.
 * Includes unaddressable wrappers, which need not have their own action refs. */
export function activeModal(root?: AccessibilityNode): AccessibilityNode | undefined {
  if (!root) return;
  const find = (node: AccessibilityNode): AccessibilityNode[] => {
    if (node.states.some(s => ['hidden', 'offscreen'].includes(s))) return [];
    const descendants = node.children.flatMap(find);
    if (descendants.length) return descendants;
    return node.role === 'sheet' || node.states.includes('modal')
      ? [node] : [];
  };
  const candidates = find(root);
  if (candidates.length === 1) return candidates[0];
  const hasFocus = (node: AccessibilityNode): boolean =>
    node.states.includes('focused') || node.children.some(hasFocus);
  const focused = candidates.filter(hasFocus);
  return focused.length === 1 ? focused[0] : undefined;
}
