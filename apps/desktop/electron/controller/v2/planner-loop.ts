import { setTimeout as delay } from 'node:timers/promises';
import {
  PlanStepSchema, GroundResultSchema,
  type DesktopCandidate, type DesktopContext, type DesktopObservation, type PlanOperation,
  type PlanRequest, type PlanStep, type NavigationMission, type NavigationMilestone, type NavigationCompletionProposal,
} from '../../../../../packages/contracts/src/index';
import { KEYS, validatedUrl, type WorkspaceBridge } from '../../desktop/workspace';
import { PAGE_KEYS } from '../../page/page-workspace';
import { NativeError } from '../../desktop/native-client';
import type { DecisionProvider } from '../../services/decision-client';
import type { LoopHost } from '../desktop-loop';
import { exactInputs } from '../task-instructions';
import { evaluateCheck, type Baselines } from './checks';
import { MenuIndex } from './menu-index';
import { ObservationIndex, type IndexedNode } from './observation-index';
import { contentKey, pageContentKey, settle } from './settle';
import { clip } from './text';
import { atLeast, matchIdentity } from './identity';
import { urlIsObservedOrSupplied, ungroundedAddresses } from './url-provenance';
import { TaskState, VIEW_OPERATIONS, WRITE_OPERATIONS, type BoundCheck, type CitedRow, type Delivery, type Effect } from './task-state';

export type PlannerHost = LoopHost & { trace?(kind: string, data: unknown): void };

/** Starting values from docs/controller-redesign.md. Tune against the evaluation harness. */
export const V2_LIMITS = {
  deadlineMs: 10 * 60_000,
  /** Steps allowed after the last delivered action once every open requirement has delivered work. */
  verificationReads: 6,
  startDepth: 8,
  settleIntervalMs: 150, settleCapMs: 2000,
};

type Session = {
  taskId: string;
  state: TaskState;
  context: DesktopContext;
  query: string;
  milestoneId?: string;
  completionProposal?: NavigationCompletionProposal;
  report?: { status: string; summary: string; facts: string[]; remaining: string[]; observationId: string };
  previous?: { viewKey: string; facts: string[] };
  issues: string[];
  deadline: number;
  /** Planner steps since the last delivered action that was more than a view change. */
  idle: number;
  /** Searches already run, keyed by the page content they ran against. */
  finds: Set<string>;
  /** Addresses this task has actually been on, so they may be opened again directly. */
  seenUrls: Set<string>;
  /** Whether the previous step was already in the verification phase. */
  verifying: boolean;
  /** Whether a premature "blocked" has already been questioned once. */
  challenged?: boolean;
  /** When the task paused for the user, so the wait does not count against its deadline. */
  pausedAt?: number;
  pending?: { kind: 'question'; text: string } | { kind: 'confirm'; text: string; approval: string };
  approvals: Set<string>;
  /** Applications whose windows are too heavy for one direct deep read; read them layer by layer. */
  shallow: Set<string>;
  menu: MenuIndex;
  baselines: Baselines;
};

const rowText = (node: IndexedNode) => clip(node.role + ' ' + JSON.stringify(node.label) +
  (node.value ? ' = ' + JSON.stringify(node.value) : '') + (node.states.length ? ' [' + node.states.join(',') + ']' : ''), 700);
const TEXT_OPERATIONS = new Set(['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE', 'SELECT']);
const POINTER_OPERATIONS = new Set(['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK']);
const POSTCONDITION_OPERATIONS = new Set(['CHECK', 'UNCHECK', 'EXPAND', 'COLLAPSE', 'FOCUS']);

/**
 * Observe -> plan -> validate -> dispatch once -> settle -> reconcile.
 * The orchestrator owns task status. A delegated navigator proposes actions and evidence;
 * this loop owns input delivery and observations. Standalone mode retains its own task state.
 */
export class PlannerLoop {
  private session?: Session;
  private browser?: Promise<string | undefined>;
  constructor(private bridge: WorkspaceBridge, private provider: DecisionProvider,
    /** Resolves the bundle id that opens web links for this user. */
    private defaultBrowser?: () => Promise<string | undefined>) {}

  /** Serialisable task state of the current or last task, for traces and tests. */
  snapshot() { return this.session?.state.toJSON(); }
  context() { return this.session?.context ?? {}; }
  issues() { return this.session?.issues ?? []; }
  completionProposal() { return this.session?.completionProposal; }
  report() { return this.session?.report; }

  /** The parent reviews the last tool result against fresh observations, using the same
   * evidence rules as the executor. A prose handoff alone can never advance the workflow. */
  reviewMilestone(milestoneId: string, evidence: string[], observation: DesktopObservation,
    index: ObservationIndex, offeredIds: Set<string>, status: 'evidenced' | 'open' | 'unverifiable' = 'evidenced', reason = ''): string | undefined {
    const s = this.session;
    // Completed work is durable. A redundant review neither overwrites its evidence nor
    // prevents the parent from assigning the next milestone.
    if (status === 'evidenced' && s?.state.requirement(milestoneId)?.status === 'evidenced') return;
    if (!s || s.milestoneId !== milestoneId) return 'Review only the milestone returned by the last navigation session.';
    if (status === 'unverifiable') {
      if (!reason.trim()) return 'Unverified review needs the concrete limitation preventing outcome verification.';
      if (!s.state.markUnverifiable(reason, milestoneId).length)
        return 'Unverified completion requires delivered work that was not refuted; unfinished or unsent work must continue.';
      return;
    }
    if (!observation.snapshots[0]?.complete) return 'Read a complete relevant scope before reviewing completion.';
    if (!evidence.length) return 'A milestone review needs fresh screen evidence.';
    const rows: CitedRow[] = [];
    for (const id of evidence) {
      const node = offeredIds.has(id) ? index.get(id) : undefined;
      if (!node || node.kind === 'menu') return 'Review evidence must cite fresh screen elements.';
      rows.push({ row: id, text: rowText(node), identity: node.identity });
    }
    // Reopening corrects a premature semantic verdict, not delivery. Existing effects remain
    // reconciled or uncertain exactly as before, so continuation cannot silently replay them.
    return s.state.setStatus(milestoneId, status, observation.id, rows);
  }

  private makeIndex(allowPhysical: boolean) {
    return (observation: DesktopObservation) => new ObservationIndex(observation, { allowPhysical });
  }

  /** A failed direct read costs its whole timeout, so it is tried once per application, not on every read. */
  private depth(s: Session, app = s.context.app) {
    return { startDepth: app && s.shallow.has(app) ? 3 : V2_LIMITS.startDepth, query: s.query || s.state.goal };
  }
  private learn(s: Session, observation: DesktopObservation) {
    if (observation.context.app && observation.notices.some(n => n.startsWith('A direct deep read did not complete')))
      s.shallow.add(observation.context.app);
  }

  private publish(host: PlannerHost, s: Session) {
    host.state.requirements = s.state.requirements.map(r => ({ id: r.id, text: r.text, irreversible: r.irreversible, status: r.status }));
  }

  private conclude(host: PlannerHost, s: Session, status: 'completed' | 'completed_unverified' | 'blocked', message: string) {
    this.publish(host, s);
    const lines = s.state.requirements.map(r => r.status + ': ' + r.text + (r.evidence.length ? ' — ' + r.evidence.map(e => e.row).join('; ') : ''));
    if (status !== 'blocked')
      host.state.completion = { kind: 'requirements', summary: message, evidence: lines.map(line => clip(line, 900)).slice(0, 40) };
    host.trace?.('terminal', { status, message, state: s.state.toJSON() });
    host.status(status, message);
    host.event('result', message, { requirements: host.state.requirements });
  }

  /** Budget ran out: delivered work whose result is not observable ends honestly instead of looping. */
  private exhaust(host: PlannerHost, s: Session, reason: string) {
    if (s.state.allEvidenced()) return this.conclude(host, s, 'completed', 'Every requirement is evidenced by the current screen.');
    const unverifiable = s.state.verificationReady() ? s.state.markUnverifiable(reason) : [];
    if (unverifiable.length && s.state.requirements.every(r => r.status === 'evidenced' || r.status === 'unverifiable'))
      return this.conclude(host, s, 'completed_unverified', 'Actions were delivered, but nothing else on screen confirms: ' +
        unverifiable.map(r => r.text).join('; ') + '. Text that was typed was read back from its field, which does not show what ' +
        'happened next. Check the result yourself. (' + reason + ')');
    return this.conclude(host, s, 'blocked', 'Stopped: ' + reason + '. Unfinished: ' +
      s.state.requirements.filter(r => r.status !== 'evidenced').map(r => r.text).join('; '));
  }

  private effectsView(s: Session): PlanRequest['effects'] {
    const pending = s.state.unreconciled();
    const rest = s.state.effects.filter(e => !pending.includes(e) && e.delivery !== 'proposed');
    return [...pending.slice(-10), ...rest.slice(-(16 - Math.min(pending.length, 10)))].sort((a, b) => a.step - b.step).map(e => ({
      id: e.id, step: e.step, requirementId: e.requirementId, operation: e.operation, target: clip(e.targetLabel, 400),
      text: e.args.text === undefined ? undefined : clip(e.args.text, 600), key: e.args.key, direction: e.args.direction,
      // A view change needs no reconciliation, so it is not shown as an open question.
      risk: e.risk, delivery: e.delivery, outcome: VIEW_OPERATIONS.has(e.operation) && e.outcome === 'unknown' ? 'view_change' : e.outcome,
      expect: clip(e.expect, 500),
      readback: e.readback?.observed === undefined ? undefined : clip(e.readback.observed, 600),
      added: e.delta.added, removed: e.delta.removed, scopeChanged: e.delta.scopeChanged, note: clip(e.note, 500),
    }));
  }

  private allowedKeys(observation: DesktopObservation): string[] {
    const { context } = observation, snapshot = observation.snapshots[0];
    if (context.driver === 'browser') return snapshot ? PAGE_KEYS : [];
    return snapshot?.complete && context.windowId && observation.windows.some(w => w.id === context.windowId && w.focused) ? KEYS : [];
  }

  async advance(host: PlannerHost, singleStep: boolean, signal: AbortSignal, answer?: string, mission?: NavigationMission,
    sharedAnswers: PlanRequest['answers'] = [], taskMilestones: NavigationMilestone[] = []) {
    const { state } = host, input = state.input!, taskId = state.taskId!;
    if (!this.provider.plan) throw new Error('This provider cannot plan. The v2 controller needs the planner route.');
    if (this.session?.taskId !== taskId) {
      this.session = {
        taskId, state: new TaskState(taskId, input.goal, exactInputs(input).map(i => i.text)),
        context: input.app ? { app: input.app } : {}, query: '', issues: [], deadline: Date.now() + V2_LIMITS.deadlineMs, idle: 0, verifying: false, finds: new Set(), seenUrls: new Set(),
        approvals: new Set(), shallow: new Set(), menu: new MenuIndex(), baselines: new Map(),
      };
      host.event('observation', 'Planner-owned controller (v2): one planning call per step, effects recorded in a single ledger.');
    }
    const s = this.session;
    if (mission?.milestone) {
      s.completionProposal = undefined;
      s.report = undefined;
      s.state.declare(taskMilestones);
      if (!s.state.requirement(mission.milestone.id)) throw new Error('The assigned milestone is missing from the task plan.');
      if (s.milestoneId !== mission.milestone.id) s.query = '';
      s.milestoneId = mission.milestone.id;
    }
    const activeRequirements = () => mission?.milestone
      ? s.state.requirements.filter(r => r.id === mission.milestone!.id) : s.state.requirements;
    const reads = new Map<string, number>();
    const rejected = new Set<string>();
    let rejectionLoop = false;
    // A new orchestrator session may inspect a different route after an inconclusive result.
    // Preserve effects across sessions. The parent decides the work; there is no session budget.
    if (mission) s.idle = 0;
    for (const item of sharedAnswers)
      if (!s.state.answers.some(existing => existing.question === item.question && existing.answer === item.answer)) s.state.answers.push(item);
    if (s.pausedAt) {
      s.deadline += Date.now() - s.pausedAt;
      s.pausedAt = undefined;
    }
    if (s.pending) {
      const pending = s.pending;
      s.pending = undefined;
      state.question = null;
      // The user's reply is progress; the step that asked must not cost the next one its allowance.
      s.idle = 0;
      if (answer === undefined) s.issues.push('The user has not answered: ' + pending.text);
      else if (pending.kind === 'question') s.state.answers.push({ question: clip(pending.text, 1000), answer: clip(answer, 1000) });
      else if (/^\s*(y|yes|allow|confirm|ok|okay|go ahead|do it)\b/i.test(answer)) s.approvals.add(pending.approval);
      else {
        s.state.answers.push({ question: clip(pending.text, 1000), answer: clip(answer, 1000) });
        s.issues.push('The user declined this irreversible action. Do not propose it again.');
      }
    }
    const makeIndex = this.makeIndex(input.allowPhysical);
    let observation: DesktopObservation | undefined;
    let index: ObservationIndex | undefined;

    for (;;) {
      signal.throwIfAborted();
      if (mission && rejectionLoop) {
        host.event('result', 'The navigator repeated a rejected proposal on unchanged content. Returning observations and the rejection to the orchestrator for recovery.');
        return 'yielded' as const;
      }
      if (!mission && state.step >= input.maxSteps) return this.exhaust(host, s, 'the step budget was used up');
      if (!mission && Date.now() > s.deadline) return this.exhaust(host, s, 'the time limit was reached');
      if (!observation || !index) {
        host.status('observing', 'Reading applications, windows and the current accessibility tree.');
        const started = Date.now();
        observation = await this.bridge.observe(s.context, signal, this.depth(s));
        signal.throwIfAborted();
        this.learn(s, observation);
        index = makeIndex(observation);
        s.context = observation.context;
        host.trace?.('observation', { id: observation.id, viewKey: index.viewKey(), nodes: index.nodes.length, nativeMs: Date.now() - started });
      }
      state.observation = observation;
      state.snapshot = observation.snapshots[0] || null;

      // While work is outstanding only the step budget and the deadline bound the task. Once
      // every open requirement has delivered work, checking gets a short allowance of its own.
      const verifying = !mission?.milestone && s.state.verificationReady();
      if (verifying && !s.verifying) s.idle = 0;
      s.verifying = verifying;
      const allowance = verifying ? V2_LIMITS.verificationReads : Infinity;
      if (s.idle >= allowance) return this.exhaust(host, s, 'the verification budget was used up');
      for (const notice of observation.notices)
        if (notice.startsWith('Page address: ')) s.seenUrls.add(notice.slice(14));

      // On a web page the application's menu bar is rarely the route, and reading it costs more than the page does.
      const menu = s.context.app && observation.snapshots.length && observation.context.driver !== 'browser'
        ? await s.menu.nodes(s.context.app, this.bridge, signal) : [];
      index.adopt(menu);
      const pinned = [...s.state.unreconciled().flatMap(e => (e.target ? [e.target] : [])),
        ...s.state.requirements.flatMap(r => r.checks.map(c => c.target))];
      // Before any requirement or query exists, the goal itself is the only relevance signal.
      const selection = index.select({ query: s.query,
        requirementTerms: [mission?.objective || input.goal, ...activeRequirements().filter(r => r.status !== 'evidenced').map(r => r.text)],
        pinned, previous: s.previous, extra: menu });
      // Which browser a web address belongs in is the user's setting, not something to guess.
      const browser = (await (this.browser ??= this.defaultBrowser?.().catch(() => undefined) ?? Promise.resolve(undefined)))?.toLowerCase();
      if (browser) for (const element of selection.elements) {
        const node = element.role === 'application' ? index.get(element.id) : undefined;
        if (node?.appId?.toLowerCase() === browser && element.tags.length < 8) element.tags.push('default-browser');
      }
      const snapshot = observation.snapshots[0];
      const allWindows = observation.windows;
      const windowElement = (id?: string) => { const at = allWindows.findIndex(w => w.id === id); return at < 0 ? '' : 'w' + at; };
      const request: PlanRequest = {
        taskId, observationId: observation.id, step: state.step + 1, goal: input.goal, literals: s.state.literals.slice(0, 8),
        answers: s.state.answers.slice(-8),
        requirements: activeRequirements().map(r => ({ id: r.id, text: r.text, irreversible: r.irreversible, kind: r.kind, status: r.status,
          evidence: r.evidence.slice(0, 6).map(e => clip(e.row, 700)) })),
        effects: this.effectsView(s),
        observation: {
          // Windows are named by their element ids so they can be cited and targeted like any element.
          app: s.context.app || '', windowId: windowElement(s.context.windowId), nativeWindowId: s.context.windowId || '', windowTitle: clip(snapshot?.tree?.name || snapshot?.windowTitle || '', 1000),
          surface: snapshot?.surface || (s.context.appSearch ? 'application search' : 'applications'), complete: snapshot?.complete === true,
          scope: (s.context.scopePath || []).map(p => clip(p.name, 300)), outline: index.outline().map(line => clip(line, 300)),
          windows: observation.windows.slice(0, 40).map(w => ({ id: windowElement(w.id), title: clip(w.title, 1000), focused: w.focused })),
          // Bridge notices written for the older controller name operations this one does not have.
          notices: observation.notices.filter(n => !/INSPECT_REGION|GO_PARENT|GO_ROOT|BROWSE_TREE|READ_SURFACE|OPEN_APP/.test(n))
            .slice(0, 12).map(n => clip(n, 1000)), capability: index.capability(),
        },
        elements: selection.elements, scopes: selection.scopes, allowedKeys: this.allowedKeys(observation),
        query: s.query, phase: verifying ? 'verification' : 'planning',
        budgets: { stepsLeft: mission ? null : Math.min(input.maxSteps - state.step, allowance - s.idle),
          verificationReadsLeft: verifying ? allowance - s.idle : null },
        issues: s.issues.slice(-8).map(issue => clip(issue, 600)),
        ...(mission ? { mission } : {}),
      };
      host.trace?.('plan_request', request);
      host.status('deciding', 'Planning the next step.');
      const started = Date.now();
      const step = PlanStepSchema.parse(await this.provider.plan(request, signal));
      signal.throwIfAborted();
      if (step.taskId !== taskId || step.observationId !== observation.id) throw new Error('Rejected a stale or mismatched plan step.');
      state.step++;
      s.idle++;
      host.trace?.('plan_step', { step, durationMs: Date.now() - started });
      const sent = new Set(request.elements.map(e => e.id));
      const issues: string[] = [];

      // 1. Requirements, reconciliations and statuses are applied before the step itself.
      if (!mission?.milestone) issues.push(...s.state.declare(step.requirements));
      else if (step.requirements.some(r => r.id !== mission.milestone!.id))
        issues.push('The orchestrator owns the plan. Only the assigned milestone may be worked on.');
      const cite = (ids: string[]): CitedRow[] => ids.flatMap(id => {
        const node = sent.has(id) ? index!.get(id) : undefined;
        if (!node) { issues.push('Cited element ' + id + ' is not in the current observation.'); return []; }
        // Menu items come from a cached read of the menu bar, so they cannot show the current state.
        if (node.kind === 'menu') { issues.push('Menu item ' + id + ' cannot be cited; read surface:menubar to see its current state.'); return []; }
        return [{ row: id, text: rowText(node), identity: node.identity }];
      });
      const complete = snapshot?.complete === true;
      if (step.report) {
        const rows = cite(step.report.evidence);
        if (rows.length === step.report.evidence.length) s.report = {
          status: step.report.status, summary: step.report.summary, remaining: step.report.remaining,
          facts: rows.map(row => clip(row.text, 1000)), observationId: observation.id,
        };
      }
      const statusEvidence = new Map(step.statuses.filter(st => st.status === 'evidenced').map(st => [st.requirementId, st.evidence]));
      const reconciled = new Set<string>();
      for (const reconciliation of step.reconciliations) {
        // One verdict per effect; a view change has nothing to reconcile.
        if (reconciled.has(reconciliation.effectId)) continue;
        reconciled.add(reconciliation.effectId);
        const effect = s.state.effects.find(e => e.id === reconciliation.effectId);
        if (effect && VIEW_OPERATIONS.has(effect.operation)) continue;
        let rows = cite(reconciliation.evidence.length ? reconciliation.evidence
          : statusEvidence.get(effect?.requirementId ?? '') ?? []);
        if (effect && reconciliation.outcome === 'refuted') {
          rows = rows.filter(row => {
            const target = effect.target ?? effect.recipient;
            if (!target || !row.identity || !atLeast(matchIdentity(target, row.identity), 'strong')) return true;
            // Seeing the button that was clicked says nothing about whether its effect happened.
            // A text write can be disproved by an actual mismatched readback of that field.
            const expected = effect.readback?.expected;
            return WRITE_OPERATIONS.has(effect.operation) && expected !== undefined && index!.get(row.row)?.value !== expected;
          });
          if (!rows.length) {
            issues.push('Refuting ' + effect.id + ' needs observed counter-evidence. The action target still being present, or no visible change, does not prove failure. Inspect the expected result before retrying.');
            continue;
          }
        }
        const error = !complete ? 'An incomplete observation cannot reconcile an effect; read the relevant scope first.'
          : s.state.reconcile(reconciliation.effectId, reconciliation.outcome, observation.id, rows.map(r => r.row));
        if (error) issues.push(error);
      }
      for (const status of step.statuses) {
        if (mission?.milestone && status.requirementId !== mission.milestone.id) {
          issues.push('Only the active milestone can be evidenced by this navigation session.');
          continue;
        }
        const rows = status.status === 'evidenced' ? cite(status.evidence) : [];
        if (mission?.milestone) {
          // An executor can suggest that its work is ready for review, never update the
          // parent's milestone ledger. Even a mistaken completion claim leaves work open.
          if (status.status === 'evidenced') s.completionProposal = {
            milestoneId: mission.milestone.id, observationId: observation.id,
            summary: clip(step.message || 'Navigator proposes completion for review.', 1000),
            evidence: rows.slice(0, 6).map(row => row.text),
          };
          continue;
        }
        const checks: BoundCheck[] = [];
        let pass = true;
        for (const check of status.status === 'evidenced' ? status.checks : []) {
          const node = sent.has(check.target) ? index.get(check.target) : undefined;
          if (!node) { issues.push('Check target ' + check.target + ' is not in the current observation.'); pass = false; continue; }
          const bound: BoundCheck = { kind: check.kind, target: node.identity, value: check.value };
          const result = evaluateCheck(bound, index, s.baselines);
          if (!result.pass) { pass = false; issues.push('Check ' + check.kind + ' on ' + node.label + ': ' + result.reason); }
          checks.push(bound);
        }
        const error = status.status === 'evidenced' && !complete
          ? 'An incomplete observation cannot evidence a requirement; read the relevant scope first.'
          : s.state.setStatus(status.requirementId, status.status, observation.id, rows, checks, pass);
        if (error) issues.push(error);
      }
      this.publish(host, s);
      const describe = step.kind === 'act' ? step.operation + ' → ' + (index.get(step.target)?.label || step.key || step.targetDescription)
        : step.kind === 'find' ? 'find ' + JSON.stringify(step.query) : step.kind === 'read' ? 'read ' + step.scope
        : step.kind === 'wait' ? 'wait' : step.kind;
      host.event('decision', 'Planner: ' + describe, { kind: step.kind, model: step.model, durationMs: Date.now() - started,
        requirementId: step.requirementId, expect: step.expect, issues });
      const reject = (...messages: string[]) => {
        s.issues = [...issues, ...messages];
        const key = JSON.stringify([contentKey(index!), step.kind, step.operation, step.target,
          step.text, step.key, step.direction, step.scope, step.query, step.repeat, messages]);
        rejectionLoop = rejected.has(key);
        rejected.add(key);
        host.event('result', 'Step not sent: ' + clip(messages.join(' '), 400));
      };
      if (!s.state.requirements.length) { reject('State the requirements of the goal first.'); continue; }
      s.issues = issues;
      if (step.query && step.kind !== 'act') s.query = clip(step.query, 300);

      // Finishing a tool call is not finishing the root task. Its observed evidence goes back
      // to the coordinator, which chooses the next milestone or evaluates a condition.
      if (mission?.milestone && s.completionProposal) {
        host.event('result', 'Navigator returned evidence for orchestrator review. Milestone remains open.');
        return 'yielded' as const;
      }

      // 2. Steps that send no input.
      if (step.kind === 'yield') {
        if (!mission) { reject('There is no orchestrator session. Continue or finish the original goal.'); continue; }
        host.event('result', step.message || 'Returning navigation progress to the orchestrator.');
        return 'yielded' as const;
      }
      if (step.kind === 'find') {
        if (!step.query.trim()) { reject('find needs a query.'); continue; }
        // A search only re-ranks what has already been read. The same search on the same content
        // returns the same elements, so repeating it is never progress.
        const key = contentKey(index) + '\n' + step.query.trim().toLocaleLowerCase();
        if (s.finds.has(key)) {
          reject('This search already ran on this unchanged screen and found what is listed now. Searching again cannot load ' +
            'anything new. Change what is shown instead: scroll, open a section or link, use the site\'s own search box, or read another scope.');
          continue;
        }
        s.finds.add(key);
        if (observation.context.driver === 'browser') {
          // A web page is read again with the search words, so matches beyond its size limit are listed.
          s.previous = { viewKey: index.viewKey(), facts: index.facts() };
          observation = undefined;
        } else if (s.context.app) await s.menu.nodes(s.context.app, this.bridge, signal, 5000);
        continue;
      }
      if (step.kind === 'wait') {
        await delay(Math.min(Math.max(step.waitMs, 250), 5000), undefined, { signal });
        s.previous = { viewKey: index.viewKey(), facts: index.facts() };
        observation = undefined;
        continue;
      }
      if (step.kind === 'read') {
        const readKey = contentKey(index) + '\n' + step.scope + '\n' + s.query;
        const visits = (reads.get(readKey) || 0) + 1;
        reads.set(readKey, visits);
        if (mission?.milestone && visits > 2) {
          s.issues.push('The same scope was read twice without new content. This route has stalled; no negative task finding is established.');
          host.event('result', s.issues.at(-1)!);
          return 'yielded' as const;
        }
        const next = await this.scope(step, s, index, observation, signal);
        if (typeof next === 'string') { reject(next); continue; }
        s.previous = { viewKey: index.viewKey(), facts: index.facts() };
        s.context = next;
        observation = undefined;
        continue;
      }
      if (step.kind === 'ask_user') {
        if (!step.message.trim()) { reject('ask_user needs a question in message.'); continue; }
        if (mission) {
          // The parent owns decisions and parameters for a delegated task. Let it answer
          // or escalate; the executor must not interrupt the user independently.
          const question = 'Navigator asks the orchestrator: ' + step.message;
          s.issues = [question];
          host.trace?.('navigation_question', { question: step.message, milestoneId: mission.milestone?.id });
          host.event('result', question);
          return 'yielded' as const;
        }
        s.pending = { kind: 'question', text: step.message };
        s.pausedAt = Date.now();
        state.question = { kind: 'question', text: step.message };
        host.trace?.('question', { text: step.message });
        host.status('needs_user', step.message);
        return;
      }
      if (step.kind === 'blocked') {
        if (mission) {
          host.event('result', step.message || 'Navigation needs a different route.');
          return 'blocked' as const;
        }
        // Giving up before anything was tried is usually a misreading of the first screen, which
        // may list only applications. Ask once to open the right one before accepting it.
        if (!s.challenged && !s.state.effects.some(e => e.delivery === 'delivered' || e.delivery === 'uncertain')) {
          s.challenged = true;
          reject('Nothing has been tried yet. Controls belong to an application: open or switch to the one this goal needs ' +
            '(OPEN_APP on an application element), or read another scope, and its controls will be listed. Report blocked only after that.');
          continue;
        }
        return this.conclude(host, s, 'blocked', 'Planner: ' + (step.message || 'no available capability can advance the task.'));
      }
      if (step.kind === 'finish') {
        if (mission?.milestone) {
          s.completionProposal = { milestoneId: mission.milestone.id, observationId: observation.id,
            summary: clip(step.message || 'Navigator requests completion review.', 1000), evidence: [] };
          host.event('result', 'Navigator requests orchestrator review. Milestone remains open.');
          return 'yielded' as const;
        }
        // Typed checks are facts about the screen now, so they are re-read at the end.
        if (complete) for (const requirement of s.state.requirements.filter(r => r.status === 'evidenced'))
          for (const check of requirement.checks) {
            const result = check.kind === 'value_advances' ? { pass: true } : evaluateCheck(check, index, s.baselines);
            if (!result.pass && index.find(check.target, 'weak').length) {
              s.state.setStatus(requirement.id, 'open', observation.id, []);
              issues.push('Requirement ' + requirement.id + ' no longer holds: ' + result.reason);
            }
          }
        if (s.state.allEvidenced()) return this.conclude(host, s, 'completed', 'Every requirement is evidenced by the current screen.');
        if (s.state.verificationReady()) return this.exhaust(host, s, 'the planner found nothing further to verify');
        reject('Requirements without delivered work or evidence remain: ' + s.state.requirements.filter(r => r.status !== 'evidenced')
          .map(r => r.id).join(', ') + '. Continue, ask the user, or report blocked.');
        continue;
      }

      // 3. act: validate against task state, then against the live element, then dispatch once.
      const requirement = s.state.requirement(step.requirementId);
      const operation = step.operation as PlanOperation | '';
      if (!requirement) { reject('act needs the id of the requirement it serves.'); continue; }
      if (mission?.milestone && requirement.id !== mission.milestone.id) {
        reject('This session may act only on the assigned milestone. Yield for sequencing or branch decisions.'); continue;
      }
      if (!operation) { reject('act needs an operation.'); continue; }
      if (requirement.status === 'evidenced') { reject('Requirement ' + requirement.id + ' is already evidenced; no further action is needed for it.'); continue; }
      let node: IndexedNode | undefined;
      let recipient: IndexedNode | undefined;
      if (operation === 'PRESS') {
        if (!request.allowedKeys.includes(step.key)) { reject('Key ' + JSON.stringify(step.key) + ' is not available in this observation.'); continue; }
        recipient = index.focused();
        if (step.target && index.get(step.target) !== recipient) {
          reject('The named recipient does not have keyboard focus. Focus it first, then press the key.');
          continue;
        }
        // On a page, Return submits whatever has focus, so it must be tied to a known field.
        if (observation.context.driver === 'browser' && step.key === 'return' && !recipient) {
          reject('No field on this page has keyboard focus. Focus the field Return is meant for, or use the page\'s own button.');
          continue;
        }
      } else if (operation === 'OPEN_URL') {
        if (!this.bridge.openUrl) { reject('Opening an address directly is not available here.'); continue; }
        try { validatedUrl(step.text); } catch (error) { reject((error as Error).message); continue; }
        if (!urlIsObservedOrSupplied(step.text, [input.goal, ...s.state.literals, ...s.state.answers.map(a => a.answer)], s.seenUrls)) {
          reject('This exact URL was neither supplied by the user nor observed. Do not invent even a homepage or add a protocol. ' +
            'Read surface:window for the browser search/address field, enter the supplied name/domain, and select an observed suggestion or link.');
          continue;
        }
      } else {
        node = sent.has(step.target) ? index.get(step.target) : undefined;
        if (!node) { reject('act needs a target element id from the current observation.'); continue; }
        if (input.grounding === 'jev' && this.provider.ground && node.kind !== 'application' && node.kind !== 'window') {
          const supported = request.elements.filter(e => e.operations.includes(operation));
          if (supported.length > 1) {
            const grounded = GroundResultSchema.parse(await this.provider.ground({ taskId, observationId: observation.id, goal: input.goal,
              requirement: requirement.text, operation, text: clip(step.text, 600), key: '',
              targetDescription: step.targetDescription || node.label.slice(0, 400), elements: supported }, signal));
            signal.throwIfAborted();
            if (grounded.taskId !== taskId || grounded.observationId !== observation.id)
              throw new Error('Rejected stale target grounding.');
            host.trace?.('grounding', { planner: step.target, jev: grounded.target, agree: grounded.target === step.target, confidence: grounded.confidence, usage: grounded.usage });
            const chosen = grounded.target ? index.get(grounded.target) : undefined;
            if (!chosen) { reject('Jev found no listed element matching ' + JSON.stringify(step.targetDescription) + '. Describe the target differently or search for it.'); continue; }
            node = chosen;
          }
        }
        if (!node.operations.includes(operation)) { reject(operation + ' is not offered on ' + node.label + '. Its operations: ' + (node.operations.join(', ') || 'none') + '.'); continue; }
      }
      const args: Effect['args'] = {};
      if (TEXT_OPERATIONS.has(operation) || operation === 'OPEN_URL') {
        const invented = ungroundedAddresses(step.text, [input.goal, ...s.state.literals,
          ...s.state.answers.map(a => a.answer), ...s.seenUrls, ...index.nodes.flatMap(n => [n.label, n.value])]);
        if (invented.length) {
          reject('This address was not supplied or observed: ' + invented.join(', ') + '. Use an observed search control or link.');
          continue;
        }
        if (!step.text) { reject(operation + ' needs text.'); continue; }
        if (step.textIsLiteral && !input.goal.includes(step.text) && !s.state.literals.includes(step.text) &&
            !s.state.answers.some(a => a.answer.includes(step.text))) {
          reject('textIsLiteral is set, but this text is not an exact part of the goal or of a user answer. Copy the exact wording, ' +
            'or set textIsLiteral=false only for content the user actually asked you to compose. Never construct a URL.');
          continue;
        }
        args.text = step.text;
      }
      if (operation === 'PRESS') args.key = step.key;
      if (operation === 'SCROLL') {
        if (!step.direction) { reject('SCROLL needs a direction.'); continue; }
        args.direction = step.direction;
      }
      const risk = step.risk;
      const pendingRequirement = !VIEW_OPERATIONS.has(operation) && s.state.pendingRequirement(requirement.id);
      if (pendingRequirement) {
        reject('Requirement ' + requirement.id + ' already has an unresolved action ' + pendingRequirement.id +
          ' (' + pendingRequirement.operation + ' ' + pendingRequirement.targetLabel + '); its outcome is unknown. Reconcile ' + pendingRequirement.id +
          ' from inspection before another mutation for this requirement, even through a different control or window.');
        continue;
      }
      if (risk === 'irreversible') {
        if (!requirement.irreversible) {
          reject('An irreversible action needs a requirement that was marked irreversible when the task started.');
          continue;
        }
        // The approval is for this action on this recipient; if either changes, the user is asked again.
        const approval = JSON.stringify([requirement.id, operation, node?.identity ?? null, recipient?.identity ?? null, args]);
        if (input.confirmIrreversible && !s.approvals.has(approval)) {
          const text = 'Allow this action, which cannot be undone? ' + operation + ' ' + (node?.label || args.key || '') + ' — for: ' + requirement.text;
          s.pending = { kind: 'confirm', text, approval };
          s.pausedAt = Date.now();
          state.question = { kind: 'confirm', text };
          host.trace?.('confirmation', { text });
          host.status('needs_user', text);
          return;
        }
        s.approvals.delete(approval);
      }
      const twin = s.state.confirmedTwin(operation, args, node?.identity, recipient?.identity);
      // An old readback is not the current state. Selecting another object or a live UI update
      // can change a setting field after it was filled. Reassigning that field is idempotent.
      const stateChanged = operation === 'SET_VALUE' && node && node.value !== args.text;
      const allocatedRepetition = mission?.allowRepetition && risk === 'reversible';
      if (twin && !step.repeat && !stateChanged && !allocatedRepetition) {
        reject('This control activation already succeeded as ' + twin.id + '. If the current state requires another invocation ' +
          'to advance the objective, set repeat=true and describe its new expected effect. Do not replay an already-completed result just to verify it.');
        continue;
      }
      const blocked = s.state.retryBlock(operation, args, node?.identity, recipient?.identity);
      if (blocked) {
        reject('The same action was already sent as ' + blocked.id + ' and its outcome is unknown. Reconcile ' + blocked.id +
          ' as confirmed or refuted with cited evidence before repeating it.');
        continue;
      }

      // Executor preconditions on the live element. A failure sends nothing.
      let owner = node?.owner ?? observation;
      try {
        if (node?.element && node.states.includes('offscreen') && operation !== 'SCROLL_TO' && node.operations.includes('SCROLL_TO')) {
          await this.bridge.act(this.candidate('scroll', 'SCROLL_TO', node, observation, {}), owner, undefined, input.allowPhysical, signal);
          const identity = node.identity;
          observation = await this.bridge.observe(s.context, signal, this.depth(s));
          this.learn(s, observation);
          index = makeIndex(observation);
          s.context = observation.context;
          const again = index.find(identity, 'strong');
          if (again.length !== 1 || !again[0].operations.includes(operation)) {
            s.issues = [...issues, 'The target could not be identified after scrolling it into view. Nothing else was sent.'];
            continue;
          }
          node = again[0];
          owner = observation;
        }
        // Keys go to whichever window is in front, so the intended one is brought forward first.
        if (operation === 'PRESS' && s.context.app && s.context.windowId)
          await this.bridge.act({ id: 'v2_front', operation: 'FOCUS_WINDOW', app: s.context.app, windowId: s.context.windowId,
            name: 'Bring window to front', description: '' }, observation, undefined, input.allowPhysical, signal);
        // A page element is resolved inside the page at the moment of the action; there is nothing to probe.
        if (this.bridge.probe && observation.context.driver !== 'browser') {
          if (node?.element && POINTER_OPERATIONS.has(operation)) {
            const first = JSON.stringify(await this.bridge.probe(node.element.ref, 'bounds', signal));
            await delay(60, undefined, { signal });
            if (first !== JSON.stringify(await this.bridge.probe(node.element.ref, 'bounds', signal))) {
              s.issues = [...issues, 'The target is still moving. Nothing was sent; the screen was read again.'];
              observation = undefined;
              continue;
            }
          }
          if (operation === 'PRESS' && recipient?.element) {
            const value: any = await this.bridge.probe(recipient.element.ref, 'states', signal);
            const states = Array.isArray(value) ? value : value?.states || value?.value;
            if (!Array.isArray(states) || !states.includes('focused')) {
              s.issues = [...issues, 'Keyboard focus moved away from ' + recipient.label + ' before the key was sent. Nothing was sent.'];
              observation = undefined;
              continue;
            }
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        s.issues = [...issues, 'The target changed before dispatch (' + (error as Error).message + '). Nothing was sent; the screen was read again.'];
        observation = undefined;
        continue;
      }

      const effect = s.state.propose({ step: state.step, requirementId: requirement.id, operation, args, target: node?.identity,
        targetLabel: node?.label || args.key || (operation === 'OPEN_URL' ? clip(args.text || '', 200) : ''), recipient: recipient?.identity, risk,
        expect: step.expect });
      if (node?.element)
        host.event('target', 'Resolved accessibility target.', { targetRef: node.element.ref, bounds: node.element.bounds,
          coordinateSpace: 'native-screen', app: owner.context.app, windowId: node.snapshot?.windowId });
      host.status('executing', 'Executing ' + operation + (node ? ' on ' + node.label : ' ' + args.key) + '.');
      const before = { viewKey: index.viewKey(), facts: index.facts() };
      let delivery: Delivery = 'delivered';
      let note = '';
      let next = s.context;
      // Launch may succeed while resolving its focused window fails. Inspect the requested app,
      // rather than falling back to the old app inventory and choosing OPEN_APP again.
      const recoveryContext: DesktopContext = { app: operation === 'OPEN_APP' ? node?.label : s.context.app, surface: 'window' };
      try {
        next = operation === 'OPEN_URL' ? await this.bridge.openUrl!(validatedUrl(args.text!), signal)
          // A key press on a page carries its recipient, and the page refuses it if focus has moved.
          : await this.bridge.act(this.candidate(effect.id, operation,
            operation === 'PRESS' && observation.context.driver === 'browser' ? recipient : node, observation, args),
            owner, args.text, input.allowPhysical, signal);
      } catch (error) {
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        const disposition = error instanceof NativeError ? (error.disposition as { delivery?: string } | undefined) : undefined;
        // A bridge validation error is raised before anything is sent, and a native error is only
        // known to be harmless when it says so. Opening an address has no validation left at this
        // point, so any failure there leaves the outcome unknown.
        delivery = error instanceof NativeError ? (disposition?.delivery === 'not_delivered' ? 'not_delivered' : 'uncertain')
          : operation === 'OPEN_URL' ? 'uncertain' : 'not_delivered';
        note = error.message;
        if (delivery === 'uncertain') next = recoveryContext;
      }
      const report = this.bridge.takeActionReport?.();
      if (delivery === 'delivered' && report?.verification === 'unverified' && (report.nativeError || ['uncertain', 'unknown'].includes(report.delivery))) {
        delivery = 'uncertain';
        note = report.nativeError?.message || 'The input was sent but its delivery could not be confirmed.';
        next = recoveryContext;
      }
      if (report?.verification === 'already_satisfied') note = 'The control already held this value; nothing was sent.';
      // State the fact the planner would otherwise have to infer: the new tab already exists.
      if (operation === 'OPEN_URL' && delivery === 'delivered') note = 'The address was opened in a new tab of the browser. No further tab or typing is needed for it.';
      if (node?.kind === 'menu') {
        s.menu.invalidate(s.context.app);
        if (delivery !== 'not_delivered') next = { app: s.context.app, surface: 'window' };
      }
      host.status('verifying', 'Reading the desktop again after the action.');
      // A delivered action may have changed which menu commands are available.
      if (delivery !== 'not_delivered' && !VIEW_OPERATIONS.has(operation)) s.menu.invalidate(s.context.app);
      let settled: { observation: DesktopObservation; index?: ObservationIndex; reads: number; changed: boolean; ms: number };
      try {
        settled = delivery === 'not_delivered'
          ? { observation: await this.bridge.observe(s.context, signal, this.depth(s)), reads: 1, changed: false, ms: 0 }
          : await settle(this.bridge, next, signal, makeIndex, contentKey(index), { ...this.depth(s, next.app),
            ...(observation.context.driver === 'browser' ? { beforePage: { url: observation.snapshots[0]?.tree?.value || '', content: pageContentKey(index) } } : {}),
            intervalMs: V2_LIMITS.settleIntervalMs,
            // Focusing or scrolling changes nothing the content comparison looks at, so it is not waited on.
            capMs: ['FOCUS', 'SCROLL', 'SCROLL_TO'].includes(operation) ? 0 : V2_LIMITS.settleCapMs });
      } catch (error) {
        signal.throwIfAborted();
        // The action was sent whether or not the screen can be read afterwards. Record that first.
        s.state.delivered(effect, { delivery: delivery === 'delivered' ? 'uncertain' : delivery, recipient: recipient?.identity,
          note: (note + ' The screen could not be read afterwards: ' + (error as Error).message).trim() });
        if (delivery !== 'not_delivered' && !VIEW_OPERATIONS.has(operation)) s.idle = 0;
        host.trace?.('effect', { effect, settle: { failed: (error as Error).message } });
        host.event('result', 'The action was sent, but the screen could not be read afterwards. Inspecting before anything is repeated.');
        s.context = s.context.app ? { app: s.context.app, surface: 'window' } : {};
        s.previous = undefined;
        observation = undefined;
        continue;
      }
      observation = settled.observation;
      this.learn(s, observation);
      index = settled.index ?? makeIndex(observation);
      s.context = observation.context;
      state.observation = observation;
      state.snapshot = observation.snapshots[0] || null;
      s.previous = before;
      s.state.delivered(effect, { delivery, note: note + (settled.changed || delivery === 'not_delivered' ? '' : ' Nothing on screen changed after this action.'),
        delta: index.delta(before), recipient: recipient?.identity,
        readback: report && (report.expectedValue !== undefined || report.observedValue !== undefined)
          ? { expected: report.expectedValue, observed: report.observedValue } : undefined });
      if (delivery === 'delivered' && report) {
        const matched = report.observedValue !== undefined && report.observedValue === report.expectedValue;
        if (WRITE_OPERATIONS.has(operation) && matched && ['verified', 'reconciled', 'already_satisfied'].includes(report.verification))
          s.state.reconcile(effect.id, 'confirmed', observation.id, [], 'readback');
        else if (POSTCONDITION_OPERATIONS.has(operation) && report.verification === 'verified')
          s.state.reconcile(effect.id, 'confirmed', observation.id, [], 'postcondition');
      }
      // A write that found its value already present changed nothing and is not progress.
      if (delivery !== 'not_delivered' && !VIEW_OPERATIONS.has(operation) && report?.verification !== 'already_satisfied') s.idle = 0;
      host.trace?.('effect', { effect, settle: { reads: settled.reads, changed: settled.changed, ms: settled.ms } });
      host.event('result', delivery === 'not_delivered' ? 'Nothing was sent: ' + note
        : delivery === 'uncertain' ? 'The action may have been delivered; inspecting before anything is repeated.'
        : effect.outcome === 'confirmed' ? 'Delivered and confirmed by readback.' : 'Delivered. Checking the result.',
        { effect: { id: effect.id, operation, target: effect.targetLabel, delivery, outcome: effect.outcome, delta: effect.delta } });
      host.event('step', clip(operation + ' ' + effect.targetLabel + ': ' + delivery + '. ' +
        (effect.delta.scopeChanged ? 'The view changed.' : effect.delta.added.length + ' added, ' + effect.delta.removed.length + ' removed.'), 1000));
      signal.throwIfAborted();
      if (singleStep && delivery !== 'not_delivered' && !VIEW_OPERATIONS.has(operation)) {
        host.status('paused', 'One desktop action finished. Continue with Step or Run.');
        return;
      }
    }
  }

  private candidate(id: string, operation: Exclude<PlanOperation, 'OPEN_URL'>, node: IndexedNode | undefined, observation: DesktopObservation,
    args: Effect['args']): DesktopCandidate {
    const context = (node?.owner ?? observation).context;
    const snapshot = node?.snapshot ?? observation.snapshots[0];
    return {
      id: 'v2_' + id, operation, description: '', name: clip(node?.label || args.key || operation, 1000),
      app: node?.kind === 'application' ? node.appId! : context.app || node?.identity.app || 'macOS',
      windowId: node?.kind === 'window' ? node.windowId : node?.kind === 'element' ? snapshot?.windowId || context.windowId : context.windowId,
      snapshotId: node?.kind === 'application' || node?.kind === 'window' ? undefined : snapshot?.id,
      targetRef: node?.element?.ref, role: node?.role, key: args.key,
      direction: args.direction as DesktopCandidate['direction'], bounds: node?.element?.bounds,
    };
  }

  /** Resolve a read scope to the context of the next observation. Sends no desktop input. */
  private async scope(step: PlanStep, s: Session, index: ObservationIndex, observation: DesktopObservation,
    signal: AbortSignal): Promise<DesktopContext | string> {
    const context = s.context;
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
      return this.bridge.act({ id: 'v2_search', operation: 'SEARCH_APPS', app: 'macOS', name: 'Application search', description: '' },
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
