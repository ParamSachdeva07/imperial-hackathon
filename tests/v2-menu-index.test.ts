import { beforeAll, describe, expect, it } from 'vitest';
import { accessibilityTree, flattenTree } from '../apps/desktop/electron/desktop/accessibility-tree';
import type { WorkspaceBridge } from '../apps/desktop/electron/desktop/workspace';
import type { DecisionProvider } from '../apps/desktop/electron/services/decision-client';
import { MenuIndex } from '../apps/desktop/electron/controller/v2/menu-index';
import { PlannerLoop, V2_LIMITS, type PlannerHost } from '../apps/desktop/electron/controller/v2/planner-loop';
import { TaskInputSchema, type ControllerState, type DesktopCandidate, type DesktopContext, type DesktopObservation,
  type PlanRequest, type PlanStep } from '../packages/contracts/src/index';

beforeAll(() => { V2_LIMITS.settleIntervalMs = 1; V2_LIMITS.settleCapMs = 30; });
const taskId = '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe';

class MenuDesk implements WorkspaceBridge {
  revision = 0; menuReads = 0; documents = 1; failMenu = false;
  acts: { operation: string; name: string; surface?: string; ref?: string }[] = [];
  applications = async () => [{ name: 'Notes', id: 'notes', running: true }];
  async observe(context: DesktopContext): Promise<DesktopObservation> {
    const s = ++this.revision;
    const menubar = context.surface === 'menubar';
    if (menubar) { this.menuReads++; if (this.failMenu) throw new Error('menu bar unavailable'); }
    const item = (name: string, n: number, extra: Record<string, unknown> = {}, children: unknown[] = []) =>
      ({ role: 'menuitem', name, ref_id: '@s' + s + ':e' + n, available_actions: ['Click'], states: [], children, ...extra });
    const raw = menubar
      ? { role: 'menu', children: [item('File', 1, {}, [{ role: 'menu', name: 'File', children: [
          item('New Note', 2), item('Export as PDF…', 3), item('Print…', 4, { states: ['disabled'] })] }]), item('Edit', 5)] }
      : { role: 'window', name: 'Notes', ref_id: '@s' + s + ':e1', available_actions: [], states: [], children: [
          { role: 'statictext', name: 'Note count', value: String(this.documents) }] };
    return { id: 'o' + s, capturedAt: s, applications: await this.applications(), notices: [],
      windows: [{ id: 'w1', title: 'Notes', app: 'Notes', focused: true }],
      context: { app: 'Notes', windowId: 'w1', surface: menubar ? 'menubar' : 'window' },
      snapshots: [{ id: 's' + s, app: 'Notes', windowId: menubar ? '' : 'w1', windowTitle: menubar ? '' : 'Notes',
        surface: menubar ? 'menubar' : 'window', complete: true, capturedAt: s, tree: accessibilityTree(raw), elements: flattenTree(raw) }] };
  }
  async act(candidate: DesktopCandidate, observation: DesktopObservation) {
    const snapshot = observation.snapshots.find(sn => sn.id === candidate.snapshotId);
    if (!snapshot?.elements.some(e => e.ref === candidate.targetRef)) throw new Error('Action target is outside its snapshot.');
    this.acts.push({ operation: candidate.operation, name: candidate.name, surface: snapshot.surface, ref: candidate.targetRef });
    if (candidate.name === 'New Note') this.documents++;
    return observation.context;
  }
}

describe('menu command index', () => {
  it('indexes nested commands once, with their path, and skips disabled ones', async () => {
    const desk = new MenuDesk(), menu = new MenuIndex(), signal = new AbortController().signal;
    const nodes = await menu.nodes('Notes', desk, signal);
    expect(nodes.map(n => n.label)).toEqual(['File', 'New Note', 'Export as PDF…', 'Edit']);
    expect(nodes.find(n => n.label === 'New Note')).toMatchObject({ kind: 'menu', path: ['Menu bar', 'File'], operations: ['CLICK'] });
    expect(nodes.every(n => n.id.startsWith('m'))).toBe(true);
    await menu.nodes('Notes', desk, signal);
    expect(desk.menuReads).toBe(1);
    menu.invalidate('Notes');
    await menu.nodes('Notes', desk, signal);
    expect(desk.menuReads).toBe(2);
  });
  it('never fails a task when the menu bar cannot be read', async () => {
    const desk = new MenuDesk();
    desk.failMenu = true;
    expect(await new MenuIndex().nodes('Notes', desk, new AbortController().signal)).toEqual([]);
  });
  it('offers a menu command that is not in the window and dispatches it against the menu bar snapshot', async () => {
    const desk = new MenuDesk();
    const requests: PlanRequest[] = [];
    const provider: DecisionProvider = { decide: async () => { throw new Error('unused'); }, plan: async request => {
      requests.push(request);
      const base = { taskId: request.taskId, observationId: request.observationId, model: 'scripted',
        requirements: [{ id: 'r1', text: 'A new note exists', irreversible: false, kind: 'outcome' as const }], reconciliations: [], statuses: [],
        requirementId: '', operation: '', target: '', targetDescription: '', text: '', textIsLiteral: false, key: '', direction: '',
        risk: 'reversible', repeat: false, expect: '', query: '', scope: '', waitMs: 0, message: '' };
      const count = request.elements.find(e => e.label === 'Note count')!;
      return (requests.length === 1
        ? { ...base, kind: 'act', requirementId: 'r1', operation: 'CLICK', target: request.elements.find(e => e.label === 'New Note')!.id, expect: 'count is 2' }
        : { ...base, kind: 'finish', reconciliations: [{ effectId: 'fx1', outcome: 'confirmed', evidence: [count.id] }],
            statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [count.id], checks: [{ kind: 'text_equals', target: count.id, value: '2' }] }] }) as PlanStep;
    } };
    const state: ControllerState = { taskId, status: 'idle', busy: true, document: null, snapshot: null, decision: null, step: 0,
      verifiedText: null, events: [], input: TaskInputSchema.parse({ provider: 'jev', goal: 'Create a new note', app: 'Notes', controller: 'v2', maxSteps: 10 }) };
    const host: PlannerHost = { state, status: status => { state.status = status; }, event: () => {} };
    await new PlannerLoop(desk, provider).advance(host, false, new AbortController().signal);
    const offered = requests[0].elements.find(e => e.label === 'New Note')!;
    expect(offered.tags).toContain('menu');
    expect(offered.path).toBe('Menu bar > File');
    expect(desk.acts).toEqual([{ operation: 'CLICK', name: 'New Note', surface: 'menubar', ref: expect.stringMatching(/^@s\d+:e2$/) }]);
    expect(requests[1].observation.surface).toBe('window');
    expect(state.status).toBe('completed');
  });
});
