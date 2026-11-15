import type { Element, AccessibilityNode } from '../../../../packages/contracts/src/index';

// Unaddressable wrappers belong to their nearest addressable ancestor.
export function unreadChildren(node: any): number {
  return (typeof node?.children_count === 'number' ? node.children_count : 0) +
    (node?.children || []).filter((child: any) => !child.ref_id)
      .reduce((count: number, child: any) => count + unreadChildren(child), 0);
}

export function needsDeeperRead(tree: any): boolean {
  const visit = (node: any, anchor?: string): boolean => {
    const nearest = node?.ref_id || anchor;
    if (node?.children_count > 0 && (!nearest || nearest === tree.ref_id)) return true;
    return (node?.children || []).some((child: any) => visit(child, nearest));
  };
  return visit(tree);
}

export function flattenTree(node: any, ancestry: string[] = []): Element[] {
  if (!node || typeof node !== 'object') return [];
  const elements: Element[] = [];
  if (typeof node.ref_id === 'string')
    elements.push({
      ref: node.ref_id,
      role: String(node.role ?? ''),
      name: String(node.name ?? ''),
      value: typeof node.value === 'string' ? node.value : node.value == null ? '' : String(node.value),
      nativeId: node.native_id?.value,
      nativeIdKind: node.native_id?.kind,
      actions: Array.isArray(node.available_actions) ? node.available_actions : [],
      states: Array.isArray(node.states) ? node.states : [],
      bounds: node.bounds,
      description: String(node.description ?? ''),
      path: ancestry.join(' > '),
      childrenCount: unreadChildren(node) || undefined,
    });
  for (const child of node.children ?? [])
    elements.push(...flattenTree(child, [...ancestry, String(node.name || node.role || '')].slice(-5)));
  return elements;
}
export function treeText(node: any, parent = ''): string[] {
  if (!node || typeof node !== 'object') return [];
  const label = [
    node.role,
    node.name,
    node.description,
    node.value == null ? '' : String(node.value),
    (node.states || []).join(','),
  ]
    .filter(Boolean)
    .join(' | ');
  const result = label ? [(parent ? parent + ' > ' : '') + label] : [];
  for (const child of node.children || [])
    result.push(...treeText(child, String(node.name || node.role || '').slice(0, 100)));
  return result;
}
export function accessibilityTree(node: any, id = 'n0'): AccessibilityNode {
  return {
    id,
    ref: node.ref_id,
    role: String(node.role || 'group'),
    name: String(node.name || ''),
    value: node.value == null ? '' : String(node.value),
    description: String(node.description || ''),
    nativeId: node.native_id?.value,
    nativeIdKind: node.native_id?.kind,
    actions: Array.isArray(node.available_actions) ? node.available_actions : [],
    states: Array.isArray(node.states) ? node.states : [],
    bounds: node.bounds,
    childrenCount: (node.ref_id ? unreadChildren(node) : node.children_count) || undefined,
    children: (node.children || []).map((child: any, index: number) =>
      accessibilityTree(child, id + '_' + index),
    ),
  };
}
