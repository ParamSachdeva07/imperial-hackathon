import {
  OrchestratorResultSchema, type NavigationMission, type OrchestratorRequest, type TaskStatus,
} from '../../../../../packages/contracts/src/index';
import type { WorkspaceBridge } from '../../desktop/workspace';
import { KEYS } from '../../desktop/workspace';
import { PAGE_KEYS } from '../../page/page-workspace';
import { exactInputs } from '../task-instructions';
import type { DecisionProvider } from '../../services/decision-client';
import { BrokerError } from '../../services/decision-client';
import { ObservationIndex } from './observation-index';
import { PlannerLoop, type PlannerHost } from './planner-loop';
import { clip } from './text';
import { handoffEffects, sessionHandoff } from './session-handoff';
import { MilestonePlan } from './milestone-plan';
import { ungroundedAddresses } from './url-provenance';
import { SemanticMemory } from './semantic-memory';
import { setTimeout as delay } from 'node:timers/promises';

/** The orchestrator assigns objectives; the task ledger survives every navigation handoff. */
export class NavigationOrchestrator {
  private taskId?: string;
  private navigator: PlannerLoop;
  private sessions: OrchestratorRequest['sessions'] = [];
  private mission?: NavigationMission;
  private handoff?: OrchestratorRequest['handoff'];
  private plan = new MilestonePlan();
  private issues: string[] = [];
  private observedAddresses = new Set<string>();
  private memory = new SemanticMemory();
  constructor(private bridge: WorkspaceBridge, private provider: DecisionProvider,
    private defaultBrowser?: () => Promise<string | undefined>) {
    this.navigator = new PlannerLoop(bridge, provider, defaultBrowser);
  }

  async advance(host: PlannerHost, singleStep: boolean, signal: AbortSignal, answer?: string) {
    const { state } = host, taskId = state.taskId!, input = state.input!;
    if (!this.provider.orchestrate) throw new Error('The broker does not support orchestration.');
    if (this.taskId !== taskId) {
      this.taskId = taskId;
      this.navigator = new PlannerLoop(this.bridge, this.provider, this.defaultBrowser);
      this.sessions = []; this.mission = undefined;
      this.handoff = undefined;
      this.plan = new MilestonePlan(); this.issues = [];
      this.observedAddresses.clear();
      // A new user instruction is a new orchestration. Only controller sessions within it
      // share memory. The goal already appears in current_state, so do not duplicate it.
      this.memory = new SemanticMemory();
    }
    for (;;) {
      signal.throwIfAborted();
      if (!this.mission) {
        if (this.issues.length) this.memory.append({ taskId, kind: 'correction',
          summary: this.issues.join('\n').slice(0, 6000), inputs: [], facts: [] });
        host.status('observing', 'Orchestrator: reading progress and the current screen.');
        const observation = await this.bridge.observe(this.navigator.context().app ? this.navigator.context()
          : input.app ? { app: input.app } : {}, signal, { startDepth: 3, query: input.goal });
        signal.throwIfAborted();
        state.observation = observation;
        state.snapshot = observation.snapshots[0] ?? null;
        const ledger = this.navigator.snapshot();
        const index = new ObservationIndex(observation, { allowPhysical: input.allowPhysical });
        const selected = index.select({ query: '', requirementTerms: [input.goal], pinned: [] });
        for (const text of [...observation.notices, ...index.nodes.flatMap(n => [n.label, n.value])])
          for (const address of ungroundedAddresses(text, [])) this.observedAddresses.add(address);
        const request: OrchestratorRequest = {
          taskId, goal: input.goal, answers: (ledger?.answers ?? []).slice(-8),
          history: this.memory.context(),
          requirements: (ledger?.requirements ?? []).map(r => ({ id: r.id, text: r.text, irreversible: r.irreversible,
            kind: r.kind, status: r.status, evidence: r.evidence.slice(-6).map(e => clip(e.row, 700)) })),
          effects: handoffEffects(ledger?.effects ?? []).map(e => ({
            operation: e.operation, target: clip(e.targetLabel, 400), delivery: e.delivery, outcome: e.outcome, note: clip(e.note, 600),
            id: e.id, requirementId: e.requirementId, text: clip(e.args.text || e.args.key || '', 600),
            readback: clip(e.readback?.observed || '', 600), expect: clip(e.expect, 500),
            readbackExpected: clip(e.readback?.expected || '', 600), outcomeSource: e.reconciledBy?.source || 'none',
            added: e.delta.added, removed: e.delta.removed, scopeChanged: e.delta.scopeChanged,
          })),
          screen: { observationId: observation.id, capturedAt: observation.capturedAt,
            app: observation.context.app ?? '', title: clip(state.snapshot?.windowTitle ?? '', 1000),
            notices: observation.notices.slice(0, 12).map(n => clip(n, 1000)), elements: selected.elements.slice(0, 60), scopes: selected.scopes,
            driver: observation.context.driver || 'native', complete: state.snapshot?.complete === true,
            exactUserText: exactInputs(input).map(i => i.text).slice(0, 8),
            allowedKeys: observation.context.driver === 'browser' ? PAGE_KEYS : state.snapshot?.complete &&
              observation.windows.some(w => w.id === observation.context.windowId && w.focused) ? KEYS : [] },
          sessions: this.sessions.slice(-8), stepsLeft: null,
          plan: this.plan.milestones, branches: this.plan.branches, issues: this.issues.slice(-8),
          ...(this.handoff ? { handoff: this.handoff } : {}),
        };
        host.trace?.('orchestrator_request', request);
        host.status('deciding', 'Orchestrator: choosing the next navigation session.');
        const started = Date.now();
        let result;
        try {
          result = OrchestratorResultSchema.parse(await this.provider.orchestrate(request, signal));
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof BrokerError) || !error.retryable) throw error;
          host.event('result', 'Retrying the orchestrator after a transient model/API failure: ' + error.message);
          this.issues = [error.message + ' The task and its confirmed effects are preserved; continue from the current screen.'];
          await delay(2000, undefined, { signal });
          continue;
        }
        signal.throwIfAborted();
        if (result.taskId !== taskId) throw new Error('Rejected a stale orchestration result.');
        host.trace?.('orchestrator_result', { result, durationMs: Date.now() - started });
        this.memory.append({ taskId, kind: result.kind === 'navigate' ? 'assignment' : 'decision',
          summary: clip(JSON.stringify({ kind: result.kind, milestoneId: result.milestoneId, objective: result.objective,
            doneWhen: result.doneWhen, context: result.context, message: result.message }), 6000),
          inputs: result.inputs ?? [], facts: [] });
        host.event('decision', 'Orchestrator: ' + (result.objective || result.message || result.kind), { model: result.model, usage: result.usage });
        if (result.kind === 'ask_user') {
          // Tolerate an older broker response without surfacing a question in the overlay.
          this.issues = ['Clarification questions are disabled. Resolve delegated choices from the goal and observed facts. ' +
            'If indispensable information is unavailable, report the concrete blocker without guessing. Proposed question: ' + result.message];
          continue;
        }
        if (result.kind === 'navigate' || result.plan.length || this.plan.milestones.length) {
          const invented = ungroundedAddresses([result.objective, result.context,
            ...result.plan.flatMap(m => [m.text, m.doneWhen, m.condition])].join('\n'),
          [input.goal, ...exactInputs(input).map(i => i.text), ...request.answers.map(a => a.answer), ...this.observedAddresses]);
          if (invented.length) {
            this.issues = ['Unobserved addresses in the proposed plan: ' + invented.join(', ') +
              '. Use semantic completion criteria and observed controls or search. Do not invent an address in any field.'];
            continue;
          }
          const reviewErrors = result.reviews.flatMap(review => {
            const error = this.navigator.reviewMilestone(review.milestoneId, review.evidence, observation, index,
              new Set(request.screen.elements.map(e => e.id)), review.status ?? 'evidenced', review.reason);
            return error ? [error] : [];
          });
          if (reviewErrors.length) { this.issues = reviewErrors; continue; }
          if (ledger) state.requirements = ledger.requirements.map(r => ({
            id: r.id, text: r.text, irreversible: r.irreversible, status: r.status,
          }));
          const planError = this.plan.define(result.plan) || this.plan.decide(result.branches, ledger?.requirements ?? []);
          if (planError) { this.issues = [planError]; continue; }
        }
        if (result.kind === 'finish') {
          if (ledger && this.plan.complete(ledger.requirements)) {
            state.completion = { kind: 'requirements', summary: result.message || 'All task requirements are evidenced.',
              evidence: ledger.requirements.flatMap(r => r.evidence.map(e => clip(e.row, 900))).slice(0, 40) };
            host.status('completed', state.completion.summary);
            return;
          }
          this.issues = ['Finish refused: each planned milestone must be evidenced or its condition explicitly skipped using dependency evidence.'];
          continue;
        }
        if (result.kind === 'finish_unverified') {
          if (!ledger || !this.plan.completeUnverified(ledger.requirements)) {
            this.issues = ['Unverified completion refused: some requirements still need work. Inspect the ledger and continue or report blocked.'];
            continue;
          }
          // Use the tool's facts rather than letting a parent summary relabel uncertainty as success.
          const message = result.message || 'Actions were delivered, but the result could not be verified.';
          state.completion = { kind: 'requirements', summary: message,
            evidence: ledger.requirements.map(r => r.status + ': ' + r.text) };
          host.status('completed_unverified', message);
          return;
        }
        if (result.kind === 'blocked') {
          if (!this.sessions.length) {
            this.sessions.push({ objective: 'Inspect before judging availability', result: 'No navigation has been attempted. Use navigate to inspect the relevant application and offered scopes first.', steps: 0 });
            continue;
          }
          host.status('blocked', result.message || 'The remaining task could not be verified.');
          return;
        }
        const milestone = this.plan.select(result.milestoneId, ledger?.requirements ?? []);
        if (typeof milestone === 'string') { this.issues = [milestone]; continue; }
        this.issues = [];
        this.mission = { objective: result.objective, doneWhen: result.doneWhen, context: result.context, milestone };
        this.mission.inputs = result.inputs ?? [];
        this.mission.allowRepetition = result.allowRepetition === true;
        host.trace?.('navigation_session_start', this.mission);
      }

      const startedAt = state.step;
      const attemptedScopes = new Set<string>();
      let terminal: TaskStatus | undefined, message = '';
      // Child completion is a tool result, not permission to declare the whole task finished.
      const childHost: PlannerHost = { ...host,
        trace: (kind, data) => {
          if (kind === 'plan_step') {
            const step = (data as { step: { kind: string; scope: string; query: string } }).step;
            if (step.kind === 'read') attemptedScopes.add(step.scope);
            if (step.kind === 'find') attemptedScopes.add('find: ' + step.query);
          }
          host.trace?.(kind, data);
        },
        status: (status, text) => {
          if (['completed', 'completed_unverified', 'blocked'].includes(status)) { terminal = status; message = text; }
          else host.status(status, text);
        },
        event: (type, text, details) => { if (type === 'result') message = text; host.event(type, text, details); },
      };
      let outcome: 'yielded' | 'blocked' | void;
      try {
        outcome = await this.navigator.advance(childHost, singleStep, signal, answer, this.mission, [], this.plan.milestones);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof BrokerError && !error.retryable) throw error;
        // A failed navigation call is a tool result. Its existing ledger survives the replan;
        // the coordinator must inspect uncertain delivery rather than reset and replay it.
        outcome = 'blocked';
        message = 'Navigation error: ' + (error instanceof Error ? error.message : String(error));
        host.event('result', message);
      }
      answer = undefined;
      signal.throwIfAborted();
      if (state.status === 'needs_user' || state.status === 'paused') return;
      const summary = { objective: this.mission.objective, result: clip((terminal || outcome || 'returned') + ': ' + message, 1500),
        steps: state.step - startedAt };
      this.sessions.push(summary);
      const ledger = this.navigator.snapshot();
      this.handoff = sessionHandoff({ outcome: terminal || outcome || 'returned', reason: message,
        milestoneId: this.mission.milestone?.id,
        completionProposal: this.navigator.completionProposal(),
        context: this.navigator.context(), observation: state.observation, ledger,
        issues: this.navigator.issues(), attemptedScopes });
      host.trace?.('navigation_session_end', { ...summary, handoff: this.handoff });
      const report = this.navigator.report();
      const facts = report?.facts.length ? report.facts : state.observation
        ? new ObservationIndex(state.observation, { allowPhysical: input.allowPhysical }).nodes
          .filter(n => ['statictext', 'heading', 'status'].includes(n.role))
          .slice(0, 12).map(n => clip([n.label, n.value].filter(Boolean).join(': '), 1000)) : [];
      this.memory.append({ taskId, kind: 'result', inputs: [], facts,
        summary: JSON.stringify({ outcome: this.handoff.outcome,
          report: report ? { status: report.status, summary: report.summary,
            remaining: report.remaining } : undefined,
          reason: report ? undefined : this.handoff.reason, unresolvedEffects: this.handoff.unresolvedEffects,
          issues: this.handoff.issues, next: this.handoff.next }).slice(0, 6000) });
      this.mission = undefined;
    }
  }
}
