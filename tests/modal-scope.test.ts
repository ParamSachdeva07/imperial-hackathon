import { describe, expect, it } from 'vitest';
import { activeModal } from '../apps/desktop/electron/desktop/modal-scope';
import { accessibilityTree, flattenTree } from '../apps/desktop/electron/desktop/accessibility-tree';
import { TreeBrowser } from '../apps/desktop/electron/controller/tree-browser';
import { desktopCandidates } from '../apps/desktop/electron/controller/desktop-candidates';
import { TaskInputSchema, type DesktopObservation } from '../packages/contracts/src/index';

describe('Blocking surface evidence', () => {
  it.each(['alert', 'status', 'dialog', 'alertdialog'])('does not treat a %s role or focus alone as proof of modality', role => {
    const tree = accessibilityTree({ role: 'window', children: [{ role, name: 'Message',
      native_id: { kind: 'identifier', value: 'announcement' }, states: ['focused'],
      available_actions: ['Click'], children: [{ role: 'statictext', name: 'Updated' }] }] });
    expect(activeModal(tree)).toBeUndefined();
  });
  it.each(['dialog', 'alertdialog', 'window', 'group'])('recognizes explicit modal state on %s', role => {
    const tree = accessibilityTree({ role: 'window', children: [{ role, name: 'Confirm', states: ['modal'] }] });
    expect(activeModal(tree)?.name).toBe('Confirm');
  });
  it('keeps a native sheet as the boundary when it contains a nonblocking announcement', () => {
    const tree = accessibilityTree({ role: 'window', children: [{ role: 'sheet', name: 'Save', children: [
      { role: 'alert', name: 'Filename changed', states: ['focused'] },
      { role: 'button', name: 'Cancel' },
    ] }] });
    expect(activeModal(tree)?.name).toBe('Save');
  });
  it('ignores hidden modals and does not guess between unfocused modal siblings', () => {
    const tree = accessibilityTree({ role: 'window', children: [
      { role: 'dialog', name: 'Hidden', states: ['hidden', 'modal', 'focused'] },
      { role: 'dialog', name: 'One', states: ['modal'] },
      { role: 'dialog', name: 'Two', states: ['modal'] },
    ] });
    expect(activeModal(tree)).toBeUndefined();
    tree.children[2].states.push('focused');
    expect(activeModal(tree)?.name).toBe('Two');
  });
  it('leaves sibling actions visible when a page exposes a live announcement', () => {
    const raw = { role: 'window', name: 'Workspace', children: [
      { role: 'button', name: 'Create item', ref_id: '@s1:e1', available_actions: ['Click'] },
      { role: 'webarea', children: [{ role: 'alert', ref_id: '@s1:e2',
        native_id: { kind: 'identifier', value: 'page-announcement' }, available_actions: ['Click'],
        children: [{ role: 'statictext', name: 'Workspace updated', states: ['offscreen'] }] }] },
    ] };
    const observation: DesktopObservation = { id: 'o1', capturedAt: 1, applications: [], windows: [], notices: [],
      context: { app: 'Example', windowId: 'w1' }, snapshots: [{ id: 's1', app: 'Example', windowId: 'w1',
        windowTitle: 'Workspace', complete: true, capturedAt: 1, tree: accessibilityTree(raw), elements: flattenTree(raw) }] };
    const browser = new TreeBrowser(observation);
    const view = browser.view(desktopCandidates(observation, TaskInputSchema.parse({ provider: 'jev', goal: 'Create an item' })));
    expect(browser.modal).toBeUndefined();
    expect(view.candidates.some(c => c.name === 'Create item' && c.operation === 'CLICK')).toBe(true);
    expect(view.observation.notices.some(n => n.includes('Active modal'))).toBe(false);
  });
});
