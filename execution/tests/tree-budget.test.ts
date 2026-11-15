import { describe, expect, it } from 'vitest';
import { completeLayers, readBudgetedTree, treeFrontier } from '../apps/desktop/electron/desktop/tree-budget';
const leaves = (count: number) => Array.from({ length: count }, (_, i) => ({ role: 'button', ref_id: '@s:e' + i }));
describe('Complete-layer node budget', () => {
  it('includes exactly 255 nodes but excludes the entire next layer, retaining boundary counts', () => {
    const tree = { role: 'window', children: leaves(254).map(n => ({ ...n, children: leaves(2) })) };
    const result = completeLayers(tree, 255);
    expect(result.count).toBe(255);
    expect(result.depth).toBe(1);
    expect(result.excluded).toBe(508);
    expect(result.tree.children!.every(n => !n.children?.length && n.children_count === 2)).toBe(true);
    expect(tree.children[0].children.length).toBe(2);
  });
  it('does not take a partial layer or favor an earlier sibling', () => {
    const result = completeLayers({ children: [{ children: leaves(126) }, { children: leaves(127) }] }, 255);
    expect(result.count).toBe(3);
    expect(result.tree.children!.map(n => n.children_count)).toEqual([126, 127]);
  });
  it('repeats the same budget after selecting a boundary node', () => {
    const child = { children: leaves(100) };
    const outer = completeLayers({ children: [child, child, child] }, 255);
    expect(outer.count).toBe(4);
    expect(completeLayers(child, 255).count).toBe(101);
  });
  it('leaves an overwide immediate layer unread', () => {
    const result = completeLayers({ children: leaves(255) }, 255);
    expect(result.count).toBe(1);
    expect(result.tree.children_count).toBe(255);
  });
  it('expands locally until the next complete layer would exceed the budget', async () => {
    const calls: number[] = [];
    const data = await readBudgetedTree(async depth => {
      calls.push(depth);
      return { complete: true, snapshot_id: 's' + depth, tree: { children: depth === 3
        ? [{ ref_id: '@s3:region', children_count: 2 }]
        : [{ ref_id: '@s4:region', children: [{ children_count: 1100 }, { children_count: 1100 }] }] } };
    }, () => false, []);
    expect(calls).toEqual([3, 4]);
    expect(treeFrontier(data.tree)).toEqual({ count: 4, unread: 2200 });
    expect(data.tree.children[0].ref_id).toBe('@s4:region');
  });
  it('keeps the last complete snapshot on deeper failures, but propagates permission failures', async () => {
    const read = async (depth: number) => {
      if (depth > 3) throw new Error('budget');
      return { complete: true, tree: { children_count: 2 } };
    };
    expect((await readBudgetedTree(read, () => true, [])).complete).toBe(true);
    await expect(readBudgetedTree(read, () => false, [])).rejects.toThrow('budget');
  });
});
