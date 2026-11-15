import { describe, expect, it } from 'vitest';
import { accessibilityTree, flattenTree } from '../apps/desktop/electron/desktop/accessibility-tree';
import { ObservationIndex } from '../apps/desktop/electron/controller/v2/observation-index';
import { evaluateCheck } from '../apps/desktop/electron/controller/v2/checks';
import { readBudgetedTree } from '../apps/desktop/electron/desktop/tree-budget';
import type { DesktopObservation } from '../packages/contracts/src/index';

let refs = 0;
const node = (role: string, name: string, extra: Record<string, unknown> = {}, children: unknown[] = []) =>
  ({ role, name, ref_id: '@s1:e' + ++refs, available_actions: [], states: [], children, ...extra });
const button = (name: string, extra: Record<string, unknown> = {}) => node('button', name, { available_actions: ['Click'], ...extra });
export function observe(raw: any, over: Partial<DesktopObservation> = {}, id = 'o1'): DesktopObservation {
  return { id, capturedAt: 1, applications: [{ name: 'Example', id: 'example', running: true }, { name: 'Notes', id: 'com.apple.Notes', running: true },
    { name: 'Calendar', id: 'com.apple.iCal', running: false }],
    windows: [{ id: 'w1', title: 'Workspace', app: 'Example', focused: true }, { id: 'w2', title: 'Inspector', app: 'Example', focused: false }],
    notices: [], context: { app: 'Example', windowId: 'w1', surface: 'window' },
    snapshots: [{ id: 's1', app: 'Example', windowId: 'w1', windowTitle: 'Workspace', surface: 'window', complete: true, capturedAt: 1,
      tree: accessibilityTree(raw), elements: flattenTree(raw) }], ...over };
}
const select = (index: ObservationIndex, query = '', terms: string[] = []) =>
  index.select({ query, requirementTerms: terms, pinned: [] });

describe('observation index', () => {
  it('retrieves a relevant control at any depth instead of truncating by layer', () => {
    // Nine levels down, behind 300 shallow controls that a depth-first-layers rule would keep.
    let deep: any = button('Export as PDF');
    for (let i = 0; i < 9; i++) deep = node('group', '', { ref_id: undefined }, [deep]);
    const raw = node('window', 'Workspace', {}, [...Array.from({ length: 300 }, (_, i) => button('Shortcut ' + i)), deep]);
    const selection = select(new ObservationIndex(observe(raw)), 'export pdf');
    const found = selection.elements.find(e => e.label === 'Export as PDF');
    expect(found?.operations).toEqual(['CLICK']);
    expect(found?.tags).toContain('match');
    expect(selection.elements.length).toBeLessThanOrEqual(100);
  });
  it('uses the requirement text when there is no query yet', () => {
    const raw = node('window', 'Workspace', {}, [button('Archive'), node('toolbar', 'Formatting', {}, [button('Bold'), button('Italic')])]);
    const selection = select(new ObservationIndex(observe(raw)), '', ['Make the heading bold']);
    expect(selection.elements[0].label === 'Bold' || selection.elements.some(e => e.label === 'Bold' && e.tags.includes('match'))).toBe(true);
  });
  it('keeps an unlabeled control selectable and describes it by its surroundings', () => {
    const raw = node('window', 'Workspace', {}, [node('toolbar', 'Formatting', {}, [button('Bold'), button(''), button('Underline')])]);
    const index = new ObservationIndex(observe(raw));
    const unlabeled = select(index, 'bold underline').elements.find(e => e.tags.includes('unlabeled'));
    expect(unlabeled?.operations).toEqual(['CLICK']);
    expect(unlabeled?.label).toContain('next to "Bold" and "Underline"');
    expect(unlabeled?.label).toContain('2 of 3 in Formatting');
    expect(index.capability().unlabeledActionable).toBe(1);
  });
  it('restricts only on reported states: hidden is absent, disabled offers nothing, a container stays clickable', () => {
    const raw = node('window', 'Workspace', {}, [button('Ghost', { states: ['hidden'] }), button('Locked', { states: ['disabled'] }),
      node('group', 'Card', { available_actions: ['Click'] }, [node('statictext', 'Open the card')])]);
    const elements = select(new ObservationIndex(observe(raw)), 'ghost locked card').elements;
    expect(elements.some(e => e.label === 'Ghost')).toBe(false);
    expect(elements.find(e => e.label === 'Locked')?.operations).toEqual([]);
    expect(elements.find(e => e.label === 'Card')?.operations).toEqual(['CLICK']);
  });
  it('does not let an announcement hide the rest of the window', () => {
    const raw = node('window', 'Workspace', {}, [button('Create item'),
      node('webarea', '', {}, [node('alert', 'Workspace updated', { states: ['focused'], available_actions: ['Click'] })])]);
    const elements = select(new ObservationIndex(observe(raw)), 'create').elements;
    expect(elements.find(e => e.label === 'Create item')?.operations).toEqual(['CLICK']);
    expect(elements.some(e => e.tags.includes('modal'))).toBe(false);
  });
  it('always includes the focused element, a modal surface and what changed', () => {
    const before = node('window', 'Workspace', {}, [node('textfield', 'Title', { value: 'Draft', states: ['focused'], available_actions: ['SetValue'] }),
      node('statictext', 'Status', { value: 'saving' })]);
    const after = node('window', 'Workspace', {}, [node('textfield', 'Title', { value: 'Draft', available_actions: ['SetValue'] }),
      node('statictext', 'Status', { value: 'saved' }),
      node('sheet', 'Save changes?', {}, [button('Cancel'), button('Don’t Save')])]);
    const first = new ObservationIndex(observe(before));
    expect(select(first, 'zzz').elements.find(e => e.label === 'Title')?.tags).toContain('focused');
    const second = new ObservationIndex(observe(after, {}, 'o2'));
    const selection = second.select({ query: 'zzz', requirementTerms: [], pinned: [], previous: { viewKey: first.viewKey(), facts: first.facts() } });
    expect(selection.elements.find(e => e.label === 'Status')?.tags).toContain('changed');
    expect(selection.elements.find(e => e.label === 'Cancel')?.tags).toContain('modal');
    // Losing focus is not a content change.
    expect(selection.elements.find(e => e.label === 'Title')?.tags ?? []).not.toContain('changed');
    expect(second.delta({ viewKey: first.viewKey(), facts: first.facts() }).added.some(f => f.includes('saved'))).toBe(true);
  });
  it('cannot claim something appeared when the scope changed', () => {
    const raw = node('window', 'Workspace', {}, [button('One')]);
    const first = new ObservationIndex(observe(raw));
    const scoped = new ObservationIndex(observe(raw, { context: { app: 'Example', windowId: 'w1', surface: 'menubar' } }, 'o2'));
    expect(scoped.delta({ viewKey: first.viewKey(), facts: first.facts() })).toEqual({ scopeChanged: true, added: [], removed: [] });
  });
  it('preserves new-window evidence while changing tree scope', () => {
    const first = new ObservationIndex(observe(node('window', 'Workspace')));
    const next = observe(node('window', 'New document'), { context: { app: 'Example', windowId: 'w3', surface: 'window' },
      windows: [...first.observation.windows, { id: 'w3', title: 'New document', app: 'Example', focused: true }] }, 'o2');
    const delta = new ObservationIndex(next).delta({ viewKey: first.viewKey(), facts: first.facts() });
    expect(delta.scopeChanged).toBe(true);
    expect(delta.added).toEqual(['["window","New document"]']);
  });
  it('offers verified focus-and-paste on focused native editors without claiming disabled AX actions work', () => {
    const raw = node('window', 'Workspace', {}, [node('textfield', 'Editor', { states: ['disabled', 'focused'],
      bounds: { x: 0, y: 0, width: 300, height: 200 }, available_actions: ['SetValue'] })]);
    const editor = select(new ObservationIndex(observe(raw))).elements.find(e => e.label === 'Editor');
    expect(editor?.operations).toEqual(['FOCUS_AND_PASTE']);
  });
  it('lists windows, running applications and read scopes, and finds an installed app by name', () => {
    const raw = node('window', 'Workspace', {}, [node('list', 'Sidebar', { children_count: 12 })]);
    const index = new ObservationIndex(observe(raw));
    const selection = select(index, 'calendar');
    expect(selection.elements.find(e => e.label === 'Inspector')?.operations).toEqual(['FOCUS_WINDOW']);
    expect(selection.elements.find(e => e.label === 'Notes')?.operations).toEqual(['OPEN_APP']);
    expect(selection.elements.some(e => e.label === 'Calendar')).toBe(true);
    expect(selection.elements.some(e => e.label === 'Example' && e.role === 'application')).toBe(false);
    const scopes = selection.scopes.map(s => s.id);
    expect(scopes).toEqual(expect.arrayContaining(['surface:menubar', 'apps', 'app-search']));
    expect(scopes.some(id => id.startsWith('region:'))).toBe(true);
    expect(scopes).not.toContain('surface:window');
    expect(index.outline().join('\n')).toContain('12 unread children');
  });
  it('offers no mutation from an incomplete tree', () => {
    const raw = node('window', 'Workspace', {}, [button('Apply')]);
    const observation = observe(raw);
    observation.snapshots[0].complete = false;
    expect(select(new ObservationIndex(observation), 'apply').elements.find(e => e.label === 'Apply')?.operations).toEqual([]);
  });
});

describe('typed checks', () => {
  const raw = () => node('window', 'Player', {}, [node('slider', 'Elapsed', { value: '0:13' }), node('checkbox', 'Mute', { states: ['checked'] }),
    button('Row'), button('Row')]);
  it('reads text, states and presence from one uniquely identified element', () => {
    const index = new ObservationIndex(observe(raw()));
    const mute = index.nodes.find(n => n.label === 'Mute')!.identity;
    expect(evaluateCheck({ kind: 'state_present', target: mute, value: 'checked' }, index, new Map()).pass).toBe(true);
    expect(evaluateCheck({ kind: 'state_absent', target: mute, value: 'checked' }, index, new Map()).pass).toBe(false);
    const elapsed = index.nodes.find(n => n.label === 'Elapsed')!.identity;
    expect(evaluateCheck({ kind: 'text_equals', target: elapsed, value: '0:13' }, index, new Map()).pass).toBe(true);
    expect(evaluateCheck({ kind: 'target_present', target: { ...elapsed, label: 'Missing' }, value: '' }, index, new Map()).pass).toBe(false);
  });
  it('needs a later observation before a readout counts as advancing', () => {
    const baselines = new Map();
    const first = new ObservationIndex(observe(raw()));
    const target = first.nodes.find(n => n.label === 'Elapsed')!.identity;
    expect(evaluateCheck({ kind: 'value_advances', target, value: '' }, first, baselines).pass).toBe(false);
    expect(evaluateCheck({ kind: 'value_advances', target, value: '' }, first, baselines).pass).toBe(false);
    const later = raw();
    (later.children[0] as any).value = '0:15';
    expect(evaluateCheck({ kind: 'value_advances', target, value: '' }, new ObservationIndex(observe(later, {}, 'o2')), baselines).pass).toBe(true);
  });
});

describe('direct deep read', () => {
  const tree = (depth: number): any => ({ role: 'group', children: depth ? [tree(depth - 1)] : [] });
  it('uses one read when the scope fits', async () => {
    const depths: number[] = [];
    const data = await readBudgetedTree(async depth => { depths.push(depth); return { complete: true, tree: tree(4) }; }, () => false, [], 8);
    expect(depths).toEqual([8]);
    expect(data.complete).toBe(true);
  });
  it('falls back to the layered climb when the deep read hits a limit', async () => {
    const depths: number[] = [];
    const notices: string[] = [];
    await readBudgetedTree(async depth => {
      depths.push(depth);
      if (depth === 8) throw new Error('limit');
      return { complete: true, tree: tree(2) };
    }, error => (error as Error).message === 'limit', notices, 8);
    expect(depths.slice(0, 2)).toEqual([8, 3]);
    expect(notices.join(' ')).toContain('layer by layer');
  });
  it('keeps the original behaviour by default', async () => {
    const depths: number[] = [];
    await readBudgetedTree(async depth => { depths.push(depth); return { complete: true, tree: tree(1) }; }, () => false, []);
    expect(depths[0]).toBe(3);
  });
});

describe('identity from a real tree', () => {
  const row = (name: string) => node('row', name, {}, [button('Delete')]);
  const table = () => node('table', 'Files', {}, [row('report.pdf'), row('notes.txt')]);
  it('gives the same button in two rows two identities, and keeps one identity across a scoped read', async () => {
    const { matchIdentity } = await import('../apps/desktop/electron/controller/v2/identity');
    const full = new ObservationIndex(observe(node('window', 'Workspace', {}, [node('toolbar', 'Tools'), table()])));
    const deletes = full.nodes.filter(n => n.label === 'Delete');
    expect(deletes).toHaveLength(2);
    expect(matchIdentity(deletes[0].identity, deletes[1].identity)).toBe('weak');
    // The same table read as its own scope: the second row's Delete is still the second row's Delete.
    const scoped = new ObservationIndex(observe(table(), { context: { app: 'Example', windowId: 'w1', surface: 'window', rootRef: '@s1:e1' } }, 'o2'));
    const scopedDeletes = scoped.nodes.filter(n => n.label === 'Delete');
    expect(matchIdentity(deletes[1].identity, scopedDeletes[1].identity)).toBe('strong');
    expect(matchIdentity(deletes[0].identity, scopedDeletes[1].identity)).toBe('weak');
    expect(full.find(scopedDeletes[1].identity, 'strong')).toEqual([deletes[1]]);
  });
  it('offers a read scope for a retrieved region even when many unread regions come before it', () => {
    const regions = Array.from({ length: 40 }, (_, i) => node('group', i === 39 ? 'Billing history' : 'Section ' + i, { children_count: 5 }));
    const selection = select(new ObservationIndex(observe(node('window', 'Workspace', {}, regions))), 'billing history');
    const wanted = selection.elements.find(e => e.label === 'Billing history')!;
    expect(wanted.tags).toContain('unread:5');
    expect(selection.scopes.map(s => s.id)).toContain('region:' + wanted.id);
  });
});

describe('a region read as its own scope', () => {
  const row = (name: string) => node('row', name, {}, [button('Delete')]);
  it('keeps the identities its elements have in the full window, so one row is never mistaken for another', async () => {
    const { matchIdentity } = await import('../apps/desktop/electron/controller/v2/identity');
    const full = new ObservationIndex(observe(node('window', 'Workspace', {}, [node('table', 'Files', {}, [row('report.pdf'), row('notes.txt')])])));
    const rows = full.nodes.filter(n => n.role === 'row');
    const deletes = full.nodes.filter(n => n.label === 'Delete');
    // Read the second row alone, anchored to where it sits in the window.
    const anchor = { trail: rows[1].identity.ancestorRoles, index: rows[1].identity.siblingIndex };
    const scoped = new ObservationIndex(observe(row('notes.txt'), { context: { app: 'Example', windowId: 'w1', surface: 'window', rootRef: '@s1:e1',
      scopePath: [{ ref: '@s1:e1', name: 'notes.txt', anchor }] } }, 'o2'));
    const scopedDelete = scoped.nodes.find(n => n.label === 'Delete')!;
    expect(matchIdentity(scopedDelete.identity, deletes[1].identity)).toBe('exact');
    expect(matchIdentity(scopedDelete.identity, deletes[0].identity)).toBe('weak');
    expect(full.find(scopedDelete.identity, 'strong')).toEqual([deletes[1]]);
  });
});
