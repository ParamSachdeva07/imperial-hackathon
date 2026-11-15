import { setTimeout as delay } from 'node:timers/promises';
import {
  PlanStepSchema,
  type ControllerState, type DesktopCandidate, type DesktopContext, type DesktopObservation, type Location, type Mission,
  type OrchestratorRequest, type PlanOperation, type PlanRequest, type PlanStep, type SessionResult, type TaskInput, type TaskStatus,
} from '../../../../packages/contracts/src/index';
import { KEYS, validatedUrl, type WorkspaceBridge } from '../desktop/workspace';
import { PAGE_KEYS } from '../page/page-workspace';
import { NativeError } from '../desktop/native-client';
import { BrokerError, type DecisionProvider } from '../services/decision-client';
import { Ledger, VIEW_OPERATIONS, WRITE_OPERATIONS, type Delivery, type Effect } from './ledger';
import type { ElementIdentity } from './identity';
import { MenuIndex } from './menu-index';
import { ObservationIndex, type IndexedNode } from './observation-index';
import { contentKey, pageContentKey, settle } from './settle';
import { clip } from './text';
import { inventedAddresses } from './url-provenance';

export type Host = {
  state: ControllerState;
  status(status: TaskStatus, message: string): void;
  event(type: 'observation' | 'decision' | 'target' | 'step' | 'result', message: string, details?: Record<string, unknown>): void;
  trace?(kind: string, data: unknown): void;
};

const START_DEPTH = 8;
/** How long an action is given to show a result before the navigator is asked again. Tests shorten it. */
export const SETTLE = { intervalMs: 150, capMs: 2000 };
const TEXT_OPERATIONS = new Set(['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE', 'SELECT']);
const POINTER_OPERATIONS = new Set(['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK']);
const POSTCONDITION_OPERATIONS = new Set(['CHECK', 'UNCHECK', 'EXPAND', 'COLLAPSE', 'FOCUS']);
const KEY_NAMES: Record<string, string> = { enter: 'return', esc: 'escape', spacebar: 'space', command: 'cmd', control: 'ctrl',
  option: 'alt', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };
/** Models name keys many ways; the adapters know one spelling. */
const keyName = (key: string) => key.trim().toLowerCase().split('+').map(part => KEY_NAMES[part.trim()] ?? part.trim()).join('+');
const rowText = (node: IndexedNode) => clip(node.role + ' ' + JSON.stringify(node.label) +
  (node.value ? ' = ' + JSON.stringify(node.value) : '') + (node.states.length ? ' [' + node.states.join(',') + ']' : ''), 700);

type View = { observation: DesktopObservation; index: ObservationIndex };
type Task = {
  taskId: string;
  input: TaskInput;
  ledger: Ledger;
  context: DesktopContext;
  view?: View;
  previous?: { viewKey: string; facts: string[] };
  /** Addresses this task has actually been on. */
  seenUrls: Set<string>;
  /** Applications whose windows are too heavy for one direct deep read; read them layer by layer. */
  shallow: Set<string>;
  menu: MenuIndex;
  // The session in progress.
  mission?: Mission;
  steps: number;
  query: string;
  issues: string[];
  /** How often each step that sent nothing was proposed against the same screen. */
  repeats: Map<string, number>;
  pending?: { text: string; approval: string };
  approvals: Set<string>;
  /** What the last report pointed at, so Luna is shown the same elements. */
  cited: ElementIdentity[];
};

/**
 * Runs one session for Luna: observe, ask the navigator model for one step, check it, send it
 * once, read the result. It never ends a task; it returns what happened and where things stand.
 */
export class Navigator {
  private task?: Task;
  private browser?: Promise<string | undefined>;
  constructor(private bridge: WorkspaceBridge, private provider: DecisionProvider,
    /** Resolves the bundle id that opens web links for this user. */
    private defaultBrowser?: () => Promise<string | undefined>) {}

  begin(taskId: string, input: TaskInput) {
    if (this.task?.taskId === taskId) return;
    this.task = { taskId, input, ledger: new Ledger(), context: input.app ? { app: input.app } : {}, seenUrls: new Set(),
      shallow: new Set(), menu: new MenuIndex(), steps: 0, query: '', issues: [], repeats: new Map(), approvals: new Set(), cited: [] };
  }
  /** Whether an action of this task may or may not have reached the application. */
  hasUncertainActions() { return !!this.task?.ledger.uncertain().length; }

  private depth(t: Task, app = t.context.app) {
    return { startDepth: app && t.shallow.has(app) ? 3 : START_DEPTH, query: t.query || t.mission?.objective || t.input.goal };
  }
  private index(t: Task, observation: DesktopObservation) {
    return new ObservationIndex(observation, { allowPhysical: t.input.allowPhysical });
  }
  private adopt(t: Task, observation: DesktopObservation, index = this.index(t, observation)): View {
    // A failed direct read costs its whole timeout, so it is tried once per application.
    if (observation.context.app && observation.notices.some(n => n.startsWith('A direct deep read did not complete')))
      t.shallow.add(observation.context.app);
    for (const notice of observation.notices) if (notice.startsWith('Page address: ')) t.seenUrls.add(notice.slice(14));
    t.context = observation.context;
    return t.view = { observation, index };
  }
  private async look(t: Task, host: Host, signal: AbortSignal): Promise<View> {
    if (t.view) return t.view;
    host.status('observing', 'Reading applications, windows and the current accessibility tree.');
    const started = Date.now();
    const view = this.adopt(t, await this.bridge.observe(t.context, signal, this.depth(t)));
    signal.throwIfAborted();
    host.trace?.('observation', { id: view.observation.id, viewKey: view.index.viewKey(), nodes: view.index.nodes.length, nativeMs: Date.now() - started });
    return view;
  }
  private tools(): PlanOperation[] {
    return [...(this.bridge.openUrl ? ['OPEN_URL' as const] : []), ...(this.bridge.canSearchWeb?.() ? ['SEARCH_WEB' as const] : [])];
  }
  private allowedKeys({ context, snapshots, windows }: DesktopObservation): string[] {
    if (context.driver === 'browser') return snapshots[0] ? PAGE_KEYS : [];
    return snapshots[0]?.complete && context.windowId && windows.some(w => w.id === context.windowId && w.focused) ? KEYS : [];
  }
  /** The window's own title, also while only one region or surface of it is being read. */
  private windowTitle(observation?: DesktopObservation): string {
    const snapshot = observation?.snapshots[0];
    return observation?.windows.find(w => w.id === observation.context.windowId)?.title || snapshot?.tree?.name || snapshot?.windowTitle || '';
  }
  private location(t: Task): Location {
    const observation = t.view?.observation;
    return { app: t.context.app || '', window: clip(this.windowTitle(observation), 300),
      address: observation?.notices.find(n => n.startsWith('Page address: '))?.slice(14) || '' };
  }
  private result(t: Task, status: SessionResult['status'], summary: string, facts: string[] = []): SessionResult {
    return { status, summary: clip(summary, 1500), facts: facts.slice(0, 12), location: this.location(t),
      unresolved: t.ledger.unknown().slice(-8).map(e => t.ledger.describe(e)), steps: t.steps };
  }
  /** A session that ended in an adapter or model failure, with the ledger as it stands. */
  failed(message: string): SessionResult {
    const t = this.task!;
    t.view = undefined;
    return this.result(t, 'error', message);
  }

  /** What Luna is shown: the same screen and element ids the navigator last saw. */
  async screen(host: Host, signal: AbortSignal): Promise<OrchestratorRequest['screen']> {
    const t = this.task!;
    const { observation, index } = await this.look(t, host, signal);
    const snapshot = observation.snapshots[0];
    const selected = index.select({ query: '', requirementTerms: [t.input.goal, t.mission?.objective ?? '', t.mission?.doneWhen ?? ''], pinned: t.cited, limit: 60 });
    const { app, window: title, address } = this.location(t);
    return { app, title, address, driver: observation.context.driver || 'native', complete: snapshot?.complete === true,
      notices: observation.notices.slice(0, 12).map(n => clip(n, 1000)), elements: selected.elements, scopes: selected.scopes, tools: this.tools() };
  }

  /** Returns the session's result, or nothing when it stopped to ask the user about an irreversible action. */
  async run(host: Host, mission: Mission, signal: AbortSignal, answer?: string): Promise<SessionResult | undefined> {
    const { state } = host, t = this.task!, input = t.input;
    if (t.mission !== mission) Object.assign(t, { mission, steps: 0, query: '', issues: [], repeats: new Map(), pending: undefined });
    if (t.pending) {
      const pending = t.pending;
      t.pending = undefined;
      state.question = null;
      if (answer !== undefined && /^\s*(y|yes|allow|confirm|ok|okay|go ahead|do it)\b/i.test(answer)) t.approvals.add(pending.approval);
      else t.issues.push('The user did not allow this irreversible action. Do not propose it again.');
    }

    for (;;) {
      signal.throwIfAborted();
      const view = await this.look(t, host, signal);
      const { observation, index } = view;
      // On a web page the application's menu bar is rarely the route, and reading it costs more than the page does.
      const menu = t.context.app && observation.snapshots.length && observation.context.driver !== 'browser'
        ? await t.menu.nodes(t.context.app, this.bridge, signal) : [];
      index.adopt(menu);
      const selection = index.select({ query: t.query, requirementTerms: [mission.objective, mission.doneWhen],
        pinned: t.ledger.unknown().flatMap(e => (e.target ? [e.target] : [])), previous: t.previous, extra: menu });
      // Which browser a web address belongs in is the user's setting, not something to guess.
      const browser = (await (this.browser ??= this.defaultBrowser?.().catch(() => undefined) ?? Promise.resolve(undefined)))?.toLowerCase();
      if (browser) for (const element of selection.elements) {
        const node = element.role === 'application' ? index.get(element.id) : undefined;
        if (node?.appId?.toLowerCase() === browser && element.tags.length < 8) element.tags.push('default-browser');
      }
      const snapshot = observation.snapshots[0];
      const windowElement = (id?: string) => { const at = observation.windows.findIndex(w => w.id === id); return at < 0 ? '' : 'w' + at; };
      const request: PlanRequest = {
        taskId: t.taskId, observationId: observation.id, goal: input.goal, mission, effects: t.ledger.view(),
        observation: {
          // Windows are named by their element ids so they can be cited and targeted like any element.
          app: t.context.app || '', windowId: windowElement(t.context.windowId), windowTitle: clip(this.windowTitle(observation), 1000),
          surface: snapshot?.surface || (t.context.appSearch ? 'application search' : 'applications'), complete: snapshot?.complete === true,
          scope: (t.context.scopePath || []).map(p => clip(p.name, 300)), outline: index.outline().map(line => clip(line, 300)),
          windows: observation.windows.slice(0, 40).map(w => ({ id: windowElement(w.id), title: clip(w.title, 1000), focused: w.focused })),
          notices: observation.notices.slice(0, 12).map(n => clip(n, 1000)),
        },
        elements: selection.elements, scopes: selection.scopes, allowedKeys: this.allowedKeys(observation), tools: this.tools(),
        query: t.query, issues: t.issues.slice(-8).map(issue => clip(issue, 600)),
      };
      host.trace?.('plan_request', request);
      host.status('deciding', 'Planning the next step.');
      const started = Date.now();
      const parsed = PlanStepSchema.safeParse(await this.provider.plan(request, signal));
      // A malformed step is a model slip, not a defect: Luna gets the session back and carries on.
      if (!parsed.success) throw new BrokerError('The navigator returned a malformed step (' + parsed.error.issues[0]?.path.join('.') + ').', true);
      const step = parsed.data;
      signal.throwIfAborted();
      if (step.taskId !== t.taskId || step.observationId !== observation.id) throw new Error('Rejected a stale or mismatched plan step.');
      state.step++;
      t.steps++;
      host.trace?.('plan_step', { step, durationMs: Date.now() - started });

      // Forgive the two slips that carry no risk: a key under another name, and a search that names a scope.
      step.key = keyName(step.key);
      const scopeIds = new Set(request.scopes.map(scope => scope.id));
      if (step.kind === 'find' && (scopeIds.has(step.query.trim()) || (!step.query.trim() && scopeIds.has(step.scope))))
        Object.assign(step, { kind: 'read', scope: scopeIds.has(step.query.trim()) ? step.query.trim() : step.scope, query: '' });

      const sent = new Set(request.elements.map(e => e.id));
      const issues: string[] = [];
      const cite = (ids: string[]) => ids.flatMap(id => {
        const node = sent.has(id) ? index.get(id) : undefined;
        // Menu items come from a cached read of the menu bar, so they cannot show the current state.
        if (!node || node.kind === 'menu') { issues.push('Cited element ' + id + ' is not on the current screen.'); return []; }
        return [node];
      });
      for (const { effectId, outcome, evidence } of step.reconciliations) {
        const error = snapshot?.complete ? t.ledger.settle(effectId, outcome, 'navigator', cite(evidence).length)
          : 'An incomplete observation cannot reconcile an effect; read the relevant scope first.';
        if (error) issues.push(error);
      }
      const describe = step.kind === 'act' ? step.operation + ' → ' + (index.get(step.target)?.label || step.key || clip(step.text, 80))
        : step.kind === 'find' ? 'find ' + JSON.stringify(step.query) : step.kind === 'read' ? 'read ' + step.scope : step.kind;
      host.event('decision', 'Navigator: ' + describe, { kind: step.kind, model: step.model, durationMs: Date.now() - started, expect: step.expect, issues });
      t.issues = issues;

      if (step.kind === 'yield') {
        const cited = cite(step.report?.evidence ?? []);
        t.cited = cited.map(node => node.identity);
        const facts = cited.map(rowText);
        const report = step.report ?? { status: 'progress' as const, summary: 'The navigator returned without a report.' };
        host.event('result', 'Navigator returned: ' + report.summary);
        return this.result(t, report.status, report.summary, facts);
      }

      // A step that sends nothing and is proposed again against the same screen cannot make
      // progress: the same read shows the same content. Luna gets the screen back and decides
      // what to try instead. Only waiting is worth a second try, since a page may still be loading.
      const stalled = (reason: string): SessionResult | undefined => {
        const key = JSON.stringify([contentKey(index), step.kind, step.operation, step.target, step.text, step.key, step.direction, step.scope, step.query]);
        const count = (t.repeats.get(key) ?? 0) + 1;
        t.repeats.set(key, count);
        if (count < (step.kind === 'wait' ? 3 : 2)) return;
        host.event('result', 'The navigator repeated a step that changes nothing. Returning to Luna.');
        return this.result(t, 'progress', 'The navigator proposed "' + describe + '" again against an unchanged screen. ' + reason);
      };
      const refuse = (...messages: string[]) => {
        t.issues = [...issues, ...messages];
        host.event('result', 'Step not sent: ' + clip(messages.join(' '), 400));
        return stalled('The controller refused it: ' + messages.join(' '));
      };
      const reread = () => { t.previous = { viewKey: index.viewKey(), facts: index.facts() }; t.view = undefined; };

      if (step.kind === 'find') {
        const again = step.query.trim() ? stalled('Searching again cannot load anything new.') : refuse('find needs a query.');
        if (again) return again;
        if (!step.query.trim()) continue;
        t.query = clip(step.query, 300);
        // A web page is read again with the search words, so matches beyond its size limit are listed.
        if (observation.context.driver === 'browser') reread();
        else if (t.context.app) await t.menu.nodes(t.context.app, this.bridge, signal, 5000);
        continue;
      }
      if (step.kind === 'wait') {
        const again = stalled('Waiting longer has not changed it.');
        if (again) return again;
        await delay(Math.min(Math.max(step.waitMs, 250), 5000), undefined, { signal });
        reread();
        continue;
      }
      if (step.kind === 'read') {
        const next = await this.scope(step, t, index, observation, signal);
        const again = typeof next === 'string' ? refuse(next) : stalled('Reading the same scope again shows the same content.');
        if (again) return again;
        if (typeof next === 'string') continue;
        if (step.query) t.query = clip(step.query, 300);
        reread();
        t.context = next;
        continue;
      }

      // act: check the step against the live screen, then send it once.
      const operation = step.operation as PlanOperation | '';
      // A key meant for a named field goes to that field: give it keyboard focus first, then ask again.
      const named = operation === 'PRESS' && sent.has(step.target) ? index.get(step.target) : undefined;
      if (named?.element && named !== index.focused() && named.operations.includes('FOCUS')) {
        await this.bridge.act(this.candidate('focus', 'FOCUS', named, observation, {}), named.owner, undefined, input.allowPhysical, signal);
        t.issues = [...issues, named.label + ' did not have keyboard focus, so it was focused for you. No key was sent yet: press it now.'];
        host.event('result', 'Focused ' + named.label + ' before the key.');
        reread();
        continue;
      }
      let node: IndexedNode | undefined, recipient: IndexedNode | undefined, problem = '';
      const sources = [input.goal, input.context, ...t.seenUrls, ...index.nodes.flatMap(n => [n.label, n.value])];
      if (!operation) problem = 'act needs an operation.';
      else if (operation === 'PRESS') {
        recipient = index.focused();
        if (!request.allowedKeys.includes(step.key)) problem = 'Key ' + JSON.stringify(step.key) + ' is not available here. Available: ' + (request.allowedKeys.join(', ') || 'none') + '.';
        else if (step.target && index.get(step.target) !== recipient) problem = 'The named recipient does not have keyboard focus. Focus it first, then press the key.';
        // On a page, Return submits whatever has focus, so it must be tied to a known field.
        else if (observation.context.driver === 'browser' && step.key === 'return' && !recipient)
          problem = 'No field on this page has keyboard focus. Focus the field Return is meant for, or use the page\'s own button.';
      } else if (operation === 'OPEN_URL' || operation === 'SEARCH_WEB') {
        if (!request.tools.includes(operation)) problem = operation + ' is not available here.';
        else if (!step.text.trim()) problem = operation + ' needs text.';
        else if (operation === 'OPEN_URL') try { validatedUrl(step.text); } catch (error) { problem = (error as Error).message; }
      } else {
        node = sent.has(step.target) ? index.get(step.target) : undefined;
        if (!node) problem = 'act needs a target element id from the current observation.';
        else if (!node.operations.includes(operation)) problem = operation + ' is not offered on ' + node.label + '. Its operations: ' + (node.operations.join(', ') || 'none') + '.';
        else if (TEXT_OPERATIONS.has(operation) && !step.text) problem = operation + ' needs text.';
        else if (operation === 'SCROLL' && !step.direction) problem = 'SCROLL needs a direction.';
      }
      if (!problem && step.text && (TEXT_OPERATIONS.has(operation) || operation === 'OPEN_URL')) {
        const invented = inventedAddresses(step.text, sources);
        if (invented.length) problem = 'This address was neither supplied by the user nor seen on a page: ' + invented.join(', ') +
          '. A site\'s own front page may be opened by name; anything deeper must be reached through search, links or the site itself.';
      }
      const args: Effect['args'] = {};
      if (TEXT_OPERATIONS.has(operation) || operation === 'OPEN_URL' || operation === 'SEARCH_WEB') args.text = step.text;
      if (operation === 'PRESS') args.key = step.key;
      if (operation === 'SCROLL') args.direction = step.direction;
      const blocked = problem || !operation ? undefined : t.ledger.retryBlock(state.step, operation, args, node?.identity, recipient?.identity);
      if (blocked) problem = 'The same action was just sent as ' + blocked.id + ' and ' + (blocked.delivery === 'uncertain'
        ? 'may or may not have arrived' : 'nothing has changed yet') + '. Look at the screen (read, wait or find) before sending it again.';
      if (!problem && step.risk === 'irreversible' && !mission.irreversible)
        problem = 'This session was not given an irreversible action. Return to Luna with what is ready to be sent, deleted or bought.';
      if (problem || !operation) { const again = refuse(problem); if (again) return again; continue; }
      if (step.risk === 'irreversible' && input.confirmIrreversible) {
        // The approval is for this action on this target; if either changes, the user is asked again.
        const approval = JSON.stringify([operation, node?.identity ?? null, recipient?.identity ?? null, args]);
        if (!t.approvals.has(approval)) {
          const text = 'Allow this action, which cannot be undone? ' + operation + ' ' + (node?.label || args.key || '') + ' — for: ' + mission.objective;
          t.pending = { text, approval };
          state.question = { text };
          host.trace?.('confirmation', { text });
          host.status('needs_user', text);
          return;
        }
        t.approvals.delete(approval);
      }

      // Preconditions on the live element. A failure sends nothing.
      let owner = node?.owner ?? observation, acting = view;
      try {
        if (node?.element && node.states.includes('offscreen') && operation !== 'SCROLL_TO' && node.operations.includes('SCROLL_TO')) {
          await this.bridge.act(this.candidate('scroll', 'SCROLL_TO', node, observation, {}), owner, undefined, input.allowPhysical, signal);
          const identity = node.identity;
          acting = this.adopt(t, await this.bridge.observe(t.context, signal, this.depth(t)));
          const again = acting.index.find(identity, 'strong');
          if (again.length !== 1 || !again[0].operations.includes(operation)) {
            t.issues = [...issues, 'The target could not be identified after scrolling it into view. Nothing else was sent.'];
            continue;
          }
          node = again[0];
          owner = acting.observation;
        }
        // Keys go to whichever window is in front, so the intended one is brought forward first.
        if (operation === 'PRESS' && t.context.app && t.context.windowId)
          await this.bridge.act({ id: 'front', operation: 'FOCUS_WINDOW', app: t.context.app, windowId: t.context.windowId,
            name: 'Bring window to front', description: '' }, acting.observation, undefined, input.allowPhysical, signal);
        // A page element is resolved inside the page at the moment of the action; there is nothing to probe.
        if (this.bridge.probe && acting.observation.context.driver !== 'browser') {
          if (node?.element && POINTER_OPERATIONS.has(operation)) {
            const first = JSON.stringify(await this.bridge.probe(node.element.ref, 'bounds', signal));
            await delay(60, undefined, { signal });
            if (first !== JSON.stringify(await this.bridge.probe(node.element.ref, 'bounds', signal)))
              throw new Error('it is still moving');
          }
          if (operation === 'PRESS' && recipient?.element) {
            const value: any = await this.bridge.probe(recipient.element.ref, 'states', signal);
            const states = Array.isArray(value) ? value : value?.states || value?.value;
            if (!Array.isArray(states) || !states.includes('focused')) throw new Error('keyboard focus moved away from ' + recipient.label);
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        t.issues = [...issues, 'The target changed before dispatch (' + (error as Error).message + '). Nothing was sent; the screen was read again.'];
        t.view = undefined;
        continue;
      }

      const effect = t.ledger.propose({ step: state.step, operation, args, target: node?.identity,
        targetLabel: node?.label || args.key || clip(args.text || '', 200), recipient: recipient?.identity, risk: step.risk, expect: step.expect });
      if (node?.element) host.event('target', 'Resolved accessibility target.', { targetRef: node.element.ref, bounds: node.element.bounds,
        coordinateSpace: 'native-screen', app: owner.context.app, windowId: node.snapshot?.windowId });
      host.status('executing', 'Executing ' + operation + ' ' + clip(effect.targetLabel, 120) + '.');
      const before = { viewKey: acting.index.viewKey(), facts: acting.index.facts() };
      let delivery: Delivery = 'delivered', note = '', next = t.context;
      // Launch may succeed while resolving its focused window fails. Inspect the requested app,
      // rather than falling back to the old app inventory and choosing OPEN_APP again.
      const recovery: DesktopContext = { app: operation === 'OPEN_APP' ? node?.label : t.context.app, surface: 'window' };
      const direct = operation === 'OPEN_URL' || operation === 'SEARCH_WEB';
      try {
        next = operation === 'OPEN_URL' ? await this.bridge.openUrl!(validatedUrl(args.text!), signal)
          : operation === 'SEARCH_WEB' ? await this.bridge.searchWeb!(args.text!, signal)
          // A key press on a page carries its recipient, and the page refuses it if focus has moved.
          : await this.bridge.act(this.candidate(effect.id, operation,
            operation === 'PRESS' && acting.observation.context.driver === 'browser' ? recipient : node, acting.observation, args),
            owner, args.text, input.allowPhysical, signal);
      } catch (error) {
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        const disposition = error instanceof NativeError ? (error.disposition as { delivery?: string } | undefined) : undefined;
        // A bridge validation error is raised before anything is sent, and a native error is only
        // known to be harmless when it says so. Opening an address or a search has no validation
        // left at this point, so any failure there leaves the outcome unknown.
        delivery = error instanceof NativeError ? (disposition?.delivery === 'not_delivered' ? 'not_delivered' : 'uncertain')
          : direct ? 'uncertain' : 'not_delivered';
        note = error.message;
        if (delivery === 'uncertain') next = recovery;
      }
      const report = this.bridge.takeActionReport?.();
      if (delivery === 'delivered' && report?.verification === 'unverified' && (report.nativeError || ['uncertain', 'unknown'].includes(report.delivery))) {
        delivery = 'uncertain';
        note = (report.nativeError?.message || 'The input was sent but its delivery could not be confirmed.') +
          // Some fields take text, or show it, only while they have keyboard focus.
          (WRITE_OPERATIONS.has(operation) ? ' The field does not show the text. Click or focus the field and look again before writing it a second time.' : '');
        next = recovery;
      }
      if (report?.verification === 'already_satisfied') note = 'The control already held this value; nothing was sent.';
      if (direct && delivery === 'delivered') note = 'Opened in a new browser tab. No further tab or typing is needed for it.';
      if (node?.kind === 'menu' || (delivery !== 'not_delivered' && !VIEW_OPERATIONS.has(operation))) t.menu.invalidate(t.context.app);
      if (node?.kind === 'menu' && delivery !== 'not_delivered') next = { app: t.context.app, surface: 'window' };

      host.status('verifying', 'Reading the desktop again after the action.');
      let settled: Awaited<ReturnType<typeof settle>> | undefined;
      try {
        settled = delivery === 'not_delivered' ? undefined
          : await settle(this.bridge, next, signal, o => this.index(t, o), contentKey(acting.index), { ...this.depth(t, next.app),
            ...(acting.observation.context.driver === 'browser' ? { beforePage: { url: acting.observation.snapshots[0]?.tree?.value || '', content: pageContentKey(acting.index) } } : {}),
            intervalMs: SETTLE.intervalMs,
            // Focusing or scrolling changes nothing the content comparison looks at, so it is not waited on.
            // Nor is a write the adapter already watched without seeing its text appear.
            capMs: ['FOCUS', 'SCROLL', 'SCROLL_TO'].includes(operation) || report?.verification === 'unverified' ? 0 : SETTLE.capMs });
      } catch (error) {
        signal.throwIfAborted();
        // The action was sent whether or not the screen can be read afterwards. Record that first.
        Object.assign(effect, { delivery: 'uncertain', recipient: recipient?.identity,
          note: (note + ' The screen could not be read afterwards: ' + (error as Error).message).trim() });
        host.trace?.('effect', { effect, settle: { failed: (error as Error).message } });
        host.event('result', 'The action was sent, but the screen could not be read afterwards. Inspecting before anything is repeated.');
        t.context = t.context.app ? { app: t.context.app, surface: 'window' } : {};
        t.previous = undefined;
        t.view = undefined;
        continue;
      }
      const after = settled ? this.adopt(t, settled.observation, settled.index) : (t.view = undefined, undefined);
      t.previous = before;
      Object.assign(effect, { delivery, recipient: recipient?.identity,
        note: note + (!settled || settled.changed ? '' : ' Nothing on screen changed after this action.'),
        delta: after ? after.index.delta(before) : effect.delta,
        readback: report && (report.expectedValue !== undefined || report.observedValue !== undefined)
          ? { expected: report.expectedValue, observed: report.observedValue } : undefined });
      if (delivery === 'delivered') {
        const matched = report?.observedValue !== undefined && report.observedValue === report.expectedValue;
        if (report && WRITE_OPERATIONS.has(operation) && matched && ['verified', 'reconciled', 'already_satisfied'].includes(report.verification))
          t.ledger.settle(effect.id, 'confirmed', 'readback');
        else if (report && POSTCONDITION_OPERATIONS.has(operation) && report.verification === 'verified')
          t.ledger.settle(effect.id, 'confirmed', 'postcondition');
        // The screen answering an action is the plainest sign that it arrived.
        else if (settled?.changed) t.ledger.settle(effect.id, 'confirmed', 'observed_change');
      }
      // The screen is different now, so earlier attempts say nothing about what is worth trying.
      if (settled?.changed) t.repeats.clear();
      host.trace?.('effect', { effect, settle: settled && { reads: settled.reads, changed: settled.changed, ms: settled.ms } });
      host.event('result', delivery === 'not_delivered' ? 'Nothing was sent: ' + note
        : delivery === 'uncertain' ? 'The action may have been delivered; inspecting before anything is repeated.'
        : effect.outcome === 'confirmed' ? 'Delivered and confirmed.' : 'Delivered. Nothing changed yet.',
        { effect: { id: effect.id, operation, target: effect.targetLabel, delivery, outcome: effect.outcome, delta: effect.delta } });
      host.event('step', clip(operation + ' ' + effect.targetLabel + ': ' + delivery + '. ' +
        (effect.delta.scopeChanged ? 'The view changed.' : effect.delta.added.length + ' added, ' + effect.delta.removed.length + ' removed.'), 1000));
    }
  }

  private candidate(id: string, operation: Exclude<PlanOperation, 'OPEN_URL' | 'SEARCH_WEB'>, node: IndexedNode | undefined, observation: DesktopObservation,
    args: Effect['args']): DesktopCandidate {
    const context = (node?.owner ?? observation).context;
    const snapshot = node?.snapshot ?? observation.snapshots[0];
    return {
      id: 'nav_' + id, operation, description: '', name: clip(node?.label || args.key || operation, 1000),
      app: node?.kind === 'application' ? node.appId! : context.app || node?.identity.app || 'macOS',
      windowId: node?.kind === 'window' ? node.windowId : node?.kind === 'element' ? snapshot?.windowId || context.windowId : context.windowId,
      snapshotId: node?.kind === 'application' || node?.kind === 'window' ? undefined : snapshot?.id,
      targetRef: node?.element?.ref, role: node?.role, key: args.key,
      direction: args.direction as DesktopCandidate['direction'], bounds: node?.element?.bounds,
    };
  }

  /** Resolve a read scope to the context of the next observation. Sends no desktop input. */
  private async scope(step: PlanStep, t: Task, index: ObservationIndex, observation: DesktopObservation,
    signal: AbortSignal): Promise<DesktopContext | string> {
    const context = t.context;
    const [kind, value] = step.scope.split(/:(.*)/s);
    if (step.scope === 'top') {
      const { rootRef: _rootRef, scopePath: _scopePath, ...top } = context;
      return top;
    }
    if (step.scope === 'apps') return {};
    if (step.scope === 'page' && context.app) return { driver: 'browser', app: context.app };
    if (step.scope === 'app-search') {
      const name = step.query.trim();
      if (!name || name.length > 200) return 'app-search needs the application name in query.';
      return this.bridge.act({ id: 'nav_search', operation: 'SEARCH_APPS', app: 'macOS', name: 'Application search', description: '' },
        observation, name, false, signal);
    }
    if (kind === 'surface' && context.app) return { app: context.app, windowId: context.windowId, surface: value };
    const node = value ? index.get(value) : undefined;
    if (kind === 'window' && node?.windowId && context.app) return { app: context.app, windowId: node.windowId, surface: 'window' };
    if (kind === 'region' && node?.element && node.owner === observation) {
      const scopePath = [...(context.scopePath || []), { ref: node.element.ref, name: clip(node.label || node.role, 200),
        anchor: { trail: node.identity.ancestorRoles, index: node.identity.siblingIndex } }];
      if (scopePath.length > 50) return 'The hierarchy depth limit was reached.';
      return { ...context, rootRef: node.element.ref, scopePath };
    }
    return 'read needs one of the listed scopes.';
  }
}
