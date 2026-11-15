import { describe, expect, it } from 'vitest';
import { activeModal } from '../apps/desktop/electron/desktop/modal-scope';
import { accessibilityTree, flattenTree } from '../apps/desktop/electron/desktop/accessibility-tree';
import { type DesktopObservation } from '../packages/contracts/src/index';

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
});
