import { setTimeout as delay } from 'node:timers/promises';
import {
  OrchestratorResultSchema, type Mission, type OrchestratorRequest, type OrchestratorResult, type PlanItem,
} from '../../../../packages/contracts/src/index';
import type { WorkspaceBridge } from '../desktop/workspace';
import { NativeError } from '../desktop/native-client';
import { BrokerError, type DecisionProvider } from '../services/decision-client';
import { Navigator, type Host } from './navigator';

/** Roughly what Luna is shown of earlier sessions. Beyond it the oldest are dropped. */
const HISTORY_CHARS = 48_000;
/** The first wait after Luna fails to answer; it doubles up to 30 s. Tests shorten it. */
export const RETRY = { baseMs: 2000 };

/**
 * Luna plans, the navigator executes, and that repeats. Each session's result describes where
 * things stand, so one Luna call decides what happens next: another session, finished, or
 * cannot be done. Luna alone ends a task, and nothing here asks the user what to do.
 */
export class Orchestrator {
  private taskId?: string;
  private navigator: Navigator;
  /** Memory of this task: what each session was asked and what it reported. */
  private history: OrchestratorRequest['history'] = [];
  private plan: PlanItem[] = [];
  private mission?: Mission;
  constructor(bridge: WorkspaceBridge, private provider: DecisionProvider, defaultBrowser?: () => Promise<string | undefined>) {
    this.navigator = new Navigator(bridge, provider, defaultBrowser);
  }

  /** `answer` is the user's reply to an irreversible-action confirmation, when one was pending. */
  async advance(host: Host, signal: AbortSignal, answer?: string) {
    const { state } = host, taskId = state.taskId!, input = state.input!;
    if (this.taskId !== taskId) Object.assign(this, { taskId, history: [], plan: [], mission: undefined });
    this.navigator.begin(taskId, input);
    for (;;) {
      signal.throwIfAborted();
      if (!this.mission) {
        const screen = await this.navigator.screen(host, signal);
        const decision = await this.decide(host, { taskId, goal: input.goal, callerContext: input.context, plan: this.plan, history: this.history, screen }, signal);
        if (decision.plan.length) this.plan = decision.plan;
        state.plan = this.plan;
        host.event('decision', 'Luna: ' + (decision.next === 'continue' ? decision.objective : decision.next + '. ' + decision.message),
          { model: decision.model, usage: decision.usage });
        if (decision.next !== 'continue') {
          const last = this.history.at(-1)?.result;
          state.completion = { summary: decision.message, facts: last?.facts ?? [], location: { app: screen.app, window: screen.title, address: screen.address } };
          // Luna decides that the task is over. Whether every action is known to have landed is a fact, so code states it.
          const unverified = decision.next === 'finish' && (this.navigator.hasUncertainActions() || last?.status === 'unverified');
          host.status(decision.next === 'blocked' ? 'blocked' : unverified ? 'completed_unverified' : 'completed',
            (decision.message || (decision.next === 'blocked' ? 'The task cannot be completed.' : 'Done.')) +
            (unverified ? ' The result of at least one action could not be confirmed.' : ''));
          return;
        }
        this.mission = { objective: decision.objective, doneWhen: decision.doneWhen, context: decision.context, irreversible: decision.irreversible };
        host.trace?.('session_start', this.mission);
      }
      let result;
      try {
        result = await this.navigator.run(host, this.mission, signal, answer);
      } catch (error) {
        signal.throwIfAborted();
        // An adapter or model failure is something Luna can route around. Anything else is a defect and fails the task.
        if (!(error instanceof NativeError) && !(error instanceof BrokerError && error.retryable)) throw error;
        result = this.navigator.failed('The session stopped on an error: ' + error.message);
        host.event('result', result.summary);
      }
      answer = undefined;
      if (!result) return;
      host.trace?.('session_end', { assignment: this.mission, result });
      this.history.push({ assignment: this.mission, result });
      while (this.history.length > 1 && JSON.stringify(this.history).length > HISTORY_CHARS) this.history.shift();
      this.mission = undefined;
    }
  }

  /** A transient failure is retried for as long as the task runs; a rejected request once, with less history. */
  private async decide(host: Host, request: OrchestratorRequest, signal: AbortSignal): Promise<OrchestratorResult> {
    host.trace?.('orchestrator_request', request);
    host.status('deciding', 'Luna is choosing what happens next.');
    for (let attempt = 0, trimmed = false; ; attempt++) {
      const started = Date.now();
      try {
        const result = OrchestratorResultSchema.parse(await this.provider.orchestrate(request, signal));
        if (result.taskId !== request.taskId) throw new Error('Rejected a stale orchestration result.');
        host.trace?.('orchestrator_result', { result, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof BrokerError)) throw error;
        if (!error.retryable) {
          if (trimmed || request.history.length < 2) throw error;
          trimmed = true;
          request = { ...request, history: request.history.slice(-1) };
          continue;
        }
        const wait = Math.min(30_000, RETRY.baseMs * 2 ** Math.min(attempt, 4));
        host.event('result', 'Luna did not answer (' + error.message + '). Trying again in ' + Math.round(wait / 1000) + ' s; nothing was sent to the desktop.');
        await delay(wait, undefined, { signal });
      }
    }
  }
}
