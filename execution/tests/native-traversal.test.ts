import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accessibilityTree,
  flattenTree,
  needsDeeperRead,
  unreadChildren,
} from '../apps/desktop/electron/desktop/accessibility-tree';
import { WorkspaceDesktopBridge } from '../apps/desktop/electron/desktop/workspace';
import { NATIVE_READ_NODE_BUDGET } from '../apps/desktop/electron/desktop/tree-budget';
import { NativeError } from '../apps/desktop/electron/desktop/native-client';
import type { DesktopContext } from '../packages/contracts/src/index';

type RawNode = {
  role: string;
  name?: string;
  ref_id?: string;
  children_count?: number;
  available_actions?: string[];
  children?: RawNode[];
};
type NativeSnapshot = { tree: RawNode; complete?: boolean };
const dirs: string[] = [];
const context: DesktopContext = { app: 'Example', windowId: 'w1', surface: 'window' };
const signal = () => new AbortController().signal;
const wrappedFrontier = (ref = '@s1:e1', width = 2): RawNode => ({
  role: 'banner',
  name: 'Header',
  ref_id: ref,
  children: [{ role: 'group', children: [{ role: 'group', children_count: width }] }],
});
const expandedHeader = (ref = '@s1:e1'): RawNode => ({
  role: 'banner',
  name: 'Header',
  ref_id: ref,
  children: [
    {
      role: 'group',
      children: [
        {
          role: 'group',
          children: [
            {
              role: 'combobox',
              name: 'Search',
              ref_id: '@s1:e2',
              available_actions: ['SetValue', 'SetFocus'],
            },
            { role: 'button', name: 'Submit search', ref_id: '@s1:e3', available_actions: ['Click'] },
          ],
        },
      ],
    },
  ],
});

class FixtureNative extends WorkspaceDesktopBridge {
  calls: string[][] = [];
  applications = async () => [{ name: 'Example', id: 'example', running: true }];
  constructor(private fixture: (depth: number, args: string[]) => NativeSnapshot) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'assistant-traversal-'));
    super('unused', dir);
    dirs.push(dir);
  }
  protected async run(args: string[]): Promise<any> {
    this.calls.push([...args]);
    if (args[0] === 'list-windows') return [{ id: 'w1', title: 'Example', is_focused: true }];
    if (args[0] !== 'snapshot') throw new Error('Unexpected mutation or whole-app scan: ' + args[0]);
    const result = this.fixture(Number(args[args.indexOf('--max-depth') + 1]), args);
    return {
      snapshot_id: 's1',
      complete: result.complete ?? true,
      window: { id: 'w1', title: 'Example' },
      ...result,
    };
  }
  depths() {
    return this.calls
      .filter((args) => args[0] === 'snapshot')
      .map((args) => Number(args[args.indexOf('--max-depth') + 1]));
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Addressable native traversal frontiers', () => {
  it('retains unread descendants through several unreferenced wrappers', () => {
    const tree = wrappedFrontier();
    expect(unreadChildren(tree)).toBe(2);
    expect(flattenTree(tree)).toMatchObject([{ ref: '@s1:e1', childrenCount: 2 }]);
    expect(accessibilityTree(tree).childrenCount).toBe(2);
  });

  it('assigns unread descendants to the nearest addressable ancestor only', () => {
    const tree: RawNode = {
      role: 'group',
      ref_id: '@s1:e1',
      children: [
        { role: 'group', children_count: 2 },
        {
          role: 'group',
          children: [{ role: 'group', ref_id: '@s1:e2', children: [{ role: 'group', children_count: 7 }] }],
        },
      ],
    };
    expect(flattenTree(tree).map((e) => [e.ref, e.childrenCount])).toEqual([
      ['@s1:e1', 2],
      ['@s1:e2', 7],
    ]);
    expect(accessibilityTree(tree).childrenCount).toBe(2);
  });


  it('reads deeper only where a frontier cannot be selected separately', () => {
    expect(needsDeeperRead(wrappedFrontier())).toBe(true);
    expect(needsDeeperRead({ role: 'window', children: [wrappedFrontier()] })).toBe(false);
    expect(needsDeeperRead({ role: 'window', children: [{ role: 'group', children_count: 4 }] })).toBe(true);
    expect(needsDeeperRead(expandedHeader())).toBe(false);
  });
});

describe('Bounded native region expansion', () => {


  it('caps reads even if wrappers never expose an addressable control', async () => {
    const bridge = new FixtureNative(() => ({ tree: wrappedFrontier() }));
    const observation = await bridge.observe({ ...context, rootRef: '@s1:e1' });
    expect(bridge.depths()).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(observation.snapshots[0].elements[0].childrenCount).toBe(2);
    expect(bridge.calls.every((args) => ['snapshot', 'list-windows'].includes(args[0]))).toBe(true);
    expect(observation.notices.some(n => n.startsWith('Observation limit:'))).toBe(true);
  });

  it.each(['oversized', 'incomplete', 'budget-error'] as const)(
    'does not adopt a failed larger read: %s',
    async (mode) => {
      const bridge = new FixtureNative((depth) => {
        if (depth === 3) return { tree: wrappedFrontier() };
        if (mode === 'budget-error')
          throw new NativeError('APP_UNRESPONSIVE', 'Accessibility node budget exceeded');
        if (mode === 'incomplete') return { tree: expandedHeader(), complete: false };
        return {
          tree: {
            role: 'banner',
            ref_id: '@s1:e1',
            children: Array.from({ length: NATIVE_READ_NODE_BUDGET + 1 }, (_, i) => ({
              role: 'button',
              name: 'Choice ' + i,
              ref_id: '@s1:e' + (i + 2),
            })),
          },
        };
      });
      const observation = await bridge.observe({ ...context, rootRef: '@s1:e1' });
      expect(bridge.depths()).toEqual([3, 4]);
      expect(observation.snapshots[0].elements).toHaveLength(1);
      expect(observation.snapshots[0].elements[0].childrenCount).toBe(mode === 'oversized' ? NATIVE_READ_NODE_BUDGET + 1 : 2);
    },
  );

  it('does not conceal permissions failures as a traversal boundary', async () => {
    const bridge = new FixtureNative((depth) => {
      if (depth === 3) return { tree: wrappedFrontier() };
      throw new NativeError('PERM_DENIED', 'Accessibility permission revoked');
    });
    await expect(bridge.observe({ ...context, rootRef: '@s1:e1' })).rejects.toThrow('permission revoked');
    expect(bridge.depths()).toEqual([3, 4]);
  });

  it('does not repeat the depth that already returned an incomplete read', async () => {
    const bridge = new FixtureNative((depth) => ({ tree: wrappedFrontier(), complete: depth !== 3 }));
    const observation = await bridge.observe({ ...context, rootRef: '@s1:e1' });
    expect(bridge.depths()).toEqual([3, 1, 2]);
    expect(observation.snapshots[0].elements[0].childrenCount).toBe(2);
  });

});
