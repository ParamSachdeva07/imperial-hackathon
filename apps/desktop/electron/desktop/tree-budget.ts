/** Bound local native reads separately from the model's 255-action Choice limit. */
export const NATIVE_READ_NODE_BUDGET = 2048;
export const MAX_SCOPE_DEPTH = 12;

type Node = { children?: Node[]; children_count?: number; [key: string]: any };
export function completeLayers(tree: Node, budget = NATIVE_READ_NODE_BUDGET) {
  let frontier = [tree], count = 0, depth = -1, excluded = 0;
  while (frontier.length) {
    if (count + frontier.length > budget) { excluded = frontier.length; break; }
    count += frontier.length;
    depth++;
    frontier = frontier.flatMap(node => node.children || []);
  }
  const copy = (node: Node, level: number): Node => {
    if (level === depth && node.children?.length) {
      return { ...node, children: [], children_count: node.children.length };
    }
    return { ...node, children: (node.children || []).map(child => copy(child, level + 1)) };
  };
  return { tree: excluded ? copy(tree, 0) : tree, count, depth, excluded };
}
export function treeFrontier(tree: Node): { count: number; unread: number } {
  const pending = [tree];
  let count = 0, unread = 0;
  while (pending.length) {
    const node = pending.pop()!;
    count++;
    unread += node.children_count || 0;
    pending.push(...(node.children || []));
  }
  return { count, unread };
}

/** Expand locally before inference; never mix references from separate snapshots. */
export async function readBudgetedTree(
  read: (depth: number) => Promise<any>,
  limited: (error: unknown) => boolean,
  notices: string[],
) {
  let depth = 3, depthLimit = MAX_SCOPE_DEPTH, data;
  try { data = await read(depth); }
  catch (error) {
    if (!limited(error)) throw error;
    depthLimit = depth - 1;
    depth = 1;
    data = await read(depth);
    notices.push('The initial scope exceeded a native read limit. Retried one level without desktop input.');
  }
  if (data.complete !== true && depth !== 1) {
    depthLimit = depth - 1;
    depth = 1;
    data = await read(depth);
    notices.push('The initial scope was incomplete. Retried one level without desktop input.');
  }
  if (!data.tree || data.complete !== true) return data;
  // A fresh deeper read may expose extra dynamic siblings. Trim that same
  // snapshot to its last complete layer; never retain only part of a layer.
  for (;;) {
    const layers = completeLayers(data.tree);
    data = { ...data, tree: layers.tree };
    const frontier = treeFrontier(data.tree);
    if (layers.excluded || frontier.count + frontier.unread > NATIVE_READ_NODE_BUDGET ||
        !frontier.unread || depth === depthLimit) {
      notices.push(`Native read: ${layers.count} nodes across ${layers.depth + 1} complete loaded layers. Action choices are budgeted separately before inference. ` +
        (frontier.unread ? 'Boundary children are unread; select a boundary region to repeat from that node.' : 'No unread children in this scope.'));
      if (layers.depth === 0 && frontier.unread)
        notices.push('Observation limit: this root’s immediate layer exceeds the native read capacity. Its children are unknown; do not repeat this same scope or claim completion.');
      if (depth === depthLimit && frontier.unread)
        notices.push('Observation limit: the native depth safety limit was reached. Unread descendants are unknown, not absent.');
      return data;
    }
    let next;
    try { next = await read(++depth); }
    catch (error) {
      if (!limited(error)) throw error;
      notices.push('A deeper native read reached a limit. Keeping the last complete scope; unread children remain unknown.');
      return data;
    }
    if (!next.tree || next.complete !== true) {
      notices.push('A deeper native read was incomplete. Keeping the last complete scope; unread children remain unknown.');
      return data;
    }
    data = next;
  }
}
