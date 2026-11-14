import { describe, it, expect } from 'vitest';
import { TreeBrowser } from '../apps/desktop/electron/controller/tree-browser';
import { desktopCandidates } from '../apps/desktop/electron/controller/desktop-candidates';
import { accessibilityTree } from '../apps/desktop/electron/desktop/accessibility-tree';
import { flattenTree } from '../apps/desktop/electron/desktop/accessibility-tree';
import { TaskInputSchema, type DesktopObservation } from '../packages/contracts/src/index';
import { nativeActionBudget } from '../apps/desktop/electron/controller/choice-budget';
const raw = {
  role: 'menu',
  children: [
    {
      role: 'menuitem',
      name: 'File',
      ref_id: '@s1:e1',
      available_actions: ['Click'],
      children: [
        {
          role: 'menu',
          name: 'File',
          children: [{ role: 'menuitem', name: 'New', ref_id: '@s1:e2', available_actions: ['Click'] }],
        },
      ],
    },
    {
      role: 'menuitem',
      name: 'Edit',
      ref_id: '@s1:e3',
      available_actions: ['Click'],
      children: [
        {
          role: 'menu',
          name: 'Edit',
          children: [{ role: 'menuitem', name: 'Undo', ref_id: '@s1:e4', available_actions: ['Click'] }],
        },
      ],
    },
  ],
};
const o: DesktopObservation = {
  id: 'obs',
  capturedAt: 0,
  context: { app: 'Example', surface: 'menubar' },
  applications: [{ id: 'other', name: 'Other', running: true }],
  windows: [],
  notices: [],
  snapshots: [
    {
      id: 's1',
      app: 'Example',
      windowId: '',
      windowTitle: '',
      complete: true,
      capturedAt: 0,
      surface: 'menubar',
      tree: accessibilityTree(raw),
      elements: flattenTree(raw),
      text: [],
    },
  ],
};
const candidates = desktopCandidates(
  o,
  TaskInputSchema.parse({ goal: 'Create a new document.', provider: 'jev' }),
);
describe('Accessibility hierarchy navigation', () => {
  it('keeps a branch selectable after repeated visits while reporting its visit count', () => {
    const browser = new TreeBrowser(o);
    for (let i = 0; i < 4; i++) {
      const branch = browser.view(candidates).candidates.find(c => c.operation === 'BROWSE_TREE' && c.name === 'File')!;
      expect(branch).toBeDefined();
      expect(branch.description).toContain('Previously inspected ' + i + ' times');
      browser.navigate(branch);
      browser.up();
    }
    expect(browser.view(candidates).candidates.some(c => c.operation === 'BROWSE_TREE' && c.name === 'File')).toBe(true);
  });
  it('excludes the entire overflowing action layer across every branch, then repeats at a selected boundary', () => {
    const rawTree = { role: 'window', children: [0, 1].map(branch => ({
      role: 'region', name: 'Section ' + branch,
      children: [{ role: 'toolbar', name: 'Controls ' + branch, children: Array.from({ length: 30 }, (_, i) => ({
        role: 'textfield', name: 'Field ' + branch + '-' + i, ref_id: '@s1:field' + branch + '_' + i,
        available_actions: ['Click', 'RightClick', 'SetFocus', 'SetValue', 'TypeText'],
      })) }],
    })) };
    const observed = { ...o, snapshots: [{ ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }] };
    const options = desktopCandidates(observed, TaskInputSchema.parse({ provider: 'jev', goal: 'Edit a field' }));
    const browser = new TreeBrowser(observed);
    const view = browser.view(options);
    expect(view.candidates.length).toBeLessThanOrEqual(nativeActionBudget(false, true));
    expect(view.candidates.some(c => c.name.startsWith('Field '))).toBe(false);
    expect(view.observation.snapshots[0].text?.join('\n')).not.toContain('Field ');
    expect(view.observation.snapshots[0].tree?.children.every(n => n.children[0].children.length === 0)).toBe(true);
    const boundary = view.candidates.find(c => c.operation === 'BROWSE_TREE' && c.name === 'Controls 1')!;
    expect(boundary).toBeDefined();
    browser.navigate(boundary);
    expect(browser.metadata().path.map(n => n.name)).toEqual(['window', 'Section 1', 'Controls 1']);
    const nested = browser.view(options);
    expect(new Set(nested.candidates.filter(c => c.name.startsWith('Field 1-')).map(c => c.targetRef)).size).toBe(30);
    expect(nested.candidates.some(c => c.name.startsWith('Field 0-'))).toBe(false);
    expect(nested.candidates.length).toBeLessThanOrEqual(nativeActionBudget(true, true));
    browser.up();
    expect(browser.metadata().path.at(-1)?.name).toBe('Section 1');
    browser.goRoot();
    expect(browser.view(options).candidates.some(c => c.name.startsWith('Field '))).toBe(false);
  });
  it('includes exactly 255 total choices but rejects the whole next layer at 256', () => {
    for (const count of [251, 252]) {
      const rawTree = { role: 'window', children: [{ role: 'region', name: 'Items', children:
        Array.from({ length: count }, (_, i) => ({ role: 'button', name: 'Item ' + i, ref_id: '@s1:item' + i, available_actions: ['Click'] })) }] };
      const observed = { ...o, snapshots: [{ ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }] };
      const options = desktopCandidates(observed, TaskInputSchema.parse({ provider: 'jev', goal: 'Choose an item' })).filter(c => c.operation === 'CLICK');
      const view = new TreeBrowser(observed).view(options);
      if (count === 251) {
        expect(view.candidates.length + 2).toBe(255); // STOP and DONE
        expect(view.candidates.filter(c => c.operation === 'CLICK')).toHaveLength(251);
      } else {
        expect(view.candidates.some(c => c.operation === 'CLICK')).toBe(false);
        expect(view.candidates.some(c => c.operation === 'BROWSE_TREE' && c.name === 'Items')).toBe(true);
      }
    }
  });
  it('allows more than 255 nodes when their action choices fit', () => {
    const rawTree = { role: 'window', children: [
      ...Array.from({ length: 300 }, (_, i) => ({ role: 'statictext', name: 'Read-only ' + i })),
      { role: 'button', name: 'Continue', ref_id: '@s1:continue', available_actions: ['Click'] },
    ] };
    const observed = { ...o, snapshots: [{ ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }] };
    const view = new TreeBrowser(observed).view(desktopCandidates(observed, TaskInputSchema.parse({ provider: 'jev', goal: 'Continue' })));
    expect(view.observation.snapshots[0].tree?.children).toHaveLength(301);
    expect(view.candidates.some(c => c.operation === 'CLICK' && c.name === 'Continue')).toBe(true);
    expect(view.observation.snapshots[0].text?.join('\n')).toContain('Read-only 299');
  });
  it('keeps a modal boundary and its sibling controls even when its wrapper has no native ref', () => {
    const rawTree = { role: 'window', children: [
      { role: 'button', name: 'Background action', ref_id: '@s1:e1', available_actions: ['Click'] },
      { role: 'sheet', name: 'Keep changes', children: [
        { role: 'textfield', name: 'Filename', ref_id: '@s1:e2', states: ['focused'], available_actions: ['SetValue'] },
        { role: 'button', name: 'Keep editing', ref_id: '@s1:e3', available_actions: ['Click'] },
        { role: 'button', name: 'Save', ref_id: '@s1:e4', available_actions: ['Click'] },
      ] },
    ] };
    const observed = { ...o, context: { app: 'Example', surface: 'window' }, snapshots: [{ ...o.snapshots[0],
      tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }] };
    const browser = new TreeBrowser(observed);
    const view = browser.view(desktopCandidates(observed, TaskInputSchema.parse({ provider: 'jev', goal: 'Create a new item' })));
    expect(browser.metadata().path.map(n => n.name)).toEqual(['Keep changes']);
    expect(browser.metadata().canGoUp).toBe(false);
    expect(view.candidates.some(c => c.operation === 'CLICK' && c.name === 'Keep editing')).toBe(true);
    expect(view.candidates.some(c => c.name === 'Background action')).toBe(false);
    expect(view.observation.notices[0]).toContain('Active modal');
    browser.goRoot();
    expect(browser.metadata().path[0].name).toBe('Keep changes');
  });
  it('chooses the innermost active dialog and ignores hidden dialogs', () => {
    const tree = accessibilityTree({ role: 'window', children: [
      { role: 'dialog', name: 'Old dialog', states: ['hidden'] },
      { role: 'sheet', name: 'Outer', children: [{ role: 'dialog', name: 'Inner', states: ['modal'], children: [
        { role: 'button', name: 'Continue', ref_id: '@s1:e1', available_actions: ['Click'] },
      ] }] },
    ] });
    const browser = new TreeBrowser({ ...o, snapshots: [{ ...o.snapshots[0], tree }] });
    expect(browser.modal?.name).toBe('Inner');
  });
  it('promotes siblings through anonymous layout groups without losing unread or semantic branches', () => {
    const rawTree = { role: 'window', children: [{ role: 'group', children: [
      { role: 'group', children: [] },
      { role: 'group', ref_id: '@s1:layout', available_actions: ['Click', 'RightClick', 'ScrollTo'], children: [
        { role: 'textfield', name: 'Query', ref_id: '@s1:query', available_actions: ['SetValue'] },
        { role: 'button', name: 'Submit', ref_id: '@s1:submit', available_actions: ['Click'] },
      ] },
      { role: 'group', name: 'Settings', children: [{ role: 'button', name: 'Advanced', ref_id: '@s1:advanced', available_actions: ['Click'] }] },
      { role: 'group', ref_id: '@s1:unread', children_count: 5 },
    ] }] };
    const observed = { ...o, snapshots: [{ ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }] };
    const options = desktopCandidates(observed, TaskInputSchema.parse({ provider: 'jev', goal: 'Search for a query' }));
    const view = new TreeBrowser(observed).view(options);
    expect(view.candidates.some(c => c.targetRef === '@s1:query' && c.operation === 'SET_VALUE')).toBe(true);
    expect(view.candidates.some(c => c.targetRef === '@s1:submit' && c.operation === 'CLICK')).toBe(true);
    expect(view.candidates.some(c => c.targetRef === '@s1:unread' && c.operation === 'INSPECT_REGION')).toBe(true);
    expect(view.candidates.some(c => c.name === 'Settings' && c.operation === 'BROWSE_TREE')).toBe(true);
    expect(view.candidates.some(c => c.targetRef === '@s1:advanced')).toBe(true);
  });
  it('exposes loaded descendants directly while retaining optional branch browsing', () => {
    const browser = new TreeBrowser(o),
      view = browser.view(candidates);
    expect(view.candidates.some((c) => c.operation === 'BROWSE_TREE' && c.name === 'File')).toBe(true);
    expect(view.candidates.some((c) => c.operation === 'CLICK' && c.name === 'New')).toBe(true);
    expect(view.candidates.find(c => c.operation === 'CLICK' && c.name === 'New')?.description).toContain('Observed path: menu > File > New');
    expect(view.candidates.some((c) => c.operation === 'CLICK' && c.name === 'File')).toBe(true);
  });
  it('descends into File, collapses its wrapper menu, and goes up again', () => {
    const browser = new TreeBrowser(o);
    browser.navigate(
      browser.view(candidates).candidates.find((c) => c.operation === 'BROWSE_TREE' && c.name === 'File')!,
    );
    expect(browser.metadata().path.map((n) => n.name)).toEqual(['menu', 'File']);
    expect(browser.view(candidates).candidates.some((c) => c.name === 'New' && c.operation === 'CLICK')).toBe(
      true,
    );
    expect(browser.view(candidates).candidates.some((c) => c.name === 'Undo')).toBe(false);
    expect(browser.view(candidates).observation.snapshots[0].contextText?.join('\n')).toContain('Ancestor context (read-only; navigate before acting): menu');
    browser.up();
    expect(browser.metadata().canGoUp).toBe(false);
    expect(browser.view(candidates).candidates.some((c) => c.name === 'New')).toBe(true);
  });
  it('can browse apps and return to the same branch', () => {
    const browser = new TreeBrowser(o);
    browser.navigate(
      browser.view(candidates).candidates.find((c) => c.operation === 'BROWSE_TREE' && c.name === 'Edit')!,
    );
    browser.navigate(browser.view(candidates).candidates.find((c) => c.operation === 'BROWSE_APPS')!);
    expect(browser.metadata().view).toBe('applications');
    expect(browser.view(candidates).observation.snapshots).toEqual([]);
    browser.up();
    expect(browser.metadata().path.at(-1)?.name).toBe('Edit');
  });
  it('offers the focused editor directly without hiding other loaded branches', () => {
    const field = {
      role: 'textfield',
      name: 'Address and search bar',
      ref_id: '@s1:e9',
      available_actions: ['SetValue', 'TypeText'],
      states: ['focused'],
    };
    const rawTree = {
      role: 'window',
      children: [{ role: 'group', children: [{ role: 'toolbar', children: [field] }] }],
    };
    const snapshot = { ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) };
    const observed = { ...o, snapshots: [snapshot] };
    const browser = new TreeBrowser(observed);
    const options = desktopCandidates(
      observed,
      TaskInputSchema.parse({ goal: 'Go to "https://www.youtube.com".', provider: 'jev' }),
    );
    expect(browser.metadata().path.at(-1)?.name).toBe('window');
    expect(browser.view(options).candidates.some((c) => c.operation === 'SET_VALUE')).toBe(true);
    expect(browser.view(options).candidates.some((c) => c.operation === 'TYPE')).toBe(true);
  });
  it('rejects a forged branch outside the current node', () => {
    const browser = new TreeBrowser(o);
    const branch = browser.view(candidates).candidates.find((c) => c.operation === 'BROWSE_TREE')!;
    expect(() => browser.navigate({ ...branch, nodeId: 'unrelated' })).toThrow('not a child');
    expect(() => browser.up()).toThrow('root');
  });
  it('includes unread output branches in previews so the model can find completion evidence', () => {
    const rawTree = {
      role: 'window',
      children: [
        {
          role: 'group',
          name: 'Calculator',
          children: [
            ...Array.from({ length: 20 }, (_, i) => ({
              role: 'button',
              name: String(i),
              available_actions: ['Click'],
            })),
            {
              role: 'scrollarea',
              ref_id: '@s1:output',
              native_id: { value: 'ResultView' },
              children_count: 1,
            },
          ],
        },
      ],
    };
    const observed = {
      ...o,
      snapshots: [{ ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }],
    };
    const view = new TreeBrowser(observed).view([]);
    expect(view.candidates.find((c) => c.operation === 'BROWSE_TREE')?.description).toContain(
      'ResultView (1 unread children)',
    );
    expect(view.observation.snapshots[0].text?.join('\n')).toContain('ResultView | unread=1');
  });
  it('fetches parent scopes and window root instead of pretending their children are cached', () => {
    const current = {
      ...o,
      context: {
        ...o.context,
        rootRef: '@s1:e4',
        scopePath: [
          { ref: '@s1:e1', name: 'Mail' },
          { ref: '@s1:e4', name: 'Composer' },
        ],
      },
    };
    const browser = new TreeBrowser(current);
    expect(browser.metadata().canGoUp).toBe(true);
    expect(browser.nativeNavigation('GO_PARENT')?.rootRef).toBe('@s1:e1');
    expect(browser.nativeNavigation('GO_ROOT')?.rootRef).toBeUndefined();
    expect(browser.nativeNavigation('GO_ROOT')?.scopePath).toBeUndefined();
    expect(browser.metadata().path.map((n) => n.name)).toContain('Composer');
  });
  it('browses structural landmarks instead of clicking containers, while preserving leaf controls', () => {
    for (const role of ['banner', 'main', 'navigation', 'search', 'complementary', 'contentinfo', 'region']) {
      const rawTree = {
        role: 'window',
        children: [
          {
            role,
            name: 'Loaded ' + role,
            ref_id: '@s1:loaded',
            available_actions: ['Click', 'RightClick'],
            children: [{ role: 'button', name: 'Search', ref_id: '@s1:search', available_actions: ['Click'] }],
          },
          {
            role,
            name: 'Unread ' + role,
            ref_id: '@s1:unread',
            available_actions: ['Click', 'RightClick'],
            children_count: 1,
          },
        ],
      };
      const observed = {
        ...o,
        snapshots: [{ ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }],
      };
      const options = desktopCandidates(
        observed,
        TaskInputSchema.parse({ goal: 'Use Search.', provider: 'jev', allowPhysical: true }),
      );
      const pointerActions = ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK'];
      // Prove the raw accessibility capabilities really do advertise these
      // container actions, so this exercises TreeBrowser's semantic filtering.
      for (const targetRef of ['@s1:loaded', '@s1:unread'])
        expect(options.filter(c => c.targetRef === targetRef && pointerActions.includes(c.operation))
          .map(c => c.operation).sort()).toEqual([...pointerActions].sort());

      const browser = new TreeBrowser(observed);
      const root = browser.view(options).candidates;
      expect(root.filter(c => pointerActions.includes(c.operation)).every(c => c.targetRef === '@s1:search')).toBe(true);
      expect(root.some(c => c.operation === 'INSPECT_REGION' && c.targetRef === '@s1:unread')).toBe(true);
      const branch = root.find(c => c.operation === 'BROWSE_TREE' && c.name === 'Loaded ' + role);
      expect(branch).toBeDefined();
      browser.navigate(branch!);
      const children = browser.view(options).candidates;
      expect(children.some(c => c.targetRef === '@s1:loaded' && pointerActions.includes(c.operation))).toBe(false);
      expect(children.some(c => c.operation === 'CLICK' && c.targetRef === '@s1:search')).toBe(true);
    }
  });
  it('withholds unidentified mouse targets while retaining ways to inspect their contents', () => {
    const rawTree = {
      role: 'webarea',
      children: [
        { role: 'link', ref_id: '@s1:anonymous', available_actions: ['Click', 'RightClick'] },
        {
          role: 'link', ref_id: '@s1:opaque', native_id: { value: '_NS:12345' },
          available_actions: ['Click', 'RightClick'], children_count: 1,
        },
        {
          role: 'link', ref_id: '@s1:hidden-label', available_actions: ['Click', 'RightClick'],
          children: [{ role: 'statictext', value: 'Hidden destination', states: ['hidden'] }],
        },
      ],
    };
    const observed = {
      ...o,
      snapshots: [{ ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }],
    };
    const options = desktopCandidates(
      observed,
      TaskInputSchema.parse({ goal: 'Find the relevant document.', provider: 'jev', allowPhysical: true }),
    );
    const pointerActions = ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK'];
    expect(options.filter(c => pointerActions.includes(c.operation))).toHaveLength(9);
    const visible = new TreeBrowser(observed).view(options).candidates;
    expect(visible.some(c => pointerActions.includes(c.operation))).toBe(false);
    expect(visible.some(c => c.operation === 'INSPECT_REGION' && c.targetRef === '@s1:opaque')).toBe(true);
    expect(visible.some(c => c.operation === 'BROWSE_TREE' &&
      c.nodeId === observed.snapshots[0].tree.children[2].id)).toBe(true);
  });
  it('uses readable descendants to identify links and preserves named icon buttons', () => {
    const rawTree = {
      role: 'webarea',
      children: [
        {
          role: 'link', ref_id: '@s1:document', available_actions: ['Click'],
          children: [
            { role: 'statictext', value: 'Annual report' },
            { role: 'heading', name: 'Download document' },
          ],
        },
        { role: 'button', name: 'Settings', ref_id: '@s1:settings', available_actions: ['Click'] },
      ],
    };
    const observed = {
      ...o,
      snapshots: [{ ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }],
    };
    const options = desktopCandidates(
      observed,
      TaskInputSchema.parse({ goal: 'Open the annual report.', provider: 'jev' }),
    );
    const browser = new TreeBrowser(observed);
    const visible = browser.view(options).candidates;
    const document = visible.find(c => c.operation === 'CLICK' && c.targetRef === '@s1:document');
    expect(document?.name).toContain('Annual report');
    expect(document?.description).toContain('Download document');
    expect(visible.find(c => c.operation === 'CLICK' && c.targetRef === '@s1:settings')?.name).toBe('Settings');
    expect(options.find(c => c.operation === 'CLICK' && c.targetRef === '@s1:document')?.name).toBe('link');

    browser.navigate(visible.find(c => c.operation === 'BROWSE_TREE')!);
    expect(browser.view(options).candidates.find(c => c.operation === 'CLICK' &&
      c.targetRef === '@s1:document')?.name).toContain('Annual report');
  });
  it('does not borrow an embedded interactive widget or its captions as an outer link purpose', () => {
    const rawTree = {
      role: 'webarea',
      children: [
        {
          role: 'link', ref_id: '@s1:outer', available_actions: ['Click', 'RightClick'],
          children: [{
            role: 'group',
            children: [{
              role: 'group', name: 'Media player', ref_id: '@s1:player',
              available_actions: ['Click', 'SetFocus'],
              children: [{ role: 'statictext', value: 'Introduction to retrieval' }],
            }],
          }],
        },
        {
          role: 'link', name: 'Introduction to retrieval', ref_id: '@s1:result',
          available_actions: ['Click'],
        },
      ],
    };
    const observed = {
      ...o,
      snapshots: [{ ...o.snapshots[0], tree: accessibilityTree(rawTree), elements: flattenTree(rawTree) }],
    };
    const options = desktopCandidates(
      observed,
      TaskInputSchema.parse({ goal: 'Open Introduction to retrieval.', provider: 'jev', allowPhysical: true }),
    );
    const pointerActions = ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK'];
    expect(options.filter(c => c.targetRef === '@s1:outer' && pointerActions.includes(c.operation))).toHaveLength(3);
    const browser = new TreeBrowser(observed);
    const root = browser.view(options).candidates;
    expect(root.some(c => c.targetRef === '@s1:outer' && pointerActions.includes(c.operation))).toBe(false);
    expect(root.find(c => c.targetRef === '@s1:result' && c.operation === 'CLICK')?.name)
      .toBe('Introduction to retrieval');

    browser.navigate(root.find(c => c.operation === 'BROWSE_TREE')!);
    const nested = browser.view(options).candidates;
    expect(nested.some(c => c.targetRef === '@s1:outer' && pointerActions.includes(c.operation))).toBe(false);
    expect(nested.some(c => c.targetRef === '@s1:player' && c.operation === 'CLICK')).toBe(false);
    expect(nested.some(c => c.name === 'Media player' && c.operation === 'BROWSE_TREE')).toBe(true);
  });
});
