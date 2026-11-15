import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { accessibilityTree, flattenTree } from '../apps/desktop/electron/desktop/accessibility-tree';
import { NativeError } from '../apps/desktop/electron/desktop/native-client';
import type { WorkspaceBridge } from '../apps/desktop/electron/desktop/workspace';
import type { ActionReport } from '../apps/desktop/electron/desktop/action-verification';
import { BrokerError, withRetry, type DecisionProvider } from '../apps/desktop/electron/services/decision-client';
import { NavigationController } from '../apps/desktop/electron/controller/navigation';
import { PlannerLoop, V2_LIMITS, type PlannerHost } from '../apps/desktop/electron/controller/v2/planner-loop';
import { NavigationOrchestrator } from '../apps/desktop/electron/controller/v2/orchestrator';
import {
  TaskInputSchema, type ControllerState, type DesktopCandidate, type DesktopContext, type DesktopObservation,
  type GroundRequest, type PlanRequest, type PlanStep, type NavigationMilestone, type OrchestratorRequest,
} from '../packages/contracts/src/index';

const taskId = '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe';
beforeAll(() => { V2_LIMITS.settleIntervalMs = 1; V2_LIMITS.settleCapMs = 40; });

/** A tiny application: a size box that never applies, an Apply button that does, and a Send button. */
class Desk implements WorkspaceBridge {
  revision = 0;
  acts: { operation: string; name: string; text?: string; key?: string }[] = [];
  model = { size: '12', boxValue: '12', applied: false, sent: 0, focused: 'Body' };
  fail?: Error;
  report?: ActionReport;
  probes: string[] = [];
  moving = false;
  applications = async () => [{ name: 'Example', id: 'example', running: true }];
  private tree() {
    const s = this.revision;
    let n = 0;
    const ref = () => '@s' + s + ':e' + ++n;
    const m = this.model;
    return { role: 'window', name: 'Document', ref_id: ref(), available_actions: [], states: [], children: [
      { role: 'toolbar', name: 'Formatting', ref_id: ref(), available_actions: [], states: [], children: [
        { role: 'combobox', name: 'Font Size', value: m.boxValue, ref_id: ref(), available_actions: ['SetValue', 'SetFocus'],
          states: m.focused === 'Font Size' ? ['focused'] : [] },
        { role: 'button', name: 'Apply', ref_id: ref(), available_actions: ['Click'], states: [] },
        { role: 'button', name: 'Send', ref_id: ref(), available_actions: ['Click'], states: [] },
      ] },
      { role: 'textarea', name: 'Body', value: 'hello', ref_id: ref(), available_actions: ['SetValue', 'SetFocus'],
        states: m.focused === 'Body' ? ['focused'] : [] },
      { role: 'statictext', name: 'Applied size', value: m.size + ' pt' },
      { role: 'statictext', name: 'Outbox', value: m.sent + ' sent' },
    ] };
  }
  async observe(context: DesktopContext): Promise<DesktopObservation> {
    this.revision++;
    const raw = this.tree();
    return { id: 'o' + this.revision, capturedAt: this.revision, applications: await this.applications(),
      windows: [{ id: 'w1', title: 'Document', app: 'Example', focused: true }], notices: [],
      context: { app: 'Example', windowId: 'w1', surface: context.surface || 'window' },
      snapshots: context.surface && context.surface !== 'window' ? [] : [{ id: 's' + this.revision, app: 'Example', windowId: 'w1',
        windowTitle: 'Document', surface: 'window', complete: true, capturedAt: this.revision, tree: accessibilityTree(raw), elements: flattenTree(raw) }] };
  }
  async probe(ref: string, property: 'states' | 'bounds') {
    this.probes.push(property);
    if (property === 'bounds') return this.moving ? { x: this.probes.length } : { x: 1 };
    return { states: this.model.focused === 'Body' ? ['focused'] : [] };
  }
  async act(candidate: DesktopCandidate, observation: DesktopObservation, text?: string) {
    this.report = undefined;
    this.acts.push({ operation: candidate.operation, name: candidate.name, text, key: candidate.key });
    if (this.fail) { const error = this.fail; this.fail = undefined; throw error; }
    if (candidate.operation === 'SET_VALUE' && candidate.name === 'Font Size') {
      this.model.boxValue = text!;
      this.report = { operation: 'SET_VALUE', target: 'Font Size', delivery: 'delivered_verified', verification: 'verified', expectedValue: text, observedValue: text };
    }
    if (candidate.operation === 'CLICK' && candidate.name === 'Apply') { this.model.size = this.model.boxValue; this.model.applied = true; }
    if (candidate.operation === 'CLICK' && candidate.name === 'Send') this.model.sent++;
    if (candidate.operation === 'FOCUS') this.model.focused = candidate.name;
    return observation.context;
  }
  takeActionReport() { const report = this.report; this.report = undefined; return report; }
}

type Script = (request: PlanRequest, call: number) => Partial<PlanStep>;
function planner(script: Script, ground?: (request: GroundRequest) => string) {
  const requests: PlanRequest[] = [];
  const provider: DecisionProvider = {
    decide: async () => { throw new Error('v1 route must not be used'); },
    plan: async request => {
      requests.push(structuredClone(request));
      return { taskId: request.taskId, observationId: request.observationId, model: 'scripted',
        requirements: request.requirements.length ? request.requirements.map(({ id, text, irreversible, kind }) => ({ id, text, irreversible, kind }))
          : [{ id: 'r1', text: 'The text is 24 pt', irreversible: false, kind: 'outcome' as const }],
        reconciliations: [], statuses: [], kind: 'finish', requirementId: '', operation: '', target: '', targetDescription: '',
        text: '', textIsLiteral: false, key: '', direction: '', risk: 'reversible', repeat: false, expect: '', query: '',
        scope: '', waitMs: 0, message: '', ...script(request, requests.length) } as PlanStep;
    },
    ...(ground ? { ground: async (request: GroundRequest) => ({ taskId: request.taskId, observationId: request.observationId,
      target: ground(request), confidence: 0.9, model: 'jev' }) } : {}),
  };
  return { provider, requests };
}
function makeHost(over: Record<string, unknown> = {}) {
  const state: ControllerState = { taskId, status: 'idle', busy: true, document: null, snapshot: null, decision: null, step: 0,
    verifiedText: null, events: [], input: TaskInputSchema.parse({ provider: 'jev', goal: 'Make the text 24 pt', maxSteps: 20,
      controller: 'v2', ...over }) };
  const traces: { kind: string; data: any }[] = [];
  const host: PlannerHost = { state, status: (status, message) => { state.status = status; state.events.push({ id: state.events.length, at: 0, taskId, type: 'state', message }); },
    event: () => {}, trace: (kind, data) => traces.push({ kind, data: structuredClone(data) }) };
  return { host, state, traces };
}
const id = (request: PlanRequest, label: string) => request.elements.find(e => e.label === label)!.id;
const run = (desk: Desk, provider: DecisionProvider, host: PlannerHost, answer?: string) =>
  new PlannerLoop(desk, provider).advance(host, false, new AbortController().signal, answer);

describe('planner loop', () => {
  it('acts once, reconciles from the new observation, and completes on cited evidence', async () => {
    const desk = new Desk();
    desk.model.boxValue = '24';
    const { provider, requests } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply'), expect: 'Applied size reads 24 pt' }
      : { kind: 'finish', reconciliations: [{ effectId: 'fx1', outcome: 'confirmed', evidence: [id(request, 'Applied size')] }],
          statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')],
            checks: [{ kind: 'text_equals', target: id(request, 'Applied size'), value: '24 pt' }] }] });
    const { host, state } = makeHost();
    await run(desk, provider, host);
    expect(state.status).toBe('completed');
    expect(desk.acts).toEqual([{ operation: 'CLICK', name: 'Apply', text: undefined, key: undefined }]);
    expect(requests[1].effects[0]).toMatchObject({ id: 'fx1', delivery: 'delivered', outcome: 'unknown' });
    expect(requests[1].effects[0].added.some(f => f.includes('24 pt'))).toBe(true);
    expect(requests[1].elements.find(e => e.label === 'Applied size')?.tags).toContain('changed');
    expect(state.requirements).toEqual([{ id: 'r1', text: 'The text is 24 pt', irreversible: false, status: 'evidenced' }]);
    expect(state.completion?.kind).toBe('requirements');
  });

  it('does not send an identical action again while the first is unreconciled', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call <= 3
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Send'), expect: 'sent',
          reconciliations: call === 3 ? [{ effectId: 'fx1', outcome: 'refuted', evidence: [id(request, 'Outbox')] }] : [] }
      : { kind: 'blocked', message: 'stop' });
    const { host } = makeHost();
    await run(desk, provider, host);
    // Call 2 was withheld; call 3 refuted the first attempt with evidence and was allowed.
    expect(desk.acts.filter(a => a.name === 'Send')).toHaveLength(2);
    expect(requests[2].issues.join(' ')).toContain('Reconcile fx1');
  });

  it('ends as completed_unverified when a toolbar value is the only thing the planner can cite', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'SET_VALUE', target: id(request, 'Font Size'), text: '24', textIsLiteral: true, expect: 'text becomes 24 pt' }
      : { kind: 'finish', statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Font Size')], checks: [] }] });
    const { host, state } = makeHost();
    await run(desk, provider, host);
    expect(desk.model.size).toBe('12');
    expect(requests[1].effects[0]).toMatchObject({ outcome: 'confirmed', readback: '24' });
    expect(state.status).toBe('completed_unverified');
    expect(state.requirements?.[0].status).toBe('unverifiable');
    expect(state.completion?.summary).toContain('nothing else on screen confirms');
  });

  it('bounds verification: after the last delivered action only a few steps remain', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Send'), expect: 'sent' }
      : call % 2 ? { kind: 'find', query: 'sent mail' } : { kind: 'read', scope: 'surface:window' });
    const { host, state } = makeHost({ maxSteps: 60 });
    await run(desk, provider, host);
    expect(desk.acts).toHaveLength(1);
    expect(requests[1].phase).toBe('verification');
    expect(requests[1].budgets.verificationReadsLeft).toBe(V2_LIMITS.verificationReads);
    expect(state.status).toBe('completed_unverified');
    expect(state.step).toBe(1 + V2_LIMITS.verificationReads);
  });

  it('lets one requirement take several actions, and a delivered action resets the allowance', async () => {
    const desk = new Desk();
    const { provider } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'SET_VALUE', target: id(request, 'Font Size'), text: '24', textIsLiteral: true, expect: 'box reads 24' }
      : call === 2 ? { kind: 'find', query: 'apply' }
      : call === 3 ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply'), expect: 'Applied size reads 24 pt' }
      : { kind: 'finish', reconciliations: [{ effectId: 'fx2', outcome: 'confirmed', evidence: [id(request, 'Applied size')] }],
          statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] });
    const { host, state } = makeHost();
    await run(desk, provider, host);
    expect(desk.acts.map(a => a.operation)).toEqual(['SET_VALUE', 'CLICK']);
    expect(desk.model.size).toBe('24');
    expect(state.status).toBe('completed');
  });

  it('has no idle limit while work is outstanding, but refuses a repeated search on an unchanged screen', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((_r, call) => (call <= 20 ? { kind: 'find', query: call % 2 ? 'outbox' : 'Outbox ' } : { kind: 'blocked', message: 'stop' }));
    const { host, state } = makeHost({ maxSteps: 60 });
    await run(desk, provider, host);
    // 20 searches, then a premature "blocked" is questioned once before it is accepted.
    expect(state.step).toBe(22);
    expect(requests[2].issues.join(' ')).toContain('already ran on this unchanged screen');
    expect(state.status).toBe('blocked');
  });
  it('lets a search run again once the screen has changed', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call === 1 ? { kind: 'find', query: 'outbox' }
      : call === 2 ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Send'), expect: 'sent' }
      : call === 3 ? { kind: 'find', query: 'outbox' } : { kind: 'blocked', message: 'stop' });
    const { host } = makeHost();
    await run(desk, provider, host);
    expect(requests[3].issues.join(' ')).not.toContain('already ran');
  });
  it('gates an irreversible action on the original requirement and on the user', async () => {
    const desk = new Desk();
    const send = (request: PlanRequest) => ({ kind: 'act' as const, requirementId: 'r1', operation: 'CLICK' as const,
      target: id(request, 'Send'), risk: 'irreversible' as const, expect: 'sent' });
    const unauthorised = planner((request, call) => call === 1 ? send(request) : { kind: 'blocked', message: 'cannot' });
    const first = makeHost();
    await run(desk, unauthorised.provider, first.host);
    expect(desk.acts).toHaveLength(0);
    expect(unauthorised.requests[1].issues.join(' ')).toContain('marked irreversible');

    const authorised = planner((request, call) => call <= 2
      ? { ...send(request), requirements: [{ id: 'r1', text: 'The message is sent', irreversible: true, kind: 'outcome' as const }] }
      : { kind: 'finish', reconciliations: [{ effectId: 'fx1', outcome: 'confirmed', evidence: [id(request, 'Outbox')] }],
          statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Outbox')], checks: [] }] });
    const second = makeHost({ goal: 'Send the message' });
    const loop = new PlannerLoop(desk, authorised.provider);
    await loop.advance(second.host, false, new AbortController().signal);
    expect(second.state.status).toBe('needs_user');
    expect(second.state.question?.kind).toBe('confirm');
    expect(desk.acts).toHaveLength(0);
    await loop.advance(second.host, false, new AbortController().signal, 'yes');
    expect(desk.model.sent).toBe(1);
    expect(second.state.status).toBe('completed');
  });

  it('does not send when the user declines, and tells the planner', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Send'), risk: 'irreversible', expect: 'sent',
          requirements: [{ id: 'r1', text: 'The message is sent', irreversible: true, kind: 'outcome' as const }] }
      : { kind: 'blocked', message: 'The user declined.' });
    const { host, state } = makeHost();
    const loop = new PlannerLoop(desk, provider);
    await loop.advance(host, false, new AbortController().signal);
    await loop.advance(host, false, new AbortController().signal, 'no');
    expect(desk.model.sent).toBe(0);
    expect(requests[1].issues.join(' ')).toContain('declined');
    expect(state.status).toBe('blocked');
  });

  it('asks the user and carries the answer into the next plan', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((_request, call) => call === 1 ? { kind: 'ask_user', message: 'Which document?' }
      : { kind: 'blocked', message: 'done asking' });
    const { host, state } = makeHost();
    const loop = new PlannerLoop(desk, provider);
    await loop.advance(host, false, new AbortController().signal);
    expect(state.status).toBe('needs_user');
    expect(state.question).toEqual({ kind: 'question', text: 'Which document?' });
    await loop.advance(host, false, new AbortController().signal, 'The report');
    expect(requests[1].answers).toEqual([{ question: 'Which document?', answer: 'The report' }]);
  });

  it('records a pre-dispatch failure as not delivered and an unexplained native error as uncertain', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call <= 4
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Send'), expect: 'sent' }
      : { kind: 'blocked', message: 'stop' });
    desk.fail = new NativeError('STALE_REF', 'stale', { delivery: 'not_delivered', retry: 'safe' });
    const { host } = makeHost();
    const loop = new PlannerLoop(desk, provider);
    const original = desk.act.bind(desk);
    desk.act = async (candidate, observation, text) => {
      if (desk.acts.length === 1) desk.fail = new NativeError('TIMEOUT', 'timed out');
      return original(candidate, observation, text);
    };
    await loop.advance(host, false, new AbortController().signal);
    expect(requests[1].effects[0]).toMatchObject({ delivery: 'not_delivered' });
    // The retry after not_delivered was allowed; its timeout is uncertain and withholds the third.
    expect(requests[2].effects.at(-1)).toMatchObject({ delivery: 'uncertain', outcome: 'unknown' });
    expect(desk.acts).toHaveLength(2);
    expect(requests[3].issues.join(' ')).toContain('outcome is unknown');
  });

  it('checks literal text, target membership and offered operations before sending anything', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => [
      { kind: 'act', requirementId: 'r1', operation: 'SET_VALUE', target: id(request, 'Body'), text: 'invented', textIsLiteral: true },
      { kind: 'act', requirementId: 'r1', operation: 'CHECK', target: id(request, 'Apply') },
      { kind: 'act', requirementId: 'missing', operation: 'CLICK', target: id(request, 'Apply') },
      { kind: 'act', requirementId: 'r1', operation: 'PRESS', key: 'cmd+q' },
      { kind: 'act', requirementId: 'r1', operation: 'PRESS', key: 'return', target: id(request, 'Font Size') },
      { kind: 'blocked', message: 'stop' },
    ][call - 1] as Partial<PlanStep>);
    const { host } = makeHost();
    await run(desk, provider, host);
    expect(desk.acts).toHaveLength(0);
    const issues = requests.slice(1).map(r => r.issues.join(' '));
    expect(issues[0]).toContain('not an exact part of the goal');
    expect(issues[1]).toContain('CHECK is not offered');
    expect(issues[2]).toContain('requirement it serves');
    expect(issues[3]).toContain('not available');
    expect(issues[4]).toContain('does not have keyboard focus');
  });

  it('probes the live element: a moving target or lost focus sends nothing', async () => {
    const desk = new Desk();
    desk.moving = true;
    const { provider, requests } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply') }
      : call === 2 ? { kind: 'act', requirementId: 'r1', operation: 'PRESS', key: 'return', target: id(request, 'Body') }
      : { kind: 'blocked', message: 'stop' });
    const { host } = makeHost();
    const originalProbe = desk.probe.bind(desk);
    desk.probe = async (ref, property) => {
      const value = await originalProbe(ref, property);
      return property === 'states' ? { states: [] } : value;
    };
    await run(desk, provider, host);
    // Bringing the window forward before a key is not input to the application's content.
    expect(desk.acts.filter(a => a.operation !== 'FOCUS_WINDOW')).toHaveLength(0);
    expect(requests[1].issues.join(' ')).toContain('still moving');
    expect(requests[2].issues.join(' ')).toContain('focus moved away');
  });

  it('lets Jev choose the target in the grounding arm and records agreement', async () => {
    const desk = new Desk();
    const grounded: GroundRequest[] = [];
    const { provider } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Send'), targetDescription: 'the Apply button' }
      : { kind: 'blocked', message: 'stop' }, request => { grounded.push(request); return request.elements.find(e => e.label === 'Apply')!.id; });
    const { host, traces } = makeHost({ grounding: 'jev' });
    await run(desk, provider, host);
    expect(desk.acts).toEqual([{ operation: 'CLICK', name: 'Apply', text: undefined, key: undefined }]);
    expect(grounded[0].elements.every(e => e.operations.includes('CLICK'))).toBe(true);
    expect(traces.find(t => t.kind === 'grounding')?.data.agree).toBe(false);
  });

  it('stops as blocked when the step budget runs out with nothing delivered', async () => {
    const desk = new Desk();
    const { provider } = planner((_r, call) => ({ kind: 'find', query: 'anything ' + call }));
    const { host, state } = makeHost({ maxSteps: 3 });
    await run(desk, provider, host);
    expect(state.status).toBe('blocked');
    expect(state.step).toBe(3);
    expect(desk.acts).toHaveLength(0);
  });

  it('reads another scope without sending input', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((_request, call) => call === 1 ? { kind: 'read', scope: 'surface:menubar' }
      : call === 2 ? { kind: 'read', scope: 'nonsense' } : { kind: 'blocked', message: 'stop' });
    const { host } = makeHost();
    await run(desk, provider, host);
    expect(requests[1].observation.surface).toBe('applications');
    expect(requests[2].issues.join(' ')).toContain('listed scopes');
    expect(desk.acts).toHaveLength(0);
  });
});

describe('retries and lifecycle', () => {
  it('retries transient model failures and not permanent ones', async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    await expect(withRetry(async () => { if (++calls < 3) throw new BrokerError('rate limit', true, 502); return 'ok'; }, signal, [1, 1, 1])).resolves.toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    await expect(withRetry(async () => { calls++; throw new BrokerError('bad key', false, 502); }, signal, [1, 1, 1])).rejects.toThrow('bad key');
    expect(calls).toBe(1);
    calls = 0;
    await expect(withRetry(async () => { calls++; throw new BrokerError('down', true, 502); }, signal, [1, 1])).rejects.toThrow('down');
    expect(calls).toBe(3);
  });

  it('runs a v2 task through the controller, answers a question, and writes a complete trace', async () => {
    const desk = new Desk();
    desk.model.boxValue = '24';
    const { provider } = planner((request, call) => call === 1 ? { kind: 'ask_user', message: 'Apply now?' }
      : call === 2 ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply'), expect: '24 pt' }
      : { kind: 'finish', reconciliations: [{ effectId: 'fx1', outcome: 'confirmed', evidence: [id(request, 'Applied size')] }],
          statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] });
    const traceDir = mkdtempSync(path.join(os.tmpdir(), 'assistant-trace-'));
    const controller = new NavigationController({} as any, { jev: provider, local: provider }, desk, traceDir);
    const settled = () => new Promise<ControllerState>(resolve => {
      const stop = controller.subscribe(state => { if (!state.busy) { stop(); resolve(state); } });
    });
    const waiting = settled();
    controller.start({ provider: 'jev', goal: 'Make the text 24 pt', controller: 'v2', maxSteps: 20 });
    expect((await waiting).status).toBe('needs_user');
    expect(() => controller.start({ provider: 'jev', goal: 'Other', controller: 'v2' })).toThrow('Answer or stop');
    const done = settled();
    controller.answer('yes please');
    const final = await done;
    expect(final.status).toBe('completed');
    expect(final.requirements?.[0].status).toBe('evidenced');
    const lines = readFileSync(path.join(traceDir, readdirSync(traceDir)[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const kinds = new Set(lines.map(line => line.kind));
    for (const kind of ['task', 'event', 'observation', 'plan_request', 'plan_step', 'question', 'answer', 'effect', 'terminal'])
      expect(kinds.has(kind), kind).toBe(true);
    expect(lines.filter(line => line.kind === 'plan_request')).toHaveLength(3);
  });

  it('refuses the v2 controller when the provider cannot plan', () => {
    const provider: DecisionProvider = { decide: async () => { throw new Error('unused'); } };
    const controller = new NavigationController({} as any, { jev: provider, local: provider }, new Desk());
    expect(() => controller.start({ provider: 'jev', goal: 'Anything', controller: 'v2' })).toThrow('planner route');
  });
});

describe('guards added after outside review', () => {
  it('inspects the requested app after launch succeeds but resolving a focused window is uncertain', async () => {
    const desk = new Desk();
    const contexts: DesktopContext[] = [];
    const observe = desk.observe.bind(desk);
    desk.observe = async context => {
      contexts.push(context);
      const observation = await observe(context);
      return contexts.length === 1 ? { ...observation, context: {}, applications: await desk.applications(), windows: [], snapshots: [] } : observation;
    };
    desk.fail = new NativeError('WINDOW_AMBIGUOUS', 'Several windows; no exact focused window', { delivery: 'unknown', retry: 'inspect' });
    const { provider } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'OPEN_APP', target: id(request, 'Example') }
      : { kind: 'blocked', message: 'Inspect the offered windows' });
    const { host } = makeHost();
    await run(desk, provider, host);
    expect(contexts[1]).toMatchObject({ app: 'Example', surface: 'window' });
    expect(desk.acts.filter(a => a.operation === 'OPEN_APP')).toHaveLength(1);
  });

  it('does not treat the unchanged action button as evidence that its effect failed', async () => {
    const desk = new Desk();
    desk.model.boxValue = '24';
    const { provider, requests } = planner((request, call) => call <= 2
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply'),
          reconciliations: call === 2 ? [{ effectId: 'fx1', outcome: 'refuted', evidence: [id(request, 'Apply')] }] : [] }
      : { kind: 'finish', reconciliations: [{ effectId: 'fx1', outcome: 'confirmed', evidence: [id(request, 'Applied size')] }],
          statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] });
    const { host, state } = makeHost();
    await run(desk, provider, host);
    expect(desk.acts).toHaveLength(1);
    expect(requests[2].issues.join(' ')).toContain('observed counter-evidence');
    expect(state.status).toBe('completed');
  });

  it('can reassign a setting when a new observation contradicts its earlier readback', async () => {
    const desk = new Desk();
    const { provider } = planner((request, call) => {
      if (call === 1) return { kind: 'act', requirementId: 'r1', operation: 'SET_VALUE',
        target: id(request, 'Font Size'), text: '24' };
      if (call === 2) { desk.model.boxValue = '12'; return { kind: 'read', scope: 'surface:window' }; }
      if (call === 3) return { kind: 'act', requirementId: 'r1', operation: 'SET_VALUE',
        target: id(request, 'Font Size'), text: '24' };
      return { kind: 'finish' };
    });
    const { host } = makeHost();
    await run(desk, provider, host);
    expect(desk.acts.filter(a => a.operation === 'SET_VALUE')).toHaveLength(2);
  });

  it('does not resend a confirmed action unless the planner says the goal asks for it again', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => {
      const send = { kind: 'act' as const, requirementId: 'r1', operation: 'CLICK' as const, target: id(request, 'Send'), expect: 'sent' };
      if (call === 1) return send;
      if (call === 2) return { ...send, reconciliations: [{ effectId: 'fx1', outcome: 'confirmed' as const, evidence: [id(request, 'Outbox')] }] };
      if (call === 3) return { ...send, repeat: true };
      return { kind: 'blocked', message: 'stop' };
    });
    const { host } = makeHost({ goal: 'Send it twice' });
    await run(desk, provider, host);
    expect(requests[2].issues.join(' ')).toContain('already succeeded as fx1');
    expect(desk.model.sent).toBe(2);
  });
  it('questions a "blocked" that comes before anything was tried, once', async () => {
    const desk = new Desk();
    const { provider, requests } = planner(() => ({ kind: 'blocked', message: 'No keys are available.' }));
    const { host, state } = makeHost();
    await run(desk, provider, host);
    expect(requests).toHaveLength(2);
    expect(requests[1].issues.join(' ')).toContain('Nothing has been tried yet');
    expect(state.status).toBe('blocked');
  });
  it('does not reopen an evidenced requirement because the planner reworded it', async () => {
    const desk = new Desk();
    desk.model.boxValue = '24';
    const { provider } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply'), expect: '24 pt' }
      : { kind: 'finish', requirements: [{ id: 'r1', text: 'The text is 24 pt and bold', irreversible: false, kind: 'outcome' as const }],
          statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] });
    const { host, state } = makeHost();
    await run(desk, provider, host);
    expect(state.requirements).toEqual([{ id: 'r1', text: 'The text is 24 pt', irreversible: false, status: 'evidenced' }]);
  });
});

describe('opening an address that may or may not have opened', () => {
  it('records the outcome as unknown and does not open it again', async () => {
    const desk = new Desk();
    let opens = 0;
    (desk as any).openUrl = async () => { opens++; throw new Error('the reply was lost'); };
    const { provider, requests } = planner((_request, call) => call <= 2
      ? { kind: 'act', requirementId: 'r1', operation: 'OPEN_URL', text: 'https://example.test/', expect: 'the page opens' }
      : { kind: 'blocked', message: 'stop' });
    const { host } = makeHost({ goal: 'Open https://example.test/' });
    await run(desk, provider, host);
    expect(opens).toBe(1);
    expect(requests[1].effects.at(-1)).toMatchObject({ operation: 'OPEN_URL', delivery: 'uncertain', outcome: 'unknown' });
    expect(requests[2].issues.join(' ')).toContain('outcome is unknown');
  });
});

const sizeMilestone: NavigationMilestone = { id: 'r1', text: 'The text is 24 pt', doneWhen: 'The applied size reads 24 pt',
  condition: '', dependsOn: [], kind: 'outcome', irreversible: false };
const reviewSize = (request: OrchestratorRequest, milestoneId = 'r1') => [{ milestoneId, status: 'evidenced' as const,
  evidence: [request.screen.elements.find(e => e.label === 'Applied size')!.id] }];

describe('orchestrated navigation sessions', () => {
  it('shares semantic history between controller sessions but resets it for a new orchestration', async () => {
    const desk = new Desk(); desk.model.size = '24';
    const { provider } = planner(request => ({ kind: 'yield', report: { status: 'objective_met', summary: 'Applied size observed',
      evidence: [id(request, 'Applied size')], remaining: [] } }));
    const calls = new Map<string, number>();
    provider.orchestrate = async request => {
      const call = (calls.get(request.taskId) ?? 0) + 1; calls.set(request.taskId, call);
      if (call === 1) expect(request.history).toEqual([]);
      else {
        expect(request.history?.map(r => r.kind)).toEqual(['assignment', 'result']);
        expect(request.history?.every(r => r.taskId === request.taskId)).toBe(true);
        expect(request.history?.at(-1)?.facts.join()).toContain('24 pt');
      }
      return { taskId: request.taskId, model: 'scripted', kind: call === 1 ? 'navigate' : 'finish',
        plan: call === 1 ? [sizeMilestone] : [], branches: [], milestoneId: 'r1', objective: 'Inspect size', context: '',
        reviews: call === 2 ? reviewSize(request) : [], message: 'Verified.' };
    };
    const orchestrator = new NavigationOrchestrator(desk, provider);
    for (const nextId of [taskId, 'a9c471f8-8828-4301-82b5-ecfce0ff62be']) {
      const { host, state } = makeHost({ orchestration: true }); state.taskId = nextId;
      await orchestrator.advance(host, false, new AbortController().signal);
      expect(state.status).toBe('completed');
    }
    expect([...calls.values()]).toEqual([2, 2]);
  });

  it('recovers a transient parent API failure without losing the task or dispatching duplicate input', async () => {
    const desk = new Desk(); desk.model.size = '24';
    const { provider } = planner(request => ({ kind: 'yield', report: { status: 'objective_met', summary: '24 pt is visible',
      evidence: [id(request, 'Applied size')], remaining: [] } }));
    let calls = 0;
    provider.orchestrate = async request => {
      calls++;
      if (calls === 1) throw new BrokerError('Incomplete response', true);
      return { taskId, model: 'scripted', kind: calls === 2 ? 'navigate' : 'finish',
        plan: calls === 2 ? [sizeMilestone] : [], branches: [], milestoneId: 'r1', objective: 'Inspect the size', context: '',
        reviews: calls === 3 ? reviewSize(request) : [], message: 'Verified.' };
    };
    const { host, state } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('completed');
    expect(calls).toBe(3);
    expect(desk.acts).toHaveLength(0);
  });
  it('executes allocated repetitions after reconciliation and keeps chosen inputs in semantic history', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => ({
      kind: call < 4 ? 'act' : 'yield', requirementId: 'r1', operation: call < 4 ? 'CLICK' : '',
      target: call < 4 ? id(request, 'Send') : '', repeat: false,
      reconciliations: call > 1 ? [{ effectId: 'fx' + (call - 1), outcome: 'confirmed', evidence: [id(request, 'Outbox')] }] : [],
      report: call === 4 ? { status: 'objective_met', summary: 'Three increments observed.', evidence: [id(request, 'Outbox')], remaining: [] } : null,
    }));
    let calls = 0;
    provider.orchestrate = async request => {
      calls++;
      if (calls === 2) {
        expect(request.history?.some(r => r.kind === 'assignment' && r.inputs[0]?.value === '3')).toBe(true);
        expect(request.history?.at(-1)?.facts.join()).toContain('3 sent');
      }
      return { taskId, model: 'scripted', kind: calls === 1 ? 'navigate' : 'finish',
        plan: calls === 1 ? [sizeMilestone] : [], branches: [], milestoneId: 'r1', objective: 'Increment three times',
        context: '', doneWhen: 'The counter is three', inputs: [{ name: 'count', value: '3' }], allowRepetition: true,
        reviews: calls === 2 ? [{ milestoneId: 'r1', evidence: [request.screen.elements.find(e => e.label === 'Outbox')!.id] }] : [], message: 'Done.' };
    };
    const { host, state } = makeHost({ orchestration: true, goal: 'Increment the Outbox counter three times' });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(desk.acts).toHaveLength(3);
    expect(state.status).toBe('completed');
    expect(requests.every(r => r.mission?.inputs?.[0].value === '3')).toBe(true);
  });

  it('lets the parent report delivered but unobservable work without relabeling it verified', async () => {
    const desk = new Desk();
    const { provider } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply') }
      : { kind: 'yield', report: { status: 'unverified', summary: 'Input delivered; downstream status is not exposed.', evidence: [], remaining: [] } });
    let calls = 0;
    provider.orchestrate = async request => ({ taskId, model: 'scripted', kind: ++calls === 1 ? 'navigate' : 'finish_unverified',
      plan: calls === 1 ? [sizeMilestone] : [], branches: [], milestoneId: 'r1', objective: 'Request the operation', context: '',
      reviews: calls === 2 ? [{ milestoneId: 'r1', status: 'unverifiable', reason: 'The application exposes no downstream status.',
        evidence: [request.screen.elements.find(e => e.label === 'Apply')!.id] }] : [], message: 'Delivered, but downstream result cannot be verified.' });
    const { host, state } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('completed_unverified');
    expect(state.requirements?.[0].status).toBe('unverifiable');
    expect(desk.acts).toHaveLength(1);
  });
  it('lets one session exceed the former decision and time limits until its objective returns', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call <= 24
      ? { kind: 'act', requirementId: 'r1', operation: 'SET_VALUE', target: id(request, 'Font Size'), text: String(call) }
      : call === 25 ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply') }
      : { kind: 'yield', statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] });
    let calls = 0;
    provider.orchestrate = async request => ({ taskId, model: 'scripted', kind: ++calls === 1 ? 'navigate' : 'finish',
      plan: calls === 1 ? [sizeMilestone] : [], branches: [], milestoneId: 'r1',
      objective: 'Set and apply the requested size', doneWhen: 'Applied size is 24 pt', context: '', message: 'Verified.',
      reviews: calls === 2 ? reviewSize(request) : [] });
    const { host, state } = makeHost({ orchestration: true, maxSteps: 2 });
    const deadline = V2_LIMITS.deadlineMs;
    try {
      V2_LIMITS.deadlineMs = -1;
      await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    } finally { V2_LIMITS.deadlineMs = deadline; }
    expect(state.status).toBe('completed');
    expect(state.step).toBe(26);
    expect(calls).toBe(2);
    expect(desk.acts).toHaveLength(25);
    expect(requests.every(r => r.budgets.stepsLeft === null)).toBe(true);
    expect(requests[0].mission?.doneWhen).toBe('Applied size is 24 pt');
  });

  it('returns a repeated rejected proposal to the parent and lets it recover without replay', async () => {
    const desk = new Desk(); desk.model.boxValue = '24';
    const { provider } = planner((request, call) => call <= 2
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: 'nonexistent' }
      : call === 3 ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply') }
      : { kind: 'yield', statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] });
    let calls = 0;
    provider.orchestrate = async request => {
      calls++;
      if (calls === 2) {
        expect(request.handoff?.outcome).toBe('yielded');
        expect(request.handoff?.reason).toContain('repeated a rejected proposal');
        expect(request.handoff?.issues.join()).toContain('target element id');
        expect(request.screen.observationId).not.toBe(request.handoff?.observationId);
      }
      return { taskId, model: 'scripted', kind: calls === 3 ? 'finish' : 'navigate',
        plan: calls === 1 ? [sizeMilestone] : [], branches: [], milestoneId: 'r1', objective: 'Apply 24 pt',
        context: calls === 2 ? 'Use the observed Apply control.' : '', message: 'Verified.', reviews: calls === 3 ? reviewSize(request) : [] };
    };
    const { host, state } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('completed');
    expect(calls).toBe(3);
    expect(desk.acts).toHaveLength(1);
  });

  it('leaves a premature executor completion proposal open until the parent verifies the actual result', async () => {
    const desk = new Desk(); desk.model.boxValue = '24';
    const { provider, requests } = planner((request, call) => call === 1
      ? { kind: 'yield', statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] }
      : call === 2 ? { kind: 'act', operation: 'CLICK', requirementId: 'r1', target: id(request, 'Apply') }
      : { kind: 'yield', reconciliations: [{ effectId: 'fx1', outcome: 'confirmed', evidence: [id(request, 'Applied size')] }],
        statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] });
    let calls = 0;
    provider.orchestrate = async request => {
      calls++;
      if (calls === 2) {
        expect(request.requirements[0].status).toBe('open');
        expect(request.handoff?.completionProposal?.evidence.join()).toContain('12 pt');
        expect(request.handoff?.completion).toBe('incomplete');
      }
      return { taskId, model: 'scripted', kind: calls === 3 ? 'finish' : 'navigate',
        plan: calls === 1 ? [sizeMilestone] : [], branches: [], milestoneId: 'r1', objective: 'Apply 24 pt', context: '',
        reviews: calls === 3 ? reviewSize(request) : [],
        message: 'Applied 24 pt.' };
    };
    const { host, state } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('completed');
    expect(requests[1].requirements[0].status).toBe('open');
    expect(requests[2].effects[0].id).toBe('fx1');
    expect(desk.acts.map(a => a.operation)).toEqual(['CLICK']);
    expect(desk.model.size).toBe('24');
  });

  it.each([false, true])('resolves navigator questions internally, including an old parent question response (%s)', async legacyQuestion => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call === 1
      ? { kind: 'ask_user', message: 'Which value should I use?' }
      : { kind: 'yield', statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] });
    let calls = 0;
    provider.orchestrate = async request => {
      calls++;
      if (calls === 2) {
        expect(request.handoff?.reason).toContain('Navigator asks the orchestrator: Which value should I use?');
        expect(request.answers).toEqual([]);
      }
      if (calls === 3 && legacyQuestion) expect(request.issues.join()).toContain('Clarification questions are disabled');
      return { taskId, model: 'scripted', kind: calls === 2 && legacyQuestion ? 'ask_user' : calls === (legacyQuestion ? 4 : 3) ? 'finish' : 'navigate',
        plan: calls === 1 ? [sizeMilestone] : [], reviews: calls === (legacyQuestion ? 4 : 3) ? reviewSize(request) : [], branches: [], milestoneId: 'r1',
        objective: 'Inspect the applied size', context: calls > 1 ? 'Use the existing size requested by the user.' : '',
        message: legacyQuestion ? 'Which size do you prefer?' : 'Verified.' };
    };
    const { host, state, traces } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(traces.filter(r => r.kind === 'navigation_question')).toHaveLength(1);
    expect(traces.filter(r => r.kind === 'question')).toHaveLength(0);
    expect(state.status).toBe('completed');
    expect(state.question).toBeUndefined();
    expect(state.events.some(e => e.message === 'Which value should I use?')).toBe(false);
    expect(requests[1].mission?.context).toContain('Use the existing size');
    expect(requests[1].answers).toEqual([]);
  });

  it('continues beyond the former total step, time and twelve-call caps using short sessions', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call <= 13
      ? { kind: 'yield', message: 'Return current findings for the next short session.' }
      : { kind: 'yield', statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] });
    let calls = 0;
    provider.orchestrate = async request => {
      expect(request.stepsLeft).toBeNull();
      return { taskId, model: 'scripted', kind: ++calls === 15 ? 'finish' : 'navigate',
        plan: calls === 1 ? [sizeMilestone] : [], reviews: calls === 15 ? reviewSize(request) : [], branches: [], milestoneId: 'r1',
        objective: 'Inspect the applied value', context: '', message: 'Verified.' };
    };
    const { host, state } = makeHost({ orchestration: true, maxSteps: 2 });
    desk.model.size = '24';
    const deadline = V2_LIMITS.deadlineMs;
    try {
      V2_LIMITS.deadlineMs = -1;
      await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    } finally { V2_LIMITS.deadlineMs = deadline; }
    expect(state.status).toBe('completed');
    expect(state.step).toBe(14);
    expect(calls).toBe(15);
    expect(requests.every(r => r.budgets.stepsLeft === null)).toBe(true);
  });

  it('ignores redundant reviews of completed milestones while continuing later work', async () => {
    const desk = new Desk();
    const first = { ...sizeMilestone, id: 'inspect', text: 'Inspect the current size' };
    const second = { ...sizeMilestone, dependsOn: ['inspect'] };
    const { provider } = planner((request, call) => ({ kind: 'yield', statuses: call === 2 ? [] : [
      { requirementId: request.mission!.milestone!.id, status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] }));
    let calls = 0;
    provider.orchestrate = async request => ({ taskId, model: 'scripted', kind: ++calls === 4 ? 'finish' : 'navigate',
      plan: calls === 1 ? [first, second] : [], branches: [],
      // The old milestone is no longer the active one. This must not poison a valid next session.
      reviews: calls === 2 ? reviewSize(request, 'inspect') : calls === 3
        ? [{ milestoneId: 'inspect', evidence: ['old-id-not-in-current-screen'] }] : calls === 4 ? reviewSize(request) : [],
      milestoneId: calls === 1 ? 'inspect' : 'r1', objective: 'Inspect the applied size', context: '', message: 'Verified.' });
    const { host, state } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('completed');
    expect(calls).toBe(4);
  });

  it('lets the orchestrator verify a yielded result and rejects invented addresses before execution', async () => {
    const desk = new Desk(); desk.model.boxValue = '24';
    const { provider } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply') }
      : { kind: 'yield', message: 'Applied; coordinator can review the result.', statuses: [] });
    let calls = 0;
    provider.orchestrate = async request => {
      calls++;
      if (calls === 2) expect(request.issues.join()).toContain('Unobserved addresses');
      return { taskId, model: 'scripted', kind: calls === 3 ? 'finish' : 'navigate',
        plan: calls === 1 ? [{ ...sizeMilestone, doneWhen: 'Visit https://invented.example/format' }]
          : calls === 2 ? [sizeMilestone] : [],
        reviews: calls === 3 ? [{ milestoneId: 'r1', evidence: [request.screen.elements.find(e => e.label === 'Applied size')!.id] }] : [],
        branches: [], milestoneId: 'r1', objective: 'Apply the size', context: '', message: 'Size verified.' };
    };
    const { host, state } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('completed');
    expect(desk.acts.map(a => a.operation)).toEqual(['CLICK']);
    expect(calls).toBe(3);
  });

  it.each(['12', '24'])('executes a conditional workflow from the observed %s pt state', async initialSize => {
    const desk = new Desk(); desk.model.size = initialSize;
    const inspect: NavigationMilestone = { id: 'inspect', text: 'Inspect the applied size', doneWhen: 'The applied size is read',
      condition: '', dependsOn: [], kind: 'outcome', irreversible: false };
    const apply = { ...sizeMilestone, dependsOn: ['inspect'], condition: 'The inspected size is not 24 pt' };
    const { provider, requests } = planner((request) => {
      expect(request.requirements.map(r => r.id)).toEqual([request.mission!.milestone!.id]);
      if (request.mission!.milestone!.id === 'inspect') return { kind: 'yield', statuses: [
        { requirementId: 'inspect', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] };
      if (!desk.acts.length) return { kind: 'act', operation: 'SET_VALUE', requirementId: 'r1', target: id(request, 'Font Size'), text: '24' };
      if (desk.acts.length === 1) return { kind: 'act', operation: 'CLICK', requirementId: 'r1', target: id(request, 'Apply') };
      return { kind: 'yield', reconciliations: [{ effectId: 'fx2', outcome: 'confirmed', evidence: [id(request, 'Applied size')] }],
        statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] };
    });
    let calls = 0;
    provider.orchestrate = async request => {
      calls++;
      const common = { taskId, model: 'scripted', context: '', message: 'Applied size verified.',
        reviews: calls > 1 ? reviewSize(request, calls === 2 ? 'inspect' : 'r1') : [] };
      if (calls === 1) return { ...common, kind: 'navigate', plan: [inspect, apply], branches: [], milestoneId: 'inspect', objective: inspect.text };
      if (calls === 2) {
        expect(request.requirements.find(r => r.id === 'inspect')!.status).toBe('open');
        expect(request.handoff?.completionProposal?.evidence.join()).toContain(initialSize + ' pt');
        return { ...common, kind: initialSize === '24' ? 'finish' : 'navigate', plan: [], milestoneId: 'r1', objective: apply.text,
          branches: [{ milestoneId: 'r1', disposition: initialSize === '24' ? 'skip' : 'run', sourceMilestoneIds: ['inspect'], reason: 'Read applied size: ' + initialSize }] };
      }
      return { ...common, kind: 'finish', plan: [], branches: [], milestoneId: '', objective: '' };
    };
    const { host, state } = makeHost({ goal: 'Check the size and make it 24 pt if needed.', orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('completed');
    expect(desk.model.size).toBe('24');
    expect(desk.acts.map(a => a.operation)).toEqual(initialSize === '24' ? [] : ['SET_VALUE', 'CLICK']);
    expect(requests[0].mission?.milestone?.id).toBe('inspect');
  });

  it('prevents the lower navigator from doing future work or declaring its own obligations', async () => {
    const desk = new Desk();
    const future = { ...sizeMilestone, id: 'future', dependsOn: ['r1'] };
    const { provider, requests } = planner((request, call) => call === 1 ? {
      kind: 'act', requirementId: 'future', operation: 'CLICK', target: id(request, 'Apply'),
      requirements: [{ id: 'invented', text: 'Unrelated work', kind: 'outcome', irreversible: false }],
      statuses: [{ requirementId: 'future', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }],
    } : { kind: 'blocked', message: 'Return for replanning.' });
    let calls = 0;
    provider.orchestrate = async () => ({ taskId, model: 'scripted', kind: ++calls === 1 ? 'navigate' : 'blocked',
      plan: calls === 1 ? [sizeMilestone, future] : [], branches: [], reviews: [], milestoneId: 'r1', objective: sizeMilestone.text,
      context: '', message: 'No result.' });
    const { host } = makeHost({ orchestration: true });
    const controller = new NavigationOrchestrator(desk, provider);
    await controller.advance(host, false, new AbortController().signal);
    expect(desk.acts).toEqual([]);
    expect(requests[1].issues.join()).toContain('only on the assigned milestone');
    expect(host.state.requirements?.map(r => r.id)).toEqual(['r1', 'future']);
  });

  it('returns failed verification as a structured tool result without replaying the mutation', async () => {
    const desk = new Desk();
    const { provider } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'SET_VALUE', target: id(request, 'Font Size'), text: '24', textIsLiteral: true }
      : { kind: 'finish', statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Font Size')], checks: [] }] });
    const calls: any[] = [];
    provider.orchestrate = async request => {
      calls.push(request);
      return { taskId, model: 'scripted', kind: calls.length === 1 ? 'navigate' : calls.length === 2 ? 'finish' : 'blocked',
        plan: calls.length === 1 ? [sizeMilestone] : [], milestoneId: 'r1', branches: [],
        reviews: calls.length === 2 ? [{ milestoneId: 'r1', evidence: [request.screen.elements.find(e => e.label === 'Font Size')!.id] }] : [],
        objective: 'Set the size', context: '', message: 'Unverified' };
    };
    const { host, state } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('blocked');
    expect(desk.acts).toHaveLength(1);
    expect(calls[1].handoff).toMatchObject({ completion: 'incomplete', remainingRequirements: ['r1'],
      next: 'continue_remaining_work' });
    expect(calls[1].handoff.completionProposal.evidence.join()).toContain('Font Size');
    expect(calls[2].issues.join(' ')).toContain('supported only by a field');
    expect(calls[1].effects[0]).toMatchObject({ text: '24', readback: '24', readbackExpected: '24',
      outcome: 'confirmed', outcomeSource: 'readback' });
  });

  it('retains the ledger across objective-scoped sessions and finishes only after readback evidence', async () => {
    const desk = new Desk();
    const { provider, requests } = planner((request, call) => call === 1
      ? { kind: 'act', requirementId: 'r1', operation: 'SET_VALUE', target: id(request, 'Font Size'), text: '24', textIsLiteral: true }
      : call === 2 ? { kind: 'yield', message: 'The value has been entered; returning to the parent.' }
      : call === 3 ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, 'Apply') }
      : { kind: 'finish', reconciliations: [{ effectId: 'fx2', outcome: 'confirmed', evidence: [id(request, 'Applied size')] }],
          statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')],
            checks: [{ kind: 'text_equals', target: id(request, 'Applied size'), value: '24 pt' }] }] });
    const calls: any[] = [];
    provider.orchestrate = async request => {
      calls.push(request);
      return { taskId, model: 'scripted', kind: calls.length === 3 ? 'finish' : 'navigate',
        plan: calls.length === 1 ? [sizeMilestone] : [], milestoneId: 'r1', branches: [], reviews: calls.length === 3 ? reviewSize(request) : [],
        objective: calls.length === 1 ? 'Enter 24' : 'Apply and verify the setting',
        context: calls.length === 1 ? 'Use the observed font size control.' : '24 was entered already; apply it without typing again.',
        message: 'Verified font size.' };
    };
    const { host, state } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('completed');
    expect(calls).toHaveLength(3);
    expect(requests[2].mission?.context).toContain('entered already');
    expect(requests[1].effects[0].id).toBe('fx1');
    expect(calls[1].effects[0].operation).toBe('SET_VALUE');
    expect(calls[1].effects[0].text).toBe('24');
    expect(calls[1].handoff).toMatchObject({ outcome: 'yielded', next: 'continue_remaining_work', unresolvedEffects: [] });
    expect(calls[2].requirements[0].status).toBe('open');
    expect(calls[2].handoff.completionProposal.evidence.join()).toContain('24 pt');
    expect(desk.acts.map(a => a.operation)).toEqual(['SET_VALUE', 'CLICK']);
  });

  it('continues correcting unsupported completion until interrupted without sending input', async () => {
    const desk = new Desk();
    const abort = new AbortController();
    let calls = 0;
    const { provider } = planner(() => { throw new Error('No navigation should run'); });
    provider.orchestrate = async request => {
      if (++calls > 1) expect(request.issues.join()).toContain('Finish refused');
      if (calls === 15) abort.abort();
      return { taskId: request.taskId, model: 'scripted', kind: 'finish',
        objective: '', context: '', message: 'Done without evidence', plan: [], milestoneId: '', branches: [], reviews: [] };
    };
    const { host, state } = makeHost({ orchestration: true });
    await expect(new NavigationOrchestrator(desk, provider).advance(host, false, abort.signal)).rejects.toThrow();
    expect(calls).toBe(15);
    expect(state.status).not.toBe('blocked');
    expect(state.completion).toBeUndefined();
    expect(desk.acts).toHaveLength(0);
  });

  it('recovers after more than twelve invalid parent proposals and completes from evidence', async () => {
    const desk = new Desk();
    const { provider } = planner(request => ({ kind: 'yield', statuses: [
      { requirementId: 'r1', status: 'evidenced', evidence: [id(request, 'Applied size')], checks: [] }] }));
    let calls = 0;
    provider.orchestrate = async request => {
      calls++;
      return { taskId: request.taskId, model: 'scripted', kind: calls === 15 ? 'navigate' : 'finish',
        objective: calls === 15 ? 'Inspect the applied size' : '', context: '', 
        message: 'Size inspected.', plan: calls === 15 ? [sizeMilestone] : [],
        milestoneId: calls === 15 ? 'r1' : '', branches: [], reviews: calls === 16 ? reviewSize(request) : [] };
    };
    const { host, state } = makeHost({ orchestration: true });
    await new NavigationOrchestrator(desk, provider).advance(host, false, new AbortController().signal);
    expect(calls).toBe(16);
    expect(state.status).toBe('completed');
    expect(desk.acts).toHaveLength(0);
  });

  it('honours cancellation between orchestration and the first action', async () => {
    const desk = new Desk(), abort = new AbortController();
    const { provider } = planner(() => { throw new Error('Must not call navigator'); });
    provider.orchestrate = async request => { abort.abort(); return { taskId: request.taskId, model: 'scripted',
      kind: 'navigate', objective: 'Apply', context: '', message: '', plan: [sizeMilestone], milestoneId: 'r1', branches: [], reviews: [] }; };
    const { host } = makeHost({ orchestration: true });
    await expect(new NavigationOrchestrator(desk, provider).advance(host, false, abort.signal)).rejects.toThrow();
    expect(desk.acts).toHaveLength(0);
  });
});

it('does not retry an unresolved requirement through a different control', async () => {
  const desk = new Desk();
  const { provider, requests } = planner((request, call) => call <= 2
    ? { kind: 'act', requirementId: 'r1', operation: 'CLICK', target: id(request, call === 1 ? 'Send' : 'Apply') }
    : { kind: 'blocked', message: 'Inspect the first result before another mutation.' });
  const { host } = makeHost();
  await run(desk, provider, host);
  expect(desk.acts.map(a => a.name)).toEqual(['Send']);
  expect(requests[2].issues.join(' ')).toContain('even through a different control or window');
});
