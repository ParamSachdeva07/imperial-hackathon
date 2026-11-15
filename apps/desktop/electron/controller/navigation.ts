import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { TaskInputSchema, type ControllerState, type TaskEvent, type TaskStatus } from '../../../../packages/contracts/src/index';
import type { DecisionProvider } from '../services/decision-client';
import type { WorkspaceBridge } from '../desktop/workspace';
import { nativeErrorDetails } from '../desktop/action-verification';
import { Orchestrator } from './orchestrator';

const initial = (): ControllerState => ({ taskId: null, status: 'idle', busy: false, input: null, step: 0, events: [],
  plan: [], completion: null, question: null });

/** One task at a time: start it, replace it, stop it, and publish what it is doing. */
export class NavigationController {
  private current = initial();
  private listeners = new Set<(state: ControllerState) => void>();
  private abort?: AbortController;
  private activeRun?: Promise<void>;
  private replacing = false;
  private cancellationRevision = 0;
  private nextEvent = 1;
  private orchestrator: Orchestrator;
  constructor(bridge: WorkspaceBridge, provider: DecisionProvider,
    /** Every event and model exchange of a task is appended to <traceDir>/<taskId>.jsonl. */
    private traceDir?: string,
    /** Resolves the bundle id that opens web links for this user. */
    defaultBrowser?: () => Promise<string | undefined>) {
    this.orchestrator = new Orchestrator(bridge, provider, defaultBrowser);
    if (traceDir) try { mkdirSync(traceDir, { recursive: true, mode: 0o700 }); } catch { this.traceDir = undefined; }
  }

  /** The full record of a run. The in-memory event list keeps only the last 150 entries. */
  private trace(kind: string, data: unknown) {
    if (!this.traceDir || !this.current.taskId) return;
    try {
      appendFileSync(path.join(this.traceDir, this.current.taskId + '.jsonl'),
        JSON.stringify({ at: Date.now(), taskId: this.current.taskId, kind, data }) + '\n', { mode: 0o600 });
    } catch { /* Tracing must never fail a task. */ }
  }
  state(): ControllerState { return structuredClone(this.current); }
  subscribe(listener: (state: ControllerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish() { for (const listener of this.listeners) listener(this.state()); }
  private event(type: TaskEvent['type'], message: string, details?: Record<string, unknown>) {
    this.current.events.push({ id: this.nextEvent++, at: Date.now(), taskId: this.current.taskId, type, message, details });
    this.trace('event', this.current.events.at(-1));
    this.current.events = this.current.events.slice(-150);
    this.publish();
  }
  private status(status: TaskStatus, message: string) {
    this.current.status = status;
    this.event('state', message);
  }

  start(input: unknown): ControllerState {
    if (this.replacing) throw new Error('A replacement task is already waiting for the previous action to settle.');
    if (this.current.busy) throw new Error('A task is still running. Stop it or send a replacement.');
    if (this.current.status === 'needs_user') throw new Error('Answer or stop the current task first.');
    const parsed = TaskInputSchema.parse(input);
    this.current = { ...initial(), taskId: randomUUID(), input: parsed, busy: true };
    this.abort = new AbortController();
    this.trace('task', { input: parsed });
    this.status('preparing', 'Starting.');
    this.activeRun = this.advance();
    return this.state();
  }
  /** Stop the running task, wait for any dispatched action to return, then start the new one. */
  async replace(input: unknown): Promise<ControllerState> {
    const parsed = TaskInputSchema.parse(input);
    if (this.replacing) throw new Error('A replacement task is already pending.');
    this.replacing = true;
    const previousTaskId = this.current.taskId;
    try {
      this.cancel();
      const revision = this.cancellationRevision;
      await this.activeRun;
      if (revision !== this.cancellationRevision) throw new Error('Replacement cancelled. No new task started.');
      this.replacing = false;
      const state = this.start(parsed);
      this.event('state', 'Started the new instruction after the previous run stopped.', { previousTaskId });
      return state;
    } finally { this.replacing = false; }
  }
  /** The user's yes or no to an irreversible action. */
  answer(text: unknown): ControllerState {
    if (this.current.busy || this.current.status !== 'needs_user') throw new Error('There is no question waiting for an answer.');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Give an answer of at most 1,000 characters.');
    this.current.busy = true;
    this.trace('answer', { text });
    this.activeRun = this.advance(text.trim());
    return this.state();
  }
  cancel(): ControllerState {
    this.cancellationRevision++;
    if (!this.current.busy && this.current.status !== 'needs_user') return this.state();
    this.abort?.abort();
    this.status(this.current.busy ? 'stopping' : 'cancelled', this.current.busy
      ? 'Stopping. An already-dispatched action may finish; no further step will start.' : 'Task cancelled.');
    return this.state();
  }
  private async advance(answer?: string) {
    const signal = this.abort!.signal;
    try {
      await this.orchestrator.advance({
        state: this.current,
        status: (status, message) => this.status(status, message),
        event: (type, message, details) => this.event(type, message, details),
        trace: (kind, data) => this.trace(kind, data),
      }, signal, answer);
    } catch (error) {
      if (signal.aborted) this.status('cancelled', 'Cancelled. No further desktop actions will run.');
      else {
        this.current.status = 'failed';
        this.event('error', error instanceof Error ? error.message : String(error), nativeErrorDetails(error));
      }
    } finally {
      this.current.busy = false;
      this.publish();
    }
  }
}
