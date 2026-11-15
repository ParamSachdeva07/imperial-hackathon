import { beforeAll, describe, expect, it } from 'vitest';
import { accessibilityTree, flattenTree } from '../apps/desktop/electron/desktop/accessibility-tree';
import { NativeError } from '../apps/desktop/electron/desktop/native-client';
import type { WorkspaceBridge } from '../apps/desktop/electron/desktop/workspace';
import type { ActionReport } from '../apps/desktop/electron/desktop/action-verification';
import { BrokerError, type DecisionProvider } from '../apps/desktop/electron/services/decision-client';
import { Ledger } from '../apps/desktop/electron/controller/ledger';
import { NavigationController } from '../apps/desktop/electron/controller/navigation';
import { Navigator, SETTLE, type Host } from '../apps/desktop/electron/controller/navigator';
import { Orchestrator, RETRY } from '../apps/desktop/electron/controller/orchestrator';
import {
  OrchestratorResultSchema, PlanStepSchema, TaskInputSchema, type ControllerState, type DesktopCandidate, type DesktopContext, type DesktopObservation, type Mission,
  type OrchestratorRequest, type OrchestratorResult, type PlanRequest, type PlanStep,
} from '../packages/contracts/src/index';

const taskId = '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe';
beforeAll(() => { SETTLE.intervalMs = 1; SETTLE.capMs = 30; RETRY.baseMs = 1; });

/** A tiny application: a size box that never applies, an Apply button that does, and a Send button. */
class Desk implements WorkspaceBridge {
  revision = 0;
  acts: { operation: string; name: string; text?: string; key?: string }[] = [];
  reads: DesktopContext[] = [];
  opened: string[] = [];
  searches: string[] = [];
  model = { size: '12', boxValue: '12', sent: 0, focused: 'Body' };
  fail?: Error;
  report?: ActionReport;
  searchable = true;
  applications = async () => [{ name: 'Example', id: 'example', running: true }];
  private tree() {
    const s = this.revision, m = this.model;
    let n = 0;
    const ref = () => '@s' + s + ':e' + ++n;
    return { role: 'window', name: 'Document', ref_id: ref(), available_actions: [], states: [], children: [
      { role: 'toolbar', name: 'Formatting', ref_id: ref(), available_actions: [], states: [], children: [
        { role: 'combobox', name: 'Font Size', value: m.boxValue, ref_id: ref(), available_actions: ['SetValue', 'SetFocus'],
          states: m.focused === 'Font Size' ? ['focused'] : [] },
        { role: 'button', name: 'Apply', ref_id: ref(), available_actions: ['Click'], states: [] },
        { role: 'button', name: 'Send', ref_id: ref(), available_actions: ['Click'], states: [] },
        { role: 'button', name: 'Decoration', ref_id: ref(), available_actions: ['Click'], states: [] },
      ] },
      { role: 'textarea', name: 'Body', value: 'hello', ref_id: ref(), available_actions: ['SetValue', 'SetFocus'],
        states: m.focused === 'Body' ? ['focused'] : [] },
      { role: 'statictext', name: 'Applied size', value: m.size + ' pt' },
      { role: 'statictext', name: 'Outbox', value: m.sent + ' sent' },
    ] };
  }
  async observe(context: DesktopContext): Promise<DesktopObservation> {
    this.revision++;
    this.reads.push(context);
    const raw = this.tree();
    return { id: 'o' + this.revision, capturedAt: this.revision, applications: await this.applications(),
      windows: [{ id: 'w1', title: 'Document', app: 'Example', focused: true }], notices: [],
      context: { app: 'Example', windowId: 'w1', surface: context.surface || 'window' },
      snapshots: context.surface && context.surface !== 'window' ? [] : [{ id: 's' + this.revision, app: 'Example', windowId: 'w1',
        windowTitle: 'Document', surface: 'window', complete: true, capturedAt: this.revision, tree: accessibilityTree(raw), elements: flattenTree(raw) }] };
  }
  async probe(_ref: string, property: 'states' | 'bounds') {
    return property === 'bounds' ? { x: 1 } : { states: this.model.focused === 'Body' ? ['focused'] : [] };
  }
  async act(candidate: DesktopCandidate, observation: DesktopObservation, text?: string) {
    this.report = undefined;
    if (candidate.operation === 'FOCUS_WINDOW') return observation.context;
    this.acts.push({ operation: candidate.operation, name: candidate.name, text, key: candidate.key });
    if (this.fail) { const error = this.fail; this.fail = undefined; throw error; }
    if (candidate.operation === 'SET_VALUE' && candidate.name === 'Font Size') {
      this.model.boxValue = text!;
      this.report = { operation: 'SET_VALUE', target: 'Font Size', delivery: 'delivered_verified', verification: 'verified', expectedValue: text, observedValue: text };
    }
    if (candidate.operation === 'CLICK' && candidate.name === 'Apply') this.model.size = this.model.boxValue;
    if (candidate.operation === 'CLICK' && candidate.name === 'Send') this.model.sent++;
    return observation.context;
  }
  async openUrl(url: string) { this.opened.push(url); return { app: 'Example' }; }
  canSearchWeb() { return this.searchable; }
  async searchWeb(text: string) { this.searches.push(text); return { app: 'Example' }; }
  takeActionReport() { const report = this.report; this.report = undefined; return report; }
}

const mission = (over: Partial<Mission> = {}): Mission => ({ objective: 'Make the text 24 pt', doneWhen: 'Applied size reads 24 pt',
  context: 'Use the value 24.', irreversible: false, ...over });
const id = (request: PlanRequest, label: string) => request.elements.find(e => e.label === label)!.id;
const yielded = (request: PlanRequest, status: NonNullable<PlanStep['report']>['status'] = 'done', labels: string[] = []): Partial<PlanStep> =>
  ({ kind: 'yield', report: { status, summary: 'Reported ' + status + '.', evidence: labels.map(label => id(request, label)) } });

type Luna = (request: OrchestratorRequest, call: number) => Partial<OrchestratorResult>;
function models(script: (request: PlanRequest, call: number) => Partial<PlanStep>, luna: Luna = () => ({ next: 'finish', message: 'Done.' })) {
  const requests: PlanRequest[] = [], lunaRequests: OrchestratorRequest[] = [];
  const provider: DecisionProvider = {
    plan: async request => {
      requests.push(structuredClone(request));
      return { taskId: request.taskId, observationId: request.observationId, model: 'scripted', reconciliations: [], kind: 'yield',
        operation: '', target: '', text: '', key: '', direction: '', risk: 'reversible', expect: '', query: '', scope: '', waitMs: 0,
        report: null, ...script(request, requests.length) } as PlanStep;
    },
    orchestrate: async request => {
      lunaRequests.push(structuredClone(request));
      return { taskId: request.taskId, model: 'luna', next: 'continue', objective: 'Make the text 24 pt', doneWhen: 'Applied size reads 24 pt',
        context: '', irreversible: false, plan: [], message: '', ...luna(request, lunaRequests.length) } as OrchestratorResult;
    },
  };
  return { provider, requests, lunaRequests };
}
function makeHost(over: Record<string, unknown> = {}) {
  const state: ControllerState = { taskId, status: 'idle', busy: true, step: 0, events: [], plan: [], completion: null, question: null,
    input: TaskInputSchema.parse({ goal: 'Make the text 24 pt', ...over }) };
  const traces: { kind: string; data: any }[] = [];
  const host: Host = { state, status: (status, message) => { state.status = status; state.events.push({ id: state.events.length, at: 0, taskId, type: 'state', message }); },
    event: () => {}, trace: (kind, data) => traces.push({ kind, data: structuredClone(data) }) };
  return { host, state, traces };
}
function session(desk: Desk, provider: DecisionProvider, host: Host, assignment = mission(), answer?: string, navigator = new Navigator(desk, provider)) {
  navigator.begin(taskId, host.state.input!);
  return { navigator, result: navigator.run(host, assignment, new AbortController().signal, answer) };
}
const signal = () => new AbortController().signal;

describe('the ledger: one rule about sending an action again', () => {
  const effect = (ledger: Ledger, step: number, delivery: 'delivered' | 'uncertain') => Object.assign(
    ledger.propose({ step, operation: 'PRESS', args: { key: 'return' }, targetLabel: 'return', risk: 'reversible', expect: '' }), { delivery });
  it('holds back an identical action straight after it was sent with no result, and lets it through once the screen was looked at', () => {
    const ledger = new Ledger();
    effect(ledger, 4, 'delivered');
    expect(ledger.retryBlock(5, 'PRESS', { key: 'return' })?.id).toBe('fx1');
    expect(ledger.retryBlock(6, 'PRESS', { key: 'return' })).toBeUndefined();
    expect(ledger.retryBlock(5, 'PRESS', { key: 'escape' })).toBeUndefined();
  });
  it('holds back an action that may or may not have arrived until someone settles it', () => {
    const ledger = new Ledger();
    effect(ledger, 1, 'uncertain');
    expect(ledger.retryBlock(9, 'PRESS', { key: 'return' })?.id).toBe('fx1');
    expect(ledger.settle('fx1', 'refuted', 'navigator', 0)).toMatch(/cited element/);
    expect(ledger.settle('fx1', 'refuted', 'navigator', 1)).toBeUndefined();
    expect(ledger.retryBlock(9, 'PRESS', { key: 'return' })).toBeUndefined();
  });
  it('never lets a model overrule what the controller itself observed', () => {
    const ledger = new Ledger();
    effect(ledger, 1, 'delivered');
    ledger.settle('fx1', 'confirmed', 'observed_change');
    ledger.settle('fx1', 'refuted', 'navigator', 1);
    expect(ledger.effects[0].outcome).toBe('confirmed');
  });
});

describe('a navigator session', () => {
  it('reads a step exactly as the broker sends it, with empty fields left out', () => {
    const wire = { taskId, observationId: 'o1', model: 'm', reconciliations: [], kind: 'act', operation: 'OPEN_URL', target: '',
      text: 'https://twitch.tv', key: '', direction: '', risk: 'reversible', expect: '', query: '', scope: '', waitMs: 0 };
    expect(PlanStepSchema.parse(wire).report).toBeUndefined();
    expect(OrchestratorResultSchema.parse({ taskId, model: 'm', next: 'finish', objective: '', doneWhen: '', context: '',
      irreversible: false, plan: [], message: 'Done.' }).usage).toBeUndefined();
  });

  it('acts, sees the result, and returns one object saying what is true and where things stand', async () => {
    const desk = new Desk();
    const { provider, requests } = models((request, call) => call === 1 ? { kind: 'act', operation: 'SET_VALUE', target: id(request, 'Font Size'), text: '24' }
      : call === 2 ? { kind: 'act', operation: 'CLICK', target: id(request, 'Apply') } : yielded(request, 'done', ['Applied size']));
    const { host } = makeHost();
    const result = await session(desk, provider, host).result;
    expect(result).toMatchObject({ status: 'done', steps: 3, unresolved: [], location: { app: 'Example', window: 'Document', address: '' } });
    expect(result!.facts).toEqual(['statictext "Applied size" = "24 pt"']);
    expect(requests[0].mission.objective).toBe('Make the text 24 pt');
    // The write was confirmed by its read-back and the click by the screen changing; nobody had to be asked.
    expect(requests[2].effects.map(e => [e.operation, e.outcome])).toEqual([['SET_VALUE', 'confirmed'], ['CLICK', 'confirmed']]);
  });

  it('treats prose in place of an element id as a refused citation, and a malformed step as a model slip', async () => {
    const desk = new Desk();
    desk.fail = new NativeError('TIMEOUT', 'The helper timed out.', { delivery: 'unknown' });
    const { provider, requests } = models((request, call) => call === 1 ? { kind: 'act', operation: 'CLICK', target: id(request, 'Send') }
      : call === 2 ? { kind: 'wait', waitMs: 1, reconciliations: [{ effectId: 'fx1', outcome: 'confirmed', evidence: ['The Outbox counter now reads one message sent, which shows it worked.'] }] }
      : call === 3 ? { kind: 'bogus' as never } : yielded(request));
    const { navigator, result } = session(desk, provider, makeHost().host);
    await expect(result).rejects.toMatchObject({ retryable: true });
    expect(requests[2].issues.join(' ')).toMatch(/not on the current screen/);
    expect(navigator.hasUncertainActions()).toBe(true);
  });

  it('accepts a key under another name and a search that names a scope', async () => {
    const desk = new Desk();
    const { provider } = models((request, call) => call === 1 ? { kind: 'act', operation: 'PRESS', key: 'Enter' }
      : call === 2 ? { kind: 'find', scope: 'surface:menubar' } : yielded(request));
    await session(desk, provider, makeHost().host).result;
    expect(desk.acts).toEqual([{ operation: 'PRESS', name: 'return', text: undefined, key: 'return' }]);
    expect(desk.reads.some(context => context.surface === 'menubar')).toBe(true);
  });

  it('lets the same control be used again as soon as the screen answered the first time', async () => {
    const desk = new Desk();
    const { provider } = models((request, call) => call <= 3 ? { kind: 'act', operation: 'CLICK', target: id(request, 'Send') } : yielded(request));
    const result = await session(desk, provider, makeHost().host, mission({ irreversible: false })).result;
    expect(desk.model.sent).toBe(3);
    expect(result!.unresolved).toEqual([]);
  });

  it('makes the navigator look before repeating an action that changed nothing', async () => {
    const desk = new Desk();
    const click = (request: PlanRequest): Partial<PlanStep> => ({ kind: 'act', operation: 'CLICK', target: id(request, 'Decoration') });
    const { provider, requests } = models((request, call) => call <= 2 ? click(request) : call === 3 ? { kind: 'read', scope: 'surface:menubar' }
      : call === 4 ? { kind: 'read', scope: 'surface:window' } : call === 5 ? click(request) : yielded(request, 'progress'));
    const result = await session(desk, provider, makeHost().host).result;
    expect(desk.acts).toHaveLength(2);
    expect(requests[2].issues.join(' ')).toMatch(/nothing has changed yet/);
    expect(result!.unresolved).toHaveLength(2);
  });

  it('returns to Luna when the same refused step comes a third time, instead of ending the task', async () => {
    const desk = new Desk();
    const { provider, requests } = models(() => ({ kind: 'act', operation: 'CLICK', target: 'e999' }));
    const result = await session(desk, provider, makeHost().host).result;
    expect(requests).toHaveLength(3);
    expect(result).toMatchObject({ status: 'progress', steps: 3 });
    expect(result!.summary).toMatch(/three times/);
    expect(desk.acts).toEqual([]);
  });

  it('opens a site by its front page and refuses an inner address nobody supplied', async () => {
    const desk = new Desk();
    const { provider, requests } = models((request, call) => call === 1 ? { kind: 'act', operation: 'OPEN_URL', text: 'https://www.gov.uk/check-uk-visa' }
      : call === 2 ? { kind: 'act', operation: 'SET_VALUE', target: id(request, 'Body'), text: 'see gov.uk/check-uk-visa' }
      : call === 3 ? { kind: 'act', operation: 'OPEN_URL', text: 'https://www.youtube.com' }
      : call === 4 ? { kind: 'act', operation: 'SEARCH_WEB', text: 'UKVI view immigration status' } : yielded(request));
    await session(desk, provider, makeHost().host).result;
    expect(desk.opened).toEqual(['https://www.youtube.com/']);
    expect(desk.searches).toEqual(['UKVI view immigration status']);
    expect(desk.acts).toEqual([]);
    expect(requests[1].issues.join(' ')).toMatch(/neither supplied by the user nor seen/);
    expect(requests[0].tools).toEqual(['OPEN_URL', 'SEARCH_WEB']);
  });

  it('offers web search only where the browser can run one', async () => {
    const desk = new Desk();
    desk.searchable = false;
    const { provider, requests } = models((request, call) => call === 1 ? { kind: 'act', operation: 'SEARCH_WEB', text: 'cats' } : yielded(request));
    await session(desk, provider, makeHost().host).result;
    expect(requests[0].tools).toEqual(['OPEN_URL']);
    expect(desk.searches).toEqual([]);
  });

  it('sends an irreversible action only in a session Luna opened for it, and asks the user once when asked to confirm', async () => {
    const send = (request: PlanRequest): Partial<PlanStep> => ({ kind: 'act', operation: 'CLICK', target: id(request, 'Send'), risk: 'irreversible' });
    const refused = new Desk();
    const first = models((request, call) => call === 1 ? send(request) : yielded(request, 'needs_decision'));
    await session(refused, first.provider, makeHost().host).result;
    expect(refused.model.sent).toBe(0);
    expect(first.requests[1].issues.join(' ')).toMatch(/not given an irreversible action/);

    const desk = new Desk();
    const { provider } = models((request, call) => call <= 2 ? send(request) : yielded(request, 'done', ['Outbox']));
    const { host, state } = makeHost();
    const assignment = mission({ objective: 'Send the message', irreversible: true });
    const { navigator, result } = session(desk, provider, host, assignment);
    expect(await result).toBeUndefined();
    expect(state.status).toBe('needs_user');
    expect(state.question?.text).toMatch(/cannot be undone/);
    expect(desk.model.sent).toBe(0);
    const resumed = await navigator.run(host, assignment, signal(), 'yes');
    expect(desk.model.sent).toBe(1);
    expect(resumed).toMatchObject({ status: 'done', facts: ['statictext "Outbox" = "1 sent"'] });

    const unprompted = new Desk();
    const third = models((request, call) => call === 1 ? send(request) : yielded(request));
    await session(unprompted, third.provider, makeHost({ confirmIrreversible: false }).host, assignment).result;
    expect(unprompted.model.sent).toBe(1);
  });

  it('records an action whose delivery is unknown and will not send it again blind', async () => {
    const desk = new Desk();
    desk.fail = new NativeError('TIMEOUT', 'The helper timed out.', { delivery: 'unknown' });
    const { provider, requests } = models((request, call) => call <= 2 ? { kind: 'act', operation: 'CLICK', target: id(request, 'Send') } : yielded(request, 'unverified'));
    const { navigator, result } = session(desk, provider, makeHost().host);
    expect((await result)!.unresolved[0]).toMatch(/may or may not have been delivered/);
    expect(desk.acts).toHaveLength(1);
    expect(requests[2].issues.join(' ')).toMatch(/may or may not have arrived/);
    expect(navigator.hasUncertainActions()).toBe(true);
  });
});

describe('Luna and the sessions she runs', () => {
  const act = (request: PlanRequest, call: number): Partial<PlanStep> => call % 2 ? { kind: 'act', operation: 'CLICK', target: id(request, 'Send') } : yielded(request, 'done', ['Outbox']);

  it('assigns a session, reads its result and finishes: the only two Luna calls a one-step request needs', async () => {
    const desk = new Desk();
    const { provider, lunaRequests } = models(act, (request, call) => call === 1
      ? { next: 'continue', objective: 'Press Send', plan: [{ text: 'Send it', status: 'todo' }] }
      : { next: 'finish', message: 'Sent.', plan: [{ text: 'Send it', status: 'done' }] });
    const { host, state, traces } = makeHost({ context: 'The document is already open.' });
    await new Orchestrator(desk, provider).advance(host, signal());
    expect(state.status).toBe('completed');
    expect(state.plan).toEqual([{ text: 'Send it', status: 'done' }]);
    expect(state.completion).toEqual({ summary: 'Sent.', facts: ['statictext "Outbox" = "1 sent"'], location: { app: 'Example', window: 'Document', address: '' } });
    expect(lunaRequests).toHaveLength(2);
    expect(lunaRequests[0]).toMatchObject({ goal: 'Make the text 24 pt', callerContext: 'The document is already open.', history: [] });
    expect(lunaRequests[1].history).toEqual([{ assignment: { objective: 'Press Send', doneWhen: 'Applied size reads 24 pt', context: '', irreversible: false },
      result: expect.objectContaining({ status: 'done', steps: 2 }) }]);
    // Luna reviews the very screen the navigator ended on: no second read between the session and her call.
    expect(lunaRequests[1].screen.elements.some(e => e.label === 'Outbox' && e.value === '1 sent')).toBe(true);
    expect(desk.reads.filter(context => (context.surface || 'window') === 'window')).toHaveLength(2);
    expect(traces.filter(t => t.kind === 'session_end')).toHaveLength(1);
  });

  it('keeps going for as many sessions as Luna asks for', async () => {
    const desk = new Desk();
    const { provider, lunaRequests } = models(act, (_request, call) => call <= 40 ? { next: 'continue' } : { next: 'finish', message: 'Done.' });
    const { host, state } = makeHost();
    await new Orchestrator(desk, provider).advance(host, signal());
    expect(state.status).toBe('completed');
    expect(desk.model.sent).toBe(40);
    expect(lunaRequests.at(-1)!.history.length).toBeGreaterThan(0);
    expect(JSON.stringify(lunaRequests.at(-1)!.history).length).toBeLessThanOrEqual(48_000);
  });

  it('takes "blocked" as Luna\'s decision and says so without asking anyone', async () => {
    const { provider } = models(act, () => ({ next: 'blocked', message: 'The site needs your sign-in code.' }));
    const { host, state } = makeHost();
    await new Orchestrator(new Desk(), provider).advance(host, signal());
    expect(state.status).toBe('blocked');
    expect(state.completion?.summary).toBe('The site needs your sign-in code.');
    expect(state.question).toBeNull();
  });

  it('labels a finish as unverified when an action may not have landed, without refusing Luna', async () => {
    const desk = new Desk();
    desk.fail = new NativeError('TIMEOUT', 'The helper timed out.', { delivery: 'unknown' });
    const { provider, lunaRequests } = models((request, call) => call === 1 ? { kind: 'act', operation: 'CLICK', target: id(request, 'Send') } : yielded(request, 'unverified'),
      (_request, call) => call === 1 ? { next: 'continue' } : { next: 'finish', message: 'The message was sent.' });
    const { host, state } = makeHost();
    await new Orchestrator(desk, provider).advance(host, signal());
    expect(state.status).toBe('completed_unverified');
    expect(lunaRequests).toHaveLength(2);
  });

  it('hands an adapter or model failure to Luna as a session result, and fails the task on anything else', async () => {
    const desk = new Desk();
    let calls = 0;
    const scripted = models((request) => yielded(request), (_request, call) => call <= 2 ? { next: 'continue' } : { next: 'finish', message: 'Done.' });
    const provider: DecisionProvider = { ...scripted.provider, plan: async (request, s) => {
      if (++calls === 1) throw new BrokerError('The navigator model is busy.', true);
      return scripted.provider.plan(request, s);
    } };
    const { host, state } = makeHost();
    await new Orchestrator(desk, provider).advance(host, signal());
    expect(state.status).toBe('completed');
    expect(scripted.lunaRequests[1].history[0].result).toMatchObject({ status: 'error', summary: expect.stringMatching(/busy/) });

    const broken: DecisionProvider = { ...models(() => ({}), () => ({ next: 'continue' })).provider,
      plan: async () => { throw new BrokerError('The API key was rejected.', false); } };
    await expect(new Orchestrator(new Desk(), broken).advance(makeHost().host, signal())).rejects.toThrow('rejected');
  });

  it('waits out a Luna outage, and retries a rejected request once with less history', async () => {
    const desk = new Desk();
    const seen: number[] = [];
    let failures = 0;
    const scripted = models((request) => yielded(request), (_request, call) => call <= 2 ? { next: 'continue' } : { next: 'finish', message: 'Done.' });
    const provider: DecisionProvider = { ...scripted.provider, orchestrate: async (request, s) => {
      seen.push(request.history.length);
      if (failures < 2) { failures++; throw new BrokerError('HTTP 503', true); }
      if (request.history.length === 2) throw new BrokerError('HTTP 400 (invalid_prompt)', false);
      return scripted.provider.orchestrate(request, s);
    } };
    const { host, state } = makeHost();
    await new Orchestrator(desk, provider).advance(host, signal());
    expect(state.status).toBe('completed');
    expect(seen).toEqual([0, 0, 0, 1, 2, 1]);
  });
});

describe('the task controller', () => {
  it('runs a request to the end, publishes its plan and result, and replaces a running task cleanly', async () => {
    const desk = new Desk();
    const { provider } = models((request, call) => call % 2 ? { kind: 'act', operation: 'CLICK', target: id(request, 'Send') } : yielded(request, 'done', ['Outbox']),
      (request) => request.history.length ? { next: 'finish', message: 'Sent.', plan: [{ text: 'Send', status: 'done' }] } : { next: 'continue' });
    const controller = new NavigationController(desk, provider);
    const finished = () => new Promise<ControllerState>(resolve => { const stop = controller.subscribe(state => { if (!state.busy) { stop(); resolve(state); } }); });
    expect(() => controller.start({ goal: '' })).toThrow();
    controller.start({ goal: 'Send it' });
    expect(() => controller.start({ goal: 'Another' })).toThrow(/still running/);
    const first = await finished();
    expect(first).toMatchObject({ status: 'completed', plan: [{ text: 'Send', status: 'done' }], completion: { summary: 'Sent.' } });
    controller.start({ goal: 'Send it again' });
    const replaced = await controller.replace({ goal: 'Send a third' });
    expect(replaced.input?.goal).toBe('Send a third');
    expect((await finished()).status).toBe('completed');
    expect(controller.cancel().status).toBe('completed');
  });
});
