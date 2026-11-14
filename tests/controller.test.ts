import { describe, it, expect, vi } from 'vitest';
import {
  NavigationController,
  candidatesFor,
  validateDecision,
} from '../apps/desktop/electron/controller/navigation';
import { LocalTestPolicy, type DecisionProvider } from '../apps/desktop/electron/services/decision-client';
import type { DesktopBridge } from '../apps/desktop/electron/desktop/types';
import type {
  Candidate,
  ControllerState,
  Decision,
  DecisionRequest,
  DesktopDecisionRequest,
  Element,
  PreparedDocument,
  Snapshot,
} from '../packages/contracts/src/index';
const task = {
  mode: 'textedit' as const,
  goal: 'Enter supplied text.',
  text: 'Hello Alex',
  provider: 'local' as const,
  maxSteps: 8,
};
const document: PreparedDocument = { app: 'TextEdit', windowId: 'w-1', windowTitle: 'Test', createdAt: 0 };
class FakeDesktop implements DesktopBridge {
  value = '';
  calls: Candidate[] = [];
  revision = 0;
  supported = true;
  writeHasEffect = true;
  executeGate?: Promise<void>;
  prepare = vi.fn(async () => document);
  health = vi.fn(async () => ({ available: true, accessibility: 'granted' }));
  async snapshot(): Promise<Snapshot> {
    this.revision++;
    return {
      id: 's' + this.revision,
      app: 'TextEdit',
      windowId: 'w-1',
      windowTitle: 'Test',
      complete: true,
      capturedAt: Date.now(),
      elements: [
        {
          ref: '@s' + this.revision + ':e1',
          role: 'textfield',
          name: '',
          value: this.value,
          nativeId: 'First Text View',
          actions: this.supported ? ['SetValue', 'SetFocus'] : [],
          states: [],
        },
      ],
    };
  }
  async execute(candidate: Candidate, text: string, _expected: Element, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.calls.push(candidate);
    await this.executeGate;
    if (candidate.operation === 'SET_VALUE' && this.writeHasEffect) this.value = text;
    return { disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } };
  }
}
function harness(bridge = new FakeDesktop(), provider: DecisionProvider = new LocalTestPolicy()) {
  return { bridge, controller: new NavigationController(bridge, { local: provider, jev: provider }) };
}
async function settled(controller: NavigationController): Promise<ControllerState> {
  await vi.waitFor(() => expect(controller.state().busy).toBe(false));
  return controller.state();
}
describe('Navigation controller', () => {
  it('verifies observed text, not command success', async () => {
    const { bridge, controller } = harness();
    controller.start(task);
    const result = await settled(controller);
    expect(result.status).toBe('completed');
    expect(result.verifiedText).toBe(task.text);
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.revision).toBeGreaterThan(1);
  });
  it('does not replay a delivered write that cannot be verified', async () => {
    const bridge = new FakeDesktop();
    bridge.writeHasEffect = false;
    const { controller } = harness(bridge);
    controller.start(task);
    expect((await settled(controller)).status).toBe('failed');
    expect(bridge.calls).toHaveLength(1);
  });
  it('preserves unexpected existing content', async () => {
    const bridge = new FakeDesktop();
    bridge.value = 'User edited this';
    const { controller } = harness(bridge);
    controller.start(task);
    expect((await settled(controller)).status).toBe('failed');
    expect(bridge.calls).toHaveLength(0);
    expect(bridge.value).toBe('User edited this');
  });
  it('rejects decisions from an old snapshot', async () => {
    const provider: DecisionProvider = {
      decide: async (request) => ({
        taskId: request.taskId,
        snapshotId: 'stale',
        candidateId: 'write_document',
        confidence: 1,
        provider: 'local',
        model: 'fixture',
      }),
    };
    const { bridge, controller } = harness(undefined, provider);
    controller.start(task);
    expect((await settled(controller)).status).toBe('failed');
    expect(bridge.calls).toHaveLength(0);
  });
  it('executes a valid low-score choice and verifies its result', async () => {
    const local = new LocalTestPolicy();
    const provider: DecisionProvider = {
      decide: async (request, signal) => ({ ...(await local.decide(request, signal)), confidence: 0.3 }),
    };
    const { bridge, controller } = harness(undefined, provider);
    controller.start(task);
    expect((await settled(controller)).status).toBe('completed');
    expect(bridge.calls).toHaveLength(1);
  });
  it('ignores a provider result arriving after cancellation', async () => {
    let release!: (decision: Decision) => void;
    let pending!: DecisionRequest | DesktopDecisionRequest;
    const provider: DecisionProvider = {
      decide: (request) => {
        pending = request;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const { bridge, controller } = harness(undefined, provider);
    controller.start(task);
    await vi.waitFor(() => expect(controller.state().status).toBe('deciding'));
    controller.cancel();
    release({
      taskId: pending.taskId,
      snapshotId: pending.snapshotId,
      candidateId: 'write_document',
      confidence: 1,
      provider: 'local',
      model: 'fixture',
    });
    expect((await settled(controller)).status).toBe('cancelled');
    expect(bridge.calls).toHaveLength(0);
  });
  it('waits for dispatched native input and prevents a concurrent task', async () => {
    let release!: () => void;
    const bridge = new FakeDesktop();
    bridge.executeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller } = harness(bridge);
    controller.start(task);
    await vi.waitFor(() => expect(bridge.calls).toHaveLength(1));
    controller.cancel();
    expect(controller.state().status).toBe('stopping');
    expect(() => controller.start(task)).toThrow('still running');
    release();
    const state = await settled(controller);
    expect(state.status).toBe('cancelled');
    expect(state.snapshot?.elements[0].value).toBe(task.text);
    expect(bridge.calls).toHaveLength(1);
  });
  it('pauses after a focus step and resumes with a fresh observation', async () => {
    let count = 0;
    const provider: DecisionProvider = {
      decide: async (request) => ({
        taskId: request.taskId,
        snapshotId: request.snapshotId,
        candidateId: ++count === 1 ? 'focus_document' : 'write_document',
        confidence: 1,
        provider: 'local',
        model: 'fixture',
      }),
    };
    const { bridge, controller } = harness(undefined, provider);
    controller.start(task, true);
    expect((await settled(controller)).status).toBe('paused');
    controller.resume(true);
    expect((await settled(controller)).status).toBe('completed');
    expect(bridge.calls[0].targetRef).not.toBe(bridge.calls[1].targetRef);
  });
  it('does not expose unrelated controls as action candidates', async () => {
    const snapshot = await new FakeDesktop().snapshot();
    snapshot.elements.push({
      ref: '@s1:e8',
      role: 'button',
      name: 'Delete',
      value: '',
      actions: ['Click'],
      states: [],
    });
    expect(candidatesFor(snapshot).some((candidate) => candidate.targetRef === '@s1:e8')).toBe(false);
  });
  it('rejects unknown target choices even with high confidence', async () => {
    const snapshot = await new FakeDesktop().snapshot();
    expect(() =>
      validateDecision(
        {
          taskId: '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe',
          snapshotId: snapshot.id,
          candidateId: 'delete_everything',
          confidence: 1,
          provider: 'local',
          model: 'fixture',
        },
        '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe',
        snapshot,
        candidatesFor(snapshot),
      ),
    ).toThrow('outside');
  });
});

describe('Interrupt and replace', () => {
  it('waits for the dispatched action to settle before starting a fresh task', async () => {
    const bridge = new FakeDesktop();
    bridge.prepare.mockImplementation(async () => { bridge.value = ''; return document; });
    let release!: () => void;
    bridge.executeGate = new Promise<void>(resolve => { release = resolve; });
    const { controller } = harness(bridge);
    const old = controller.start(task);
    await vi.waitFor(() => expect(bridge.calls).toHaveLength(1));
    const replacement = controller.replace({ ...task, text: 'Next task' });
    expect(controller.state().status).toBe('stopping');
    expect(controller.state().taskId).toBe(old.taskId);
    expect(bridge.prepare).toHaveBeenCalledTimes(1);
    await expect(controller.replace(task)).rejects.toThrow('already pending');
    release();
    const next = await replacement;
    expect(next.taskId).not.toBe(old.taskId);
    const done = await settled(controller);
    expect(done.status).toBe('completed');
    expect(done.verifiedText).toBe('Next task');
    expect(bridge.calls).toHaveLength(2);
    expect(bridge.prepare).toHaveBeenCalledTimes(2);
  });
  it('lets Stop cancel a replacement that is waiting for an old action', async () => {
    const bridge = new FakeDesktop();
    let release!: () => void;
    bridge.executeGate = new Promise<void>(resolve => { release = resolve; });
    const { controller } = harness(bridge);
    const old = controller.start(task);
    await vi.waitFor(() => expect(bridge.calls).toHaveLength(1));
    const pending = controller.replace({ ...task, text: 'Must not start' });
    const rejected = expect(pending).rejects.toThrow('Replacement cancelled');
    controller.cancel();
    release();
    await rejected;
    expect(controller.state().taskId).toBe(old.taskId);
    expect((await settled(controller)).status).toBe('cancelled');
    expect(bridge.calls).toHaveLength(1);
  });
  it('validates a replacement before cancelling the active task', async () => {
    const bridge = new FakeDesktop();
    let release!: () => void;
    bridge.executeGate = new Promise<void>(resolve => { release = resolve; });
    const { controller } = harness(bridge);
    controller.start(task);
    await vi.waitFor(() => expect(bridge.calls).toHaveLength(1));
    await expect(controller.replace({ ...task, text: '' })).rejects.toThrow('exact text');
    expect(controller.state().status).not.toBe('stopping');
    controller.cancel(); release(); await settled(controller);
  });
  it('discards late old inference before handing control to the replacement', async () => {
    let release!: (value: Decision) => void;
    let pending!: DecisionRequest | DesktopDecisionRequest;
    let calls = 0;
    const local = new LocalTestPolicy();
    const provider: DecisionProvider = { decide: (request, signal) => {
      if (++calls > 1) return local.decide(request, signal);
      pending = request;
      return new Promise(resolve => { release = resolve; });
    } };
    const { controller, bridge } = harness(undefined, provider);
    controller.start(task);
    await vi.waitFor(() => expect(controller.state().status).toBe('deciding'));
    const replacement = controller.replace({ ...task, text: 'New inference' });
    release({ taskId: pending.taskId, snapshotId: pending.snapshotId, candidateId: 'write_document',
      confidence: 1, provider: 'local', model: 'fixture' });
    await replacement;
    expect((await settled(controller)).verifiedText).toBe('New inference');
    expect(bridge.calls).toHaveLength(1);
  });
});
