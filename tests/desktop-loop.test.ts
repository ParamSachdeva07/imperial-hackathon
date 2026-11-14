import { describe, expect, it, vi } from 'vitest';
import { DesktopLoop, type LoopHost } from '../apps/desktop/electron/controller/desktop-loop';
import { desktopCandidates } from '../apps/desktop/electron/controller/desktop-candidates';
import { decisionPage } from '../apps/desktop/electron/controller/decision-context';
import {
  exactInputs,
} from '../apps/desktop/electron/controller/task-instructions';
import { NavigationController } from '../apps/desktop/electron/controller/navigation';
import {
  TaskInputSchema,
  type DesktopContext,
  type DesktopObservation,
  type DesktopCandidate,
  type Decision,
} from '../packages/contracts/src/index';
import type { WorkspaceBridge } from '../apps/desktop/electron/desktop/workspace';
import type { DecisionProvider } from '../apps/desktop/electron/services/decision-client';
import { NativeError } from '../apps/desktop/electron/desktop/native-client';
const id = '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe';
const input = TaskInputSchema.parse({ goal: 'Click Apply.', provider: 'jev', maxSteps: 12 });
function observation(count = 1, revision = 1): DesktopObservation {
  return {
    id: 'observation-' + revision,
    capturedAt: revision * 1000,
    context: { app: 'Example', windowId: 'w1', surface: 'window' },
    applications: [
      { name: 'Example', id: 'example', running: true },
      { name: 'Another', id: 'another', running: false },
    ],
    windows: [{ app: 'Example', id: 'w1', title: 'Example', focused: false }],
    notices: [],
    snapshots: [
      {
        id: 's' + revision,
        app: 'Example',
        windowId: 'w1',
        windowTitle: 'Example',
        surface: 'window',
        complete: true,
        capturedAt: revision * 1000,
        text: ['Current result: pending'],
        elements: Array.from({ length: count }, (_, n) => ({
          ref: '@s' + revision + ':e' + (n + 1),
          role: 'button',
          name: 'Apply ' + n,
          value: '',
          states: [],
          actions: ['Click'],
        })),
      },
    ],
  };
}
class FakeWorkspace implements WorkspaceBridge {
  revision = 0;
  calls: DesktopCandidate[] = [];
  texts: (string | undefined)[] = [];
  count = 1;
  change = true;
  complete = true;
  applications = async () => observation().applications;
  async observe(_context: DesktopContext) {
    const o = observation(this.count, ++this.revision);
    o.snapshots[0].complete = this.complete;
    if (this.calls.length && this.change) o.snapshots[0].text = ['Current result: applied'];
    return o;
  }
  async act(candidate: DesktopCandidate, o: DesktopObservation, text?: string) {
    this.calls.push(candidate);
    this.texts.push(text);
    return o.context;
  }
}
function harness(choose: (request: any) => Partial<Decision>, bridge = new FakeWorkspace()) {
  const state = { ...new NavigationController({} as any, {} as any).state(), input, taskId: id, busy: true };
  const host: LoopHost = {
    state,
    status: (status, _message) => {
      state.status = status;
    },
    event: vi.fn(),
  };
  const provider: DecisionProvider = {
    decide: async (r) => ({
      taskId: r.taskId,
      snapshotId: r.snapshotId,
      candidateId: 'STOP',
      confidence: 1,
      provider: 'jev',
      model: 'fixture',
      ...choose(r),
    }),
  };
  return {
    state,
    host,
    bridge,
    provider,
    loop: new DesktopLoop(bridge, provider),
    signal: new AbortController().signal,
  };
}
describe('Desktop action loop', () => {
  it('keeps ancestor and playback context visible on every wide sibling page', () => {
    const o = observation(240);
    o.snapshots[0].contextText = ['Ancestor context: main', 'Pause available; playback position 12'];
    const candidates = desktopCandidates(o, input);
    for (const index of [0, 1, 2]) {
      const request = decisionPage(o, candidates, input, id, 1, index, new Set([index]), []);
      expect(request.observations[0].text).toEqual(expect.arrayContaining(o.snapshots[0].contextText));
      expect(request.candidates.length).toBeLessThanOrEqual(240);
    }
  });
  it('keeps completed actions in context across long stretches of read-only traversal', () => {
    const history = ['Example: FOCUS_AND_PASTE Search: verified value=topic',
      ...Array.from({ length: 50 }, (_, i) => 'Read tree branch: wrapper ' + i + '; no desktop input sent.')];
    const request = decisionPage(observation(), [], input, id, 1, 0, new Set([0]), history);
    expect(request.history[0]).toContain('verified value=topic');
    expect(request.history.at(-1)).toContain('wrapper 49');
    expect(request.history.length).toBeLessThanOrEqual(40);
  });
  it('reobserves a paste precondition failure proven to happen before input, then asks for a fresh decision', async () => {
    const bridge = new FakeWorkspace();
    const act = vi.spyOn(bridge, 'act').mockRejectedValueOnce(new NativeError('PASTE_PRECONDITION', 'Editor moved',
      { delivery: 'not_delivered', retry: 'inspect' }, { pasteAttempted: false }));
    let decisions = 0;
    const seen: string[] = [];
    const h = harness(r => {
      seen.push(r.snapshotId);
      if (++decisions <= 2) return { candidateId: r.candidates.find((c: DesktopCandidate) => c.operation === 'CLICK').id };
      return { candidateId: 'DONE', goalStatus: 'completed' };
    }, bridge);
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('completed');
    expect(act).toHaveBeenCalledTimes(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(bridge.calls).toHaveLength(1);
  });
  it('never replays a paste whose delivery may have occurred', async () => {
    const bridge = new FakeWorkspace();
    const act = vi.spyOn(bridge, 'act').mockRejectedValue(new NativeError('PASTE_PRECONDITION', 'Unknown delivery',
      { delivery: 'uncertain', retry: 'inspect' }, { pasteAttempted: true }));
    const h = harness(r => ({ candidateId: r.candidates.find((c: DesktopCandidate) => c.operation === 'CLICK').id }), bridge);
    await expect(h.loop.advance(h.host, false, h.signal)).rejects.toThrow('Unknown delivery');
    expect(act).toHaveBeenCalledTimes(1);
  });
  it('paginates choices without dropping later tree controls', () => {
    const o = observation(240),
      candidates = desktopCandidates(o, input);
    const first = decisionPage(o, candidates, input, id, 1, 0, new Set([0]), []);
    const pages = Array.from({ length: first.page.count }, (_, index) =>
      decisionPage(o, candidates, input, id, 1, index, new Set([index]), []),
    );
    expect(first.candidates).toHaveLength(240);
    expect(pages.flatMap((p) => p.candidates).some((c) => c.name === 'Apply 239')).toBe(true);
    expect(pages.every((p) => p.candidates.length <= 240)).toBe(true);
    expect(pages.every((p) => p.candidates.some((c) => c.operation === 'SEARCH_APPS'))).toBe(true);
    expect(first.page.count).toBeGreaterThan(1);
  });
  it('moves to the next tree page without performing desktop input', async () => {
    const bridge = new FakeWorkspace();
    bridge.count = 400;
    const h = harness(
      (r) => ({
        candidateId:
          r.page.index === 0
            ? 'NEXT_PAGE'
            : r.candidates.find((c: DesktopCandidate) => c.name === 'Apply 300').id,
      }),
      bridge,
    );
    await h.loop.advance(h.host, true, h.signal);
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].name).toBe('Apply 300');
    expect(h.state.status).toBe('paused');
  });
  it('passes the whole goal to Jev without guessing English phase boundaries', async () => {
    const goal = 'Observe this app then observe it again.';
    const h = harness(r => {
      expect(r.goal).toBe(goal);
      return { candidateId: 'DONE', goalStatus: 'completed' };
    });
    h.state.input = { ...input, goal };
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('completed');
    expect(h.state.step).toBe(2);
  });
  it.each([0, 0.01, 0.55, 1])(
    'executes the selected valid action regardless of score: %s',
    async (confidence) => {
      const h = harness((request) => {
        expect(request).not.toHaveProperty('confidencePolicy');
        return { candidateId: 'action_0', confidence };
      });
      await h.loop.advance(h.host, true, h.signal);
      expect(h.state.status).toBe('paused');
      expect(h.bridge.calls).toHaveLength(1);
    },
  );
  it('keeps an explicit STOP choice', async () => {
    const h = harness(() => ({ candidateId: 'STOP', confidence: 0.01 }));
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('blocked');
    expect(h.bridge.calls).toHaveLength(0);
  });
  it('accepts repeated completion assessments without a score cutoff', async () => {
    const h = harness(() => ({
      candidateId: 'DONE',
      confidence: 0.01,
      goalStatus: 'completed',
      goalConfidence: 0.01,
    }));
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('completed');
    expect(h.state.step).toBe(2);
  });
  it('refuses a candidate outside the presented page', async () => {
    const h = harness(() => ({ candidateId: 'action_1000' }));
    await expect(h.loop.advance(h.host, false, h.signal)).rejects.toThrow('outside');
    expect(h.bridge.calls).toHaveLength(0);
  });
  it('requires independent completion evidence, not only DONE', async () => {
    const h = harness(() => ({ candidateId: 'DONE', goalStatus: 'continue', goalConfidence: 1 }));
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('blocked');
  });
  it('withholds repeated completion proposals while unread branches still need inspection', async () => {
    let calls = 0;
    const h = harness((r) => {
      calls++;
      if (calls === 1) return { candidateId: 'DONE', goalStatus: 'continue', goalConfidence: 1 };
      expect(r.completionNeedsEvidence).toBe(true);
      return { candidateId: 'STOP' };
    });
    const read = h.bridge.observe.bind(h.bridge);
    h.bridge.observe = async (context) => {
      const o = await read(context);
      o.snapshots[0].elements[0].childrenCount = 1;
      return o;
    };
    await h.loop.advance(h.host, false, h.signal);
    expect(calls).toBe(2);
    expect(h.bridge.calls).toHaveLength(0);
  });
  it('re-observes before accepting model-assessed completion', async () => {
    const h = harness(() => ({ candidateId: 'DONE', goalStatus: 'completed', goalConfidence: 0.98 }));
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('completed');
    expect(h.bridge.revision).toBe(2);
    expect(h.state.completion?.kind).toBe('model-assessed');
    expect(h.state.verifiedText).toBeNull();
  });
  it('accepts completion across fresh observations despite unrelated dynamic labels', async () => {
    const h = harness(() => ({ candidateId: 'DONE', goalStatus: 'completed', goalConfidence: 1 }));
    const read = h.bridge.observe.bind(h.bridge);
    h.bridge.observe = async (context) => {
      const o = await read(context);
      o.snapshots[0].text = ['Playback time: ' + o.capturedAt + ' / revision ' + h.bridge.revision];
      return o;
    };
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('completed');
    expect(h.bridge.revision).toBe(2);
  });
  it('withdraws a delivered click on unchanged state while allowing another read', async () => {
    let decisions = 0;
    const h = harness((r) => {
      decisions++;
      const click = r.candidates.find((c: DesktopCandidate) => c.operation === 'CLICK');
      if (decisions === 1) {
        expect(click).toBeDefined();
        return { candidateId: click.id };
      }
      expect(click).toBeUndefined();
      if (decisions === 2) {
        const read = r.candidates.find((c: DesktopCandidate) =>
          c.operation === 'READ_SURFACE' && c.surface === 'menubar');
        expect(read).toBeDefined();
        return { candidateId: read.id };
      }
      return { candidateId: 'STOP' };
    });
    h.bridge.change = false;
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('blocked');
    expect(decisions).toBe(3);
    expect(h.bridge.calls.map(call => call.operation)).toEqual(['CLICK', 'READ_SURFACE']);
    expect(h.bridge.calls.filter(call => call.operation === 'CLICK')).toHaveLength(1);
  });
  it('can return to a parent and inspect the same branch again without replaying desktop input', async () => {
    const bridge = new FakeWorkspace();
    bridge.change = false;
    bridge.observe = async (context) => {
      const o = observation(1, ++bridge.revision);
      o.context = { ...o.context, ...context };
      o.snapshots[0].elements = [
        {
          ref: '@s1:child',
          role: 'group',
          name: 'Content',
          value: '',
          states: [],
          actions: [],
          childrenCount: 2,
        },
      ];
      return o;
    };
    bridge.act = async (c, o) => {
      bridge.calls.push(c);
      return { ...o.context, rootRef: c.targetRef, scopePath: [{ ref: c.targetRef!, name: c.name }] };
    };
    let decisions = 0;
    const h = harness((r) => {
      decisions++;
      if (decisions === 2) return { candidateId: 'GO_PARENT' };
      if (decisions === 3) {
        expect(
          r.candidates.find((c: DesktopCandidate) => c.operation === 'INSPECT_REGION').description,
        ).toContain('Previously inspected 1 time(s)');
        expect(r.notices.some((n: string) => n.includes('Earlier branch read'))).toBe(true);
      }
      if (decisions <= 3)
        return {
          candidateId: r.candidates.find((c: DesktopCandidate) => c.operation === 'INSPECT_REGION').id,
          confidence: 0.1,
        };
      return { candidateId: 'DONE', goalStatus: 'completed', goalConfidence: 1 };
    }, bridge);
    await h.loop.advance(h.host, false, h.signal);
    expect(h.state.status).toBe('completed');
    expect(bridge.calls.map((c) => c.operation)).toEqual(['INSPECT_REGION', 'INSPECT_REGION']);
  });
  it('does not offer mutations from incomplete native snapshots', () => {
    const o = observation();
    o.snapshots[0].complete = false;
    expect(desktopCandidates(o, input).some((c) => c.operation === 'CLICK')).toBe(false);
  });
  it('preserves exact quoted inputs without inventing text', () => {
    expect(
      exactInputs({ ...input, goal: 'Type "hello $HOME" then search for “Outlook”.', text: '' }).map(
        (i) => i.text,
      ),
    ).toEqual(['hello $HOME', 'Outlook']);
  });
  it('does not infer a document identity from its OS window', () => {
    const o = observation();
    o.snapshots[0].elements[0] = {
      ref: '@s1:e1',
      role: 'textfield',
      name: 'Body',
      value: 'Existing content',
      actions: ['SetValue'],
      states: [],
    };
    const task = { ...input, goal: 'Create a new TextEdit document containing "hello".' };
    expect(desktopCandidates(o, task).some((c) => c.operation === 'SET_VALUE')).toBe(true);
  });
  it('disables pointer delivery by default', () => {
    expect(desktopCandidates(observation(), input).some((c) => c.operation === 'DOUBLE_CLICK')).toBe(false);
  });
  it('ignores a decision delivered after stop', async () => {
    const h = harness(() => ({ candidateId: 'action_0' }));
    const abort = new AbortController();
    abort.abort();
    await expect(h.loop.advance(h.host, false, abort.signal)).rejects.toThrow();
    expect(h.bridge.calls).toHaveLength(0);
  });
  it('accepts a validated unquoted argument with low support confidence', async () => {
    const h = harness((r) => ({
      candidateId: r.candidates.find((c: DesktopCandidate) => c.inputFromGoal && c.operation === 'SET_VALUE')
        .id,
    }));
    h.state.input = { ...input, goal: 'Search for 3d printer' };
    h.bridge.observe = async () => {
      const o = observation();
      o.snapshots[0].elements = [
        { ref: '@s1:e1', role: 'textfield', name: 'Search', value: '', actions: ['SetValue'], states: [] },
      ];
      return o;
    };
    h.provider.resolveText = async (r) => ({
      taskId: r.taskId,
      snapshotId: r.snapshotId,
      candidateId: r.candidateId,
      status: 'resolved',
      text: '3d printer',
      start: 11,
      end: 21,
      confidence: 0.25,
      supportConfidence: 0.68,
      model: 'fixture',
    });
    await h.loop.advance(h.host, true, h.signal);
    expect(h.bridge.texts).toEqual(['3d printer']);
    expect(h.state.status).toBe('paused');
  });
  it('permits reading children of a disabled container without offering mutations on it', () => {
    const o = observation();
    o.snapshots[0].elements = [
      {
        ref: '@s1:e1',
        role: 'layoutitem',
        name: 'Editor host',
        value: '',
        states: ['disabled'],
        actions: ['Click'],
        childrenCount: 1,
      },
    ];
    const choices = desktopCandidates(o, input).filter((c) => c.targetRef === '@s1:e1');
    expect(choices.map((c) => c.operation)).toEqual(['INSPECT_REGION']);
  });
  it('withholds an unresolved text action and lets Jev choose another action', async () => {
    let decisions = 0;
    const h = harness((r) => ({
      candidateId:
        ++decisions === 1
          ? r.candidates.find((c: DesktopCandidate) => c.inputFromGoal && c.operation === 'SET_VALUE').id
          : 'STOP',
    }));
    h.bridge.observe = async () => {
      const o = observation();
      o.snapshots[0].elements = [
        { ref: '@s1:e1', role: 'textfield', name: 'Input', value: '', actions: ['SetValue'], states: [] },
      ];
      return o;
    };
    h.provider.resolveText = async (r) => ({
      taskId: r.taskId,
      snapshotId: r.snapshotId,
      candidateId: r.candidateId,
      status: 'unavailable',
      text: '',
      start: 0,
      end: 0,
      confidence: 0.8,
      supportConfidence: 0.6,
      reason: 'unsupported',
      proposedText: 'example',
      model: 'fixture',
    });
    await h.loop.advance(h.host, false, h.signal);
    expect(decisions).toBe(2);
    expect(h.bridge.calls).toHaveLength(0);
    expect(h.host.event).toHaveBeenCalledWith(
      'decision',
      expect.stringContaining('check rejected'),
      expect.objectContaining({ proposedText: 'example' }),
    );
  });
  it('rejects text invented outside the instruction before desktop input', async () => {
    const h = harness((r) => ({
      candidateId: (
        r.candidates.find((c: DesktopCandidate) => c.operation === 'SEARCH_APPS') ||
        r.candidates.find((c: DesktopCandidate) => c.operation === 'BROWSE_APPS')
      ).id,
    }));
    h.state.input = { ...input, goal: 'Open Archive Utility' };
    h.provider.resolveText = async (r) => ({
      taskId: r.taskId,
      snapshotId: r.snapshotId,
      candidateId: r.candidateId,
      status: 'resolved',
      text: 'Terminal',
      start: 5,
      end: 20,
      confidence: 1,
      supportConfidence: 1,
      model: 'fixture',
    });
    await expect(h.loop.advance(h.host, true, h.signal)).rejects.toThrow('exact span');
    expect(h.bridge.calls).toHaveLength(0);
  });
  it('stops after cancellation during text interpretation', async () => {
    const abort = new AbortController();
    const h = harness((r) => ({
      candidateId: (
        r.candidates.find((c: DesktopCandidate) => c.operation === 'SEARCH_APPS') ||
        r.candidates.find((c: DesktopCandidate) => c.operation === 'BROWSE_APPS')
      ).id,
    }));
    h.provider.resolveText = async (r) => {
      abort.abort();
      return {
        taskId: r.taskId,
        snapshotId: r.snapshotId,
        candidateId: r.candidateId,
        status: 'resolved',
        text: 'Apply',
        start: 6,
        end: 11,
        confidence: 1,
        supportConfidence: 1,
        model: 'fixture',
      };
    };
    await expect(h.loop.advance(h.host, true, abort.signal)).rejects.toThrow();
    expect(h.bridge.calls).toHaveLength(0);
  });
});

describe('Bounded native decision context', () => {
  it('offers operations across all loaded levels together even when there are over 240 choices', () => {
    const o = observation(240);
    o.snapshots[0].tree = { id: 'root', role: 'window', name: 'Example', value: '', actions: [], states: [],
      children: o.snapshots[0].elements.map((e, i) => ({ ...e, id: 'n' + i, children: [] })) };
    const actions = desktopCandidates(o, input);
    const request = decisionPage(o, actions, input, id, 1, 0, new Set([0]), []);
    expect(actions.length).toBeGreaterThan(240);
    expect(request.page.count).toBe(1);
    expect(new Set(request.candidates.map(c => c.id))).toEqual(new Set(actions.map(c => c.id)));
    expect(request.candidates.some(c => c.name === 'Apply 239')).toBe(true);
  });
  it('rejects an unbudgeted native view before sending an oversized choice question', () => {
    const o = observation(250);
    o.snapshots[0].tree = { id: 'root', role: 'window', name: 'Example', value: '', actions: [], states: [], children: [] };
    expect(() => decisionPage(o, desktopCandidates(o, input), input, id, 1, 0, new Set([0]), []))
      .toThrow('complete-layer budget');
  });
});
