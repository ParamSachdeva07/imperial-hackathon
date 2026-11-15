import { describe, expect, it } from 'vitest';
import { matchIdentity, type ElementIdentity } from '../apps/desktop/electron/controller/v2/identity';
import { TaskState } from '../apps/desktop/electron/controller/v2/task-state';
import { exactInputs } from '../apps/desktop/electron/controller/task-instructions';
import { TaskInputSchema } from '../packages/contracts/src/index';

const identity = (over: Partial<ElementIdentity> = {}): ElementIdentity => ({ app: 'Word', windowId: 'w1', role: 'button',
  label: 'Apply', ancestorRoles: ['window', 'toolbar'], siblingIndex: 0, ...over });

describe('element identity', () => {
  it('separates exact, strong, weak and none', () => {
    expect(matchIdentity(identity(), identity())).toBe('exact');
    expect(matchIdentity(identity(), identity({ windowId: 'w2' }))).toBe('weak');
    expect(matchIdentity(identity(), identity({ siblingIndex: 1 }))).toBe('weak');
    expect(matchIdentity(identity(), identity({ label: 'Cancel' }))).toBe('none');
    expect(matchIdentity(identity(), identity({ role: 'link' }))).toBe('none');
    expect(matchIdentity(identity(), identity({ app: 'Pages' }))).toBe('none');
  });
  it('lets a stable native id follow a control that moved or was relabelled', () => {
    const id = { kind: 'identifier', value: 'apply-button' };
    expect(matchIdentity(identity({ nativeId: id }), identity({ nativeId: id, siblingIndex: 3 }))).toBe('strong');
    expect(matchIdentity(identity({ nativeId: id }), identity({ nativeId: id, label: 'Apply now' }))).toBe('strong');
    // Applications reuse one id for a whole family of controls: every tab, every row's button.
    expect(matchIdentity(identity({ nativeId: id, label: 'Save to playlist' }), identity({ nativeId: id, label: 'Delete playlist', siblingIndex: 4 }))).toBe('weak');
    expect(matchIdentity(identity({ nativeId: id }), identity({ nativeId: { kind: 'identifier', value: 'other' } }))).toBe('weak');
  });
  it('does not trust per-instance AppKit identifiers', () => {
    const a = identity({ nativeId: { kind: 'identifier', value: '_NS:12' } });
    const b = identity({ nativeId: { kind: 'identifier', value: '_NS:99' } });
    expect(matchIdentity(a, b)).toBe('exact');
  });
  it('recognises a control read through a narrower scope', () => {
    const inWindow = identity({ ancestorRoles: ['window#*', 'group#2', 'popover#0', 'toolbar#1'] });
    expect(matchIdentity(inWindow, identity({ ancestorRoles: ['popover#*', 'toolbar#1'] }))).toBe('strong');
    expect(matchIdentity(inWindow, identity({ ancestorRoles: ['sheet#*', 'toolbar#1'] }))).toBe('weak');
    expect(matchIdentity(inWindow, identity({ ancestorRoles: ['popover#*', 'toolbar#0'] }))).toBe('weak');
  });
  it('tells the same button in two rows apart', () => {
    const inRow = (n: number) => identity({ label: 'Delete', ancestorRoles: ['window#*', 'table#0', 'row#' + n] });
    expect(matchIdentity(inRow(0), inRow(0))).toBe('exact');
    expect(matchIdentity(inRow(0), inRow(1))).toBe('weak');
  });
  it('relates unlabeled controls by position only, and only weakly', () => {
    expect(matchIdentity(identity({ label: '' }), identity({ label: '' }))).toBe('weak');
    expect(matchIdentity(identity({ label: '' }), identity({ label: '', siblingIndex: 2 }))).toBe('none');
  });
});

describe('quoted literals', () => {
  it('does not read apostrophes as quotation marks', () => {
    const goal = (text: string) => exactInputs(TaskInputSchema.parse({ provider: 'jev', goal: text })).map(i => i.text);
    expect(goal("Open John's notes and tell me what's new")).toEqual([]);
    expect(goal("Don't close it; reply to Mary's email")).toEqual([]);
    expect(goal("Type 'hello there' into the note")).toEqual(['hello there']);
    expect(goal('Write "it\'s fine" in the body')).toEqual(["it's fine"]);
  });
});

describe('task state', () => {
  const fresh = () => {
    const state = new TaskState('t1', 'Make the text 24 pt');
    state.declare([{ id: 'r1', text: 'The text is 24 pt', irreversible: false }]);
    return state;
  };
  const act = (state: TaskState, over: Record<string, unknown> = {}) => state.propose({ step: 1, requirementId: 'r1', operation: 'CLICK',
    args: {}, target: identity(), targetLabel: 'Apply', risk: 'reversible', expect: 'applied', ...over } as any);

  it('never deletes or rewords a requirement, so accepted evidence keeps its meaning', () => {
    const state = fresh();
    state.setStatus('r1', 'evidenced', 'o1', [{ row: 'e1', text: 'text "Body" [24 pt]' }]);
    state.declare([{ id: 'r1', text: 'The text is 24 pt and the document is saved and emailed', irreversible: false }]);
    state.declare([]);
    expect(state.requirements.map(r => r.text)).toEqual(['The text is 24 pt']);
    expect(state.allEvidenced()).toBe(true);
    expect(state.log.filter(e => e.kind === 'requirement_rewording_ignored')).toHaveLength(1);
    // New obligations arrive as new requirements, which start open.
    state.declare([{ id: 'r2', text: 'The document is saved', irreversible: false }]);
    expect(state.allEvidenced()).toBe(false);
  });
  it('does not treat a confirmed action as free to send again', () => {
    const state = fresh();
    const first = act(state);
    state.delivered(first, { delivery: 'delivered' });
    state.reconcile(first.id, 'confirmed', 'o2', ['e4']);
    expect(state.retryBlock('CLICK', {}, identity())).toBeUndefined();
    expect(state.confirmedTwin('CLICK', {}, identity())?.id).toBe(first.id);
    expect(state.confirmedTwin('CLICK', {}, identity({ label: 'Other' }))).toBeUndefined();
    expect(state.confirmedTwin('SCROLL', { direction: 'down' }, identity())).toBeUndefined();
  });
  it('only lets the first statement authorise an irreversible effect', () => {
    const state = new TaskState('t1', 'Send the email');
    state.declare([{ id: 'send', text: 'The email is sent', irreversible: true }]);
    const issues = state.declare([{ id: 'send', text: 'The email is sent', irreversible: true },
      { id: 'delete', text: 'The draft is deleted', irreversible: true }]);
    expect(state.requirement('send')!.irreversible).toBe(true);
    expect(state.requirement('delete')!.irreversible).toBe(false);
    expect(issues.join(' ')).toContain('cannot authorise');
  });
  it('withholds a repeat until the earlier attempt is reconciled, whatever the screen looks like', () => {
    const state = fresh();
    const first = act(state);
    state.delivered(first, { delivery: 'delivered' });
    expect(state.retryBlock('CLICK', {}, identity())?.id).toBe(first.id);
    expect(state.retryBlock('CLICK', {}, identity({ label: 'Cancel' }))).toBeUndefined();
    expect(state.reconcile(first.id, 'confirmed', 'o2', [])).toContain('needs at least one cited element');
    expect(state.reconcile(first.id, 'confirmed', 'o2', ['e4'])).toBeUndefined();
    expect(state.retryBlock('CLICK', {}, identity())).toBeUndefined();
  });
  it('allows a retry after an uncertain delivery is refuted with evidence', () => {
    const state = fresh();
    const first = act(state);
    state.delivered(first, { delivery: 'uncertain', note: 'timeout' });
    expect(state.retryBlock('CLICK', {}, identity())).toBeDefined();
    state.reconcile(first.id, 'refuted', 'o2', ['e1']);
    expect(state.retryBlock('CLICK', {}, identity())).toBeUndefined();
    expect(state.hasRefutedWork()).toBe(true);
    const second = act(state, { step: 2 });
    state.delivered(second, { delivery: 'delivered' });
    expect(state.hasRefutedWork()).toBe(false);
  });
  it('requires counter-evidence before refuting delivery even when the screen did not change', () => {
    const state = fresh();
    const quiet = act(state);
    state.delivered(quiet, { delivery: 'delivered', delta: { added: [], removed: [], scopeChanged: false } });
    expect(state.reconcile(quiet.id, 'refuted', 'o2', [])).toContain('cited element');
    const loud = act(state, { step: 2, target: identity({ label: 'Other' }) });
    state.delivered(loud, { delivery: 'delivered', delta: { added: ['x'], removed: [], scopeChanged: false } });
    expect(state.reconcile(loud.id, 'refuted', 'o2', [])).toContain('cited element');
    const send = act(state, { step: 3, target: identity({ label: 'Send' }), risk: 'irreversible' });
    state.delivered(send, { delivery: 'delivered' });
    expect(state.reconcile(send.id, 'refuted', 'o2', [])).toContain('cited element');
    const unsure = act(state, { step: 4, target: identity({ label: 'Save' }) });
    state.delivered(unsure, { delivery: 'uncertain' });
    expect(state.reconcile(unsure.id, 'refuted', 'o2', [])).toContain('cited element');
  });
  it('does not withhold view changes or actions that were never delivered', () => {
    const state = fresh();
    state.delivered(act(state, { operation: 'SCROLL', args: { direction: 'down' } }), { delivery: 'delivered' });
    expect(state.retryBlock('SCROLL', { direction: 'down' }, identity())).toBeUndefined();
    state.delivered(act(state), { delivery: 'not_delivered', note: 'stale' });
    expect(state.retryBlock('CLICK', {}, identity())).toBeUndefined();
  });
  it('compares key presses by key and focused recipient', () => {
    const state = fresh();
    const field = identity({ role: 'textfield', label: 'Search' });
    state.delivered(act(state, { operation: 'PRESS', args: { key: 'return' }, target: undefined, recipient: field }), { delivery: 'delivered' });
    expect(state.retryBlock('PRESS', { key: 'return' }, undefined, field)).toBeDefined();
    expect(state.retryBlock('PRESS', { key: 'tab' }, undefined, field)).toBeUndefined();
    expect(state.retryBlock('PRESS', { key: 'return' }, undefined, identity({ role: 'textfield', label: 'Subject' }))).toBeUndefined();
  });
  it('rejects evidence that is only the control the task wrote into', () => {
    const state = fresh();
    const sizeBox = identity({ role: 'combobox', label: 'Font Size' });
    const write = act(state, { operation: 'SET_VALUE', args: { text: '24' }, target: sizeBox, targetLabel: 'Font Size' });
    state.delivered(write, { delivery: 'delivered', readback: { expected: '24', observed: '24' } });
    state.reconcile(write.id, 'confirmed', 'o2', [], 'readback');
    const cited = [{ row: 'e7', text: 'combobox "Font Size" = "24"', identity: sizeBox }];
    expect(state.setStatus('r1', 'evidenced', 'o2', cited)).toContain('typed into');
    expect(state.setStatus('r1', 'evidenced', 'o2', [], [{ kind: 'text_equals', target: sizeBox, value: '24' }])).toContain('typed into');
    expect(state.requirement('r1')!.status).toBe('open');
    const body = [{ row: 'e9', text: 'text "Body" [24 pt]', identity: identity({ role: 'textarea', label: 'Body' }) }];
    expect(state.setStatus('r1', 'evidenced', 'o2', [...cited, ...body])).toBeUndefined();
    expect(state.requirement('r1')!.evidence.map(e => e.row)).toEqual(['text "Body" [24 pt]']);
  });
  it('never accepts a field the task typed into as the only evidence, whatever the planner declared', () => {
    const state = new TaskState('t1', 'Open wikipedia.org');
    state.declare([{ id: 'r1', text: 'wikipedia.org is open', irreversible: false }]);
    const bar = identity({ role: 'textfield', label: 'Address and search bar' });
    const chrome = identity({ role: 'os-window', label: 'Google Chrome', ancestorRoles: [] });
    // The planner claimed the address bar was the subject and typed last: exactly the live failure.
    state.delivered(act(state, { step: 1, operation: 'TYPE', args: { text: 'https://en.wikipedia.org' }, target: bar }), { delivery: 'delivered' });
    const rows = [{ row: 'e12', text: 'textfield "Address and search bar" = "https://en.wikipedia.org"', identity: bar }];
    expect(state.setStatus('r1', 'evidenced', 'o2', rows, [{ kind: 'target_present', target: bar, value: '' }])).toContain('typed into');
    const windowRow = { row: 'w0', text: 'window "Google Chrome" [focused]', identity: chrome };
    expect(state.setStatus('r1', 'evidenced', 'o3', [...rows, windowRow],
      [{ kind: 'text_equals', target: bar, value: 'https://en.wikipedia.org' }, { kind: 'state_present', target: chrome, value: 'focused' }]))
      .toContain('typed into');
    expect(state.allEvidenced()).toBe(false);
    // Delivered work with no other evidence ends as unverified, not as complete.
    expect(state.verificationReady()).toBe(true);
    const page = { row: 'e40', text: 'webarea "Wikipedia"', identity: identity({ role: 'webarea', label: 'Wikipedia' }) };
    expect(state.setStatus('r1', 'evidenced', 'o3', [...rows, windowRow, page])).toBeUndefined();
    expect(state.requirement('r1')!.evidence.map(e => e.row)).toEqual(['webarea "Wikipedia"']);
    // The window's own node carries the page title and is real evidence.
    state.setStatus('r1', 'open', 'o3', []);
    const titled = { row: 'e0', text: 'window "Wikipedia - Google Chrome"', identity: identity({ role: 'window', label: 'Wikipedia - Google Chrome', ancestorRoles: [] }) };
    expect(state.setStatus('r1', 'evidenced', 'o3', [titled])).toBeUndefined();
  });
  it('accepts a typed field only for a requirement declared as text entry, read back, with nothing done after', () => {
    const body = identity({ role: 'textarea', label: 'Note' });
    const row = [{ row: 'e2', text: 'textarea "Note" = "hello"', identity: body }];
    const write = (state: TaskState, readBack: boolean) => {
      const effect = act(state, { step: 1, operation: 'SET_VALUE', args: { text: 'hello' }, target: body });
      state.delivered(effect, { delivery: 'delivered', readback: { expected: 'hello', observed: 'hello' } });
      if (readBack) state.reconcile(effect.id, 'confirmed', 'o2', [], 'readback');
      return effect;
    };
    // Declared as an outcome: the field is not proof, as before.
    const outcome = new TaskState('t1', 'Write hello in the note');
    outcome.declare([{ id: 'r1', text: 'The note says hello', irreversible: false, kind: 'outcome' }]);
    write(outcome, true);
    expect(outcome.setStatus('r1', 'evidenced', 'o2', row)).toContain('typed into');
    // Declared as text entry and read back: the body is the result.
    const entry = new TaskState('t1', 'Write hello in the note');
    entry.declare([{ id: 'r1', text: 'The note says hello', irreversible: false, kind: 'text_entry' }]);
    const written = write(entry, true);
    entry.reconcile(written.id, 'confirmed', 'o3', ['e2']);
    expect(written.reconciledBy?.source).toBe('readback');
    expect(entry.setStatus('r1', 'evidenced', 'o2', row, [{ kind: 'text_equals', target: body, value: 'hello' }])).toBeUndefined();
    expect(entry.allEvidenced()).toBe(true);
    // Not read back: the planner saying so is not enough.
    const unread = new TaskState('t1', 'Write hello in the note');
    unread.declare([{ id: 'r1', text: 'The note says hello', irreversible: false, kind: 'text_entry' }]);
    const effect = write(unread, false);
    unread.reconcile(effect.id, 'confirmed', 'o2', ['e2']);
    expect(unread.setStatus('r1', 'evidenced', 'o2', row)).toContain('typed into');
    // Something else had to be done afterwards: then the field was a means, whatever was declared.
    const submitted = new TaskState('t1', 'Search for hello');
    submitted.declare([{ id: 'r1', text: 'Search for hello', irreversible: false, kind: 'text_entry' }]);
    write(submitted, true);
    submitted.delivered(act(submitted, { step: 2, operation: 'CLICK', target: identity({ label: 'Search' }) }), { delivery: 'delivered' });
    expect(submitted.setStatus('r1', 'evidenced', 'o3', row)).toContain('typed into');
    // The kind is fixed when the requirement is first stated.
    outcome.declare([{ id: 'r1', text: 'The note says hello', irreversible: false, kind: 'text_entry' }]);
    expect(outcome.requirement('r1')!.kind).toBe('outcome');
  });
  it('still accepts a document body after several read-back writes into it', () => {
    const state = new TaskState('t1', 'Write two paragraphs');
    state.declare([{ id: 'r1', text: 'The note has both paragraphs', irreversible: false, kind: 'text_entry' }]);
    const body = identity({ role: 'textarea', label: 'Note' });
    for (const [step, text] of [[1, 'One.'], [2, 'Two.']] as const) {
      const effect = act(state, { step, operation: 'TYPE', args: { text }, target: body });
      state.delivered(effect, { delivery: 'delivered' });
      state.reconcile(effect.id, 'confirmed', 'o' + step, [], 'readback');
    }
    expect(state.setStatus('r1', 'evidenced', 'o3', [{ row: 'e2', text: 'textarea "Note" = "One.Two."', identity: body }],
      [{ kind: 'text_equals', target: body, value: 'One.Two.' }])).toBeUndefined();
  });
  it('keeps a region\'s identities when it is read as its own scope', () => {
    // Covered against a real tree in v2-observation-index.test.ts; here only the matching rule.
    const inRow = (n: number | '*') => identity({ label: 'Delete', ancestorRoles: ['window#*', 'table#0', 'row#' + n] });
    expect(matchIdentity(inRow(1), inRow(1))).toBe('exact');
    expect(matchIdentity(inRow(0), inRow(1))).toBe('weak');
  });
  it('accepts a window as evidence when opening it was the whole requirement', () => {
    const state = new TaskState('t1', 'Open Notes');
    state.declare([{ id: 'r1', text: 'Notes is open', irreversible: false }]);
    const app = identity({ app: 'notes', role: 'application', label: 'Notes', ancestorRoles: [] });
    state.delivered(act(state, { operation: 'OPEN_APP', target: app }), { delivery: 'delivered' });
    const windowRow = { row: 'w0', text: 'window "Notes" [focused]', identity: identity({ app: 'Notes', role: 'os-window', label: 'Notes', ancestorRoles: [] }) };
    expect(state.setStatus('r1', 'evidenced', 'o2', [windowRow])).toBeUndefined();
  });
  it('enters verification only when every open requirement has delivered work, and can end as unverifiable', () => {
    const state = new TaskState('t1', 'Create a tab and name it');
    state.declare([{ id: 'a', text: 'A new tab exists', irreversible: false }, { id: 'b', text: 'It is named', irreversible: false }]);
    expect(state.verificationReady()).toBe(false);
    state.delivered(act(state, { requirementId: 'a' }), { delivery: 'delivered' });
    expect(state.verificationReady()).toBe(false);
    state.delivered(act(state, { requirementId: 'b', target: identity({ label: 'Rename' }) }), { delivery: 'uncertain' });
    expect(state.verificationReady()).toBe(true);
    state.setStatus('a', 'evidenced', 'o3', [{ row: 'e1', text: 'tab "New Tab"' }]);
    expect(state.markUnverifiable('budget').map(r => r.id)).toEqual(['b']);
    expect(state.requirements.map(r => r.status)).toEqual(['evidenced', 'unverifiable']);
  });
  it('does not count opening an application as work on a requirement', () => {
    const state = fresh();
    state.delivered(act(state, { operation: 'OPEN_APP', target: identity({ role: 'application', label: 'Word' }) }), { delivery: 'delivered' });
    expect(state.verificationReady()).toBe(false);
    expect(state.markUnverifiable('budget')).toEqual([]);
  });
  it('survives a round trip through JSON', () => {
    const state = fresh();
    state.delivered(act(state), { delivery: 'delivered' });
    const restored = TaskState.fromJSON(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.retryBlock('CLICK', {}, identity())).toBeDefined();
    expect(restored.declare([{ id: 'late', text: 'Late', irreversible: true }]).join(' ')).toContain('cannot authorise');
  });
});
