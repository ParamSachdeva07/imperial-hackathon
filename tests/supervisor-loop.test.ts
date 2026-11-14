import { describe, expect, it, vi } from 'vitest';
import { DesktopLoop, type LoopHost } from '../apps/desktop/electron/controller/desktop-loop';
import { NavigationController } from '../apps/desktop/electron/controller/navigation';
import { NativeError } from '../apps/desktop/electron/desktop/native-client';
import { TaskInputSchema, type DesktopCandidate, type DesktopContext, type DesktopObservation,
  type SupervisorGuidance, type SupervisorRequest, type DesktopDecisionRequest } from '../packages/contracts/src/index';
import type { DecisionProvider } from '../apps/desktop/electron/services/decision-client';
import type { WorkspaceBridge } from '../apps/desktop/electron/desktop/workspace';
import type { ActionReport } from '../apps/desktop/electron/desktop/action-verification';
import { accessibilityTree, flattenTree } from '../apps/desktop/electron/desktop/accessibility-tree';

const taskId = 'fdfd5667-e910-45b4-a0dc-0d7156c024ab';
const input = TaskInputSchema.parse({ provider: 'jev', goal: 'Create a document and write a greeting.',
  supervisorEnabled: true, supervisorEvery: 2, maxSteps: 160 });
function plan(r: SupervisorRequest, changes: Partial<SupervisorGuidance> = {}): SupervisorGuidance {
  return { taskId: r.taskId, snapshotId: r.snapshotId, status: 'continue', subgoal: input.goal,
    plan: ['Create a document', 'Write the greeting'], memory: [], inputs: [],
    expectedOutcome: { kind: 'observed_state', description: 'The requested document is populated.',
      target: { app: '', windowTitle: '', role: '', name: '' }, value: '', checks: [] },
    evidence: [], rationale: 'Read and act on the observed controls.', ...changes };
}
class Workspace implements WorkspaceBridge {
  revision = 0;
  created = false;
  value = '';
  uncertainCreate = false;
  report?: ActionReport;
  calls: DesktopCandidate[] = [];
  contexts: DesktopContext[] = [];
  applications = async () => [{ name: 'Editor', id: 'editor', running: true }];
  async observe(context: DesktopContext): Promise<DesktopObservation> {
    this.contexts.push(context);
    const n = ++this.revision;
    return { id: 'o' + n, capturedAt: n * 1000, context: { app: 'Editor', windowId: 'same-window', surface: 'window' },
      applications: await this.applications(), windows: [{ app: 'Editor', id: 'same-window', title: 'Editor', focused: true }], notices: [],
      snapshots: [{ id: 's' + n, app: 'Editor', windowId: 'same-window', windowTitle: 'Editor', complete: true,
        capturedAt: n * 1000, text: [this.created ? 'New document editor' : 'Start screen', 'Body=' + this.value],
        elements: [
          { ref: `@s${n}:e1`, role: 'button', name: 'Create', value: '', states: [], actions: ['Click'] },
          ...(this.created ? [{ ref: `@s${n}:e2`, role: 'textfield', name: 'Body', value: this.value, states: [], actions: ['SetValue'] }] : []),
        ] }] };
  }
  async act(c: DesktopCandidate, o: DesktopObservation, text?: string) {
    this.calls.push(c);
    this.report = undefined;
    if (c.operation === 'CLICK') {
      this.created = true;
      if (this.uncertainCreate) throw new NativeError('ACTION_FAILED', 'AXPress did not establish a verifiable effect',
        { delivery: 'uncertain', retry: 'inspect' });
    }
    if (c.operation === 'SET_VALUE') {
      this.value = text!;
      this.report = { operation: c.operation, target: c.name, delivery: 'delivered_verified', verification: 'verified', observedValue: text };
    }
    return o.context;
  }
  takeActionReport() { const report = this.report; this.report = undefined; return report; }
}
function harness(workspace: Workspace, provider: DecisionProvider, options = {}) {
  const state = { ...new NavigationController({} as any, {} as any).state(), taskId, input: { ...input, ...options }, busy: true };
  const host: LoopHost = { state, status: (status) => { state.status = status; }, event: vi.fn() };
  return { host, state, loop: new DesktopLoop(workspace, provider), signal: new AbortController().signal };
}
const decision = (r: any, id: string) => ({ taskId: r.taskId, snapshotId: r.snapshotId,
  candidateId: id, confidence: 0.001, goalConfidence: 0.001, goalStatus: 'completed' as const, provider: 'jev' as const, model: 'fixture' });

describe('Persistent supervisor and Jev execution', () => {
  it('lets a read proceed when a positive Noul cannot verify a pending predicate', async () => {
    const workspace = new Workspace(); workspace.created = true;
    let calls = 0;
    const provider: DecisionProvider = {
      supervise: async r => plan(r, { status: 'completed', expectedOutcome: {
        kind: 'text_equals', description: 'Read the result',
        target: { app: 'Editor', windowTitle: '', role: 'textfield', name: 'Unread result' }, value: 'Hello', checks: [] } }),
      decide: async request => {
        const r = request as DesktopDecisionRequest;
        if (++calls === 1) return { ...decision(r, 'DONE'), goalCompletionProbability: .99 };
        expect(r.completionNeedsEvidence).toBe(true);
        return { ...decision(r, r.candidates.find(c => c.operation === 'WAIT')!.id), goalCompletionProbability: .99 };
      },
    };
    const h = harness(workspace, provider, { maxSteps: 3, supervisorEvery: 50 });
    await h.loop.advance(h.host, false, h.signal);
    expect(workspace.calls.map(c => c.operation)).toEqual(['WAIT', 'WAIT']);
    expect(h.state.status).not.toBe('completed');
  });
  it('uses the batched Noul to skip action checkpoints and intercept a conflicting mutation at completion', async () => {
    const workspace = new Workspace();
    const reviews: SupervisorRequest[] = [];
    const provider: DecisionProvider = {
      supervise: async r => {
        reviews.push(r);
        return plan(r, { status: workspace.value === 'Hello' ? 'completed' : 'continue',
          inputs: [{ id: 'greeting', text: 'Hello' }],
          expectedOutcome: { kind: 'text_equals', description: 'Greeting in the new document.',
            target: { app: 'Editor', windowTitle: '', role: 'textfield', name: 'Body' }, value: 'Hello', checks: [] } });
      },
      decide: async request => {
        const r = request as DesktopDecisionRequest;
        // A stale action choice would create again even though the Noul says done.
        const operation = workspace.created && !workspace.value ? 'SET_VALUE' : 'CLICK';
        if (workspace.created) expect(r.actionResult).toBeDefined();
        return { ...decision(r, r.candidates.find(c => c.operation === operation)!.id),
          goalCompletionProbability: workspace.value ? .99 : .01 };
      },
    };
    const h = harness(workspace, provider, { supervisorEvery: 50 });
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('completed');
    expect(workspace.calls.map(c => c.operation)).toEqual(['CLICK', 'SET_VALUE']);
    expect(workspace.value).toBe('Hello');
    expect(reviews.map(r => r.reason)).toEqual(['initial', 'completion']);
    expect(h.state.step).toBe(3);
  });

  it('reconciles an exactly undecided Noul without dispatching its proposed mutation', async () => {
    const workspace = new Workspace();
    const provider: DecisionProvider = {
      supervise: async r => plan(r, { status: r.reason === 'completion' ? 'blocked' : 'continue' }),
      decide: async r => ({ ...decision(r, r.candidates.find(c => c.operation === 'CLICK')!.id), goalCompletionProbability: .5 }),
    };
    const h = harness(workspace, provider);
    await h.loop.advance(h.host, false, h.signal);
    expect(workspace.calls).toHaveLength(0);
    expect(h.state.status).toBe('blocked');
  });

  it.each([1, 2])('reconciles creation before another mutation, while allowing %i requested objects', async count => {
    const workspace = new Workspace();
    const reviews: SupervisorRequest[] = [];
    const creates = () => workspace.calls.filter(c => c.operation === 'CLICK').length;
    const provider: DecisionProvider = {
      supervise: async r => {
        reviews.push(r);
        if (creates()) {
          expect(r.reason).toBe('action_result');
          expect(r.observation.actionResult?.operation).toBe('CLICK');
          expect(r.observation.actionResult?.after.join()).toContain('Editor');
        }
        return plan(r, { status: creates() === count ? 'completed' : 'continue',
          subgoal: `Create ${count} objects; ${creates()} created.` });
      },
      decide: async request => {
        const r = request as DesktopDecisionRequest;
        if (creates() === count) {
          expect(r.candidates.every(c => !['CLICK', 'PRESS', 'SET_VALUE'].includes(c.operation))).toBe(true);
          expect(r.completionNeedsEvidence).toBe(false);
          return decision(r, 'DONE');
        }
        return decision(r, r.candidates.find(c => c.operation === 'CLICK')!.id);
      },
    };
    // The second explicit creation has the same visible before-state as the
    // first result: permission comes from remaining intent, not a UI hash.
    const h = harness(workspace, provider, { supervisorEvery: 50 });
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('completed');
    expect(creates()).toBe(count);
    expect(h.state.step).toBe(count + 1);
    expect(reviews).toHaveLength(count + 1);
  });
  it('does not request another completion review for unchanged evidence after the supervisor asks for more work', async () => {
    const workspace = new Workspace();
    const reviews: SupervisorRequest[] = [];
    const provider: DecisionProvider = {
      supervise: async r => { reviews.push(r); return plan(r, { subgoal: 'Inspect the requested result.' }); },
      decide: async request => {
        const r = request as DesktopDecisionRequest;
        if (r.step === 1) return decision(r, 'DONE');
        expect(r.completionNeedsEvidence).toBe(true);
        return decision(r, r.candidates.find(c => c.operation === 'WAIT')!.id);
      },
    };
    const h = harness(workspace, provider, { maxSteps: 3, supervisorEvery: 50 });
    await h.loop.advance(h.host, false, h.signal);
    expect(reviews.map(r => r.reason)).toEqual(['initial', 'completion']);
    expect(h.state.status).not.toBe('completed');
  });
  it('reviews a new blocking dialog immediately even with a long periodic interval', async () => {
    const workspace = new Workspace();
    const observe = workspace.observe.bind(workspace);
    workspace.observe = async context => {
      const result = await observe(context);
      if (workspace.created) {
        const raw = { role: 'window', children: [{ role: 'sheet', name: 'Keep changes', children: [
          { role: 'textfield', name: 'Filename', ref_id: `@s${workspace.revision}:e2`, states: ['focused'], available_actions: ['SetValue'] },
          { role: 'button', name: 'Keep editing', ref_id: `@s${workspace.revision}:e3`, available_actions: ['Click'] },
        ] }] };
        result.snapshots[0].tree = accessibilityTree(raw);
        result.snapshots[0].elements = flattenTree(raw);
      }
      return result;
    };
    const reviews: SupervisorRequest[] = [];
    const provider: DecisionProvider = {
      supervise: async r => { reviews.push(r); return plan(r); },
      decide: async request => {
        const r = request as DesktopDecisionRequest;
        if (!workspace.created) return decision(r, r.candidates.find(c => c.operation === 'CLICK')!.id);
        expect(reviews.at(-1)?.reason).toBe('interruption');
        expect(r.candidates.some(c => c.name === 'Keep editing' && c.operation === 'CLICK')).toBe(true);
        return decision(r, r.candidates.find(c => c.operation === 'WAIT')!.id);
      },
    };
    const h = harness(workspace, provider, { maxSteps: 2, supervisorEvery: 50 });
    await h.loop.advance(h.host, false, h.signal);
    expect(reviews.map(r => r.reason)).toEqual(['initial', 'interruption']);
  });
  it('reconciles uncertain creation in the same window, supplies generated text, and never repeats Create', async () => {
    const workspace = new Workspace(); workspace.uncertainCreate = true;
    const reviews: SupervisorRequest[] = [];
    const provider: DecisionProvider = {
      supervise: async r => {
        reviews.push(r);
        if (!workspace.created) return plan(r, { subgoal: 'Create the requested document.' });
        const complete = workspace.value === 'Hello, how are you?';
        return plan(r, { status: complete ? 'completed' : 'continue', subgoal: 'Write the greeting in the new document.',
          memory: ['Creation already succeeded in the existing window. Do not repeat it.'],
          inputs: [{ id: 'greeting', text: 'Hello, how are you?' }],
          expectedOutcome: { kind: 'text_equals', description: 'Body contains the greeting once.',
            target: { app: 'Editor', windowTitle: 'Editor', role: 'textfield', name: 'Body' }, value: 'Hello, how are you?', checks: [] },
          evidence: complete ? ['Body=Hello, how are you?'] : ['New document editor'] });
      },
      decide: async request => {
        const r = request as DesktopDecisionRequest;
        expect(r.taskId).toBe(taskId);
        expect(r.supervisor).toBeTruthy();
        if (!workspace.created) return decision(r, r.candidates.find(c => c.operation === 'CLICK')!.id);
        expect(r.candidates.some(c => c.operation === 'CLICK' && c.name === 'Create')).toBe(false);
        if (!workspace.value) return decision(r, r.candidates.find(c => c.operation === 'SET_VALUE' && c.inputId === 'greeting')!.id);
        return decision(r, 'DONE');
      },
    };
    const h = harness(workspace, provider);
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('completed');
    expect(workspace.calls.map(c => c.operation)).toEqual(['CLICK', 'SET_VALUE']);
    expect(workspace.value).toBe('Hello, how are you?');
    expect(reviews.map(r => r.reason)).toContain('uncertain_action');
    expect(reviews.find(r => r.reason === 'uncertain_action')?.previous?.subgoal).toContain('Create');
    expect(workspace.contexts).toContainEqual({ app: 'Editor', surface: 'window' });
    expect(h.state.step).toBe(3);
  });

  it('supports more than 40 decisions and reviews at the configured interval without resetting the task', async () => {
    const workspace = new Workspace(); const reviews: SupervisorRequest[] = [];
    const provider: DecisionProvider = {
      supervise: async r => { reviews.push(r); return plan(r); },
      decide: async r => decision(r, (r as DesktopDecisionRequest).candidates.find(c => c.operation === 'WAIT')!.id),
    };
    const h = harness(workspace, provider, { maxSteps: 45, supervisorEvery: 10 });
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.step).toBe(45);
    expect(h.state.status).toBe('blocked');
    expect(reviews[0].reason).toBe('initial');
    expect(reviews.every(r => r.taskId === taskId && r.step <= 45)).toBe(true);
    expect(reviews.some(r => r.reason === 'no_progress')).toBe(true);
    expect(reviews.slice(1).every(r => r.previous?.taskId === taskId)).toBe(true);
  });

  it('invokes periodic review even when each read choice is different', async () => {
    const workspace = new Workspace(); const reviews: SupervisorRequest[] = [];
    const provider: DecisionProvider = {
      supervise: async r => { reviews.push(r); return plan(r); },
      decide: async r => decision(r, (r as DesktopDecisionRequest).candidates.filter(c => c.operation === 'READ_SURFACE')[r.step % 4].id),
    };
    const h = harness(workspace, provider, { maxSteps: 6, supervisorEvery: 2 });
    await h.loop.advance(h.host, false, h.signal);
    expect(reviews.map(r => [r.reason, r.step])).toEqual([['initial', 1], ['interval', 3], ['interval', 5]]);
  });

  it('rejects stale supervisor output before any mutation', async () => {
    const workspace = new Workspace();
    const provider: DecisionProvider = { supervise: async r => plan(r, { snapshotId: 'old' }), decide: vi.fn() };
    const h = harness(workspace, provider);
    await expect(h.loop.advance(h.host, false, h.signal)).rejects.toThrow('stale supervisor');
    expect(workspace.calls).toHaveLength(0);
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('does not execute a decision after cancellation during supervisor inference', async () => {
    const workspace = new Workspace(); const abort = new AbortController();
    const provider: DecisionProvider = { supervise: async r => { abort.abort(); return plan(r); }, decide: vi.fn() };
    const h = harness(workspace, provider);
    await expect(h.loop.advance(h.host, false, abort.signal)).rejects.toThrow();
    expect(workspace.calls).toHaveLength(0);
  });

  it('does not mark the overall task done while the supervisor identifies remaining work', async () => {
    const workspace = new Workspace();
    const provider: DecisionProvider = { supervise: async r => plan(r, { subgoal: 'Inspect the still missing result.' }),
      decide: async r => decision(r, 'DONE') };
    const h = harness(workspace, provider, { maxSteps: 4 });
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('blocked');
    expect(h.state.completion).toBeFalsy();
  });
});
