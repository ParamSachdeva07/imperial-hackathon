import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  TaskInputSchema,
  DecisionSchema,
  type Candidate,
  type ControllerState,
  type Decision,
  type Snapshot,
  type TaskInput,
  type TaskStatus,
} from '../../../../packages/contracts/src/index';
import { documentEditor, type DesktopBridge } from '../desktop/types';
import type { DecisionProvider } from '../services/decision-client';
import { DesktopLoop } from './desktop-loop';
import type { WorkspaceBridge } from '../desktop/workspace';
import { nativeErrorDetails } from '../desktop/action-verification';
import { PlannerLoop } from './v2/planner-loop';
import { NavigationOrchestrator } from './v2/orchestrator';
import { defaultBrowserBundle } from '../desktop/app-discovery';

export function candidatesFor(snapshot: Snapshot): Candidate[] {
  const editor = documentEditor(snapshot);
  if (!editor) return [];
  const common = { targetRef: editor.ref, role: editor.role, name: 'Document body', bounds: editor.bounds };
  const result: Candidate[] = [];
  if (editor.actions.includes('SetValue'))
    result.push({
      ...common,
      id: 'write_document',
      operation: 'SET_VALUE',
      inputId: 'document_text',
      description: 'Set the fresh test document body to the exact supplied document_text.',
    });
  if (editor.actions.includes('SetFocus'))
    result.push({
      ...common,
      id: 'focus_document',
      operation: 'FOCUS',
      description: 'Focus the document body without changing its text.',
    });
  if (editor.actions.includes('Click'))
    result.push({
      ...common,
      id: 'click_document',
      operation: 'CLICK',
      description: 'Activate the document body without changing its text.',
    });
  return result;
}
export function validateDecision(
  decision: Decision,
  taskId: string,
  snapshot: Snapshot,
  candidates: Candidate[],
): Candidate {
  DecisionSchema.parse(decision);
  if (decision.taskId !== taskId || decision.snapshotId !== snapshot.id)
    throw new Error('Rejected a stale or mismatched model decision.');
  if (decision.candidateId === 'BLOCKED')
    throw new Error('The decision provider could not choose a supported next step.');
  const candidate = candidates.find((c) => c.id === decision.candidateId);
  if (!candidate || !snapshot.elements.some((e) => e.ref === candidate.targetRef))
    throw new Error('Rejected a target outside this snapshot.');
  return candidate;
}
const initial = (): ControllerState => ({
  taskId: null,
  status: 'idle',
  busy: false,
  input: null,
  document: null,
  snapshot: null,
  decision: null,
  step: 0,
  verifiedText: null,
  events: [],
});
export class NavigationController {
  private current = initial();
  private listeners = new Set<(state: ControllerState) => void>();
  private abort?: AbortController;
  private activeRun?: Promise<void>;
  private replacing = false;
  private cancellationRevision = 0;
  private nextEvent = 1;
  private desktopLoop?: DesktopLoop;
  private plannerLoop?: PlannerLoop;
  private orchestrator?: NavigationOrchestrator;
  private singleStep = false;
  constructor(
    private bridge: DesktopBridge,
    private providers: Record<'jev' | 'local', DecisionProvider>,
    private workspace?: WorkspaceBridge,
    /** Every event and model exchange of a task is appended to <traceDir>/<taskId>.jsonl. */
    private traceDir?: string,
    /** The bridge the planner controller uses; it may read web pages through the browser extension. */
    plannerWorkspace: WorkspaceBridge | undefined = workspace,
  ) {
    if (workspace) {
      this.desktopLoop = new DesktopLoop(workspace, providers.jev);
      this.plannerLoop = new PlannerLoop(plannerWorkspace ?? workspace, providers.jev, traceDir ? defaultBrowserBundle : undefined);
      this.orchestrator = new NavigationOrchestrator(plannerWorkspace ?? workspace, providers.jev,
        traceDir ? defaultBrowserBundle : undefined);
    }
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
  private validateInput(input: unknown) {
    const parsed = TaskInputSchema.parse(input);
    if (parsed.mode === 'desktop' && (!this.desktopLoop || parsed.provider !== 'jev'))
      throw new Error('Full desktop navigation requires the native workspace adapter and Jev.');
    if (parsed.mode === 'desktop' && parsed.controller === 'v2' && !this.providers.jev.plan)
      throw new Error('The v2 controller needs a provider with the planner route.');
    if (parsed.orchestration && !this.providers.jev.orchestrate) throw new Error('This provider cannot orchestrate navigation.');
    if (parsed.mode === 'textedit' && !parsed.text)
      throw new Error('Supply exact text for the TextEdit regression test.');
    return parsed;
  }
  async applications() {
    return this.workspace ? this.workspace.applications() : [];
  }
  state(): ControllerState {
    return structuredClone(this.current);
  }
  subscribe(listener: (state: ControllerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish() {
    for (const listener of this.listeners) listener(this.state());
  }
  private event(
    type: ControllerState['events'][number]['type'],
    message: string,
    details?: Record<string, unknown>,
  ) {
    this.current.events.push({
      id: this.nextEvent++,
      at: Date.now(),
      taskId: this.current.taskId,
      type,
      message,
      details,
    });
    this.trace('event', this.current.events.at(-1));
    this.current.events = this.current.events.slice(-150);
    this.publish();
  }
  private status(status: TaskStatus, message: string) {
    this.current.status = status;
    this.event('state', message);
  }
  private assertIdle() {
    if (this.current.busy)
      throw new Error('A native operation is still running. Wait for it to finish or stop.');
  }
  async prepare(): Promise<ControllerState> {
    this.assertIdle();
    this.current = initial();
    this.current.busy = true;
    this.abort = new AbortController();
    this.status('preparing', 'Creating a fresh TextEdit document.');
    try {
      this.current.document = await this.bridge.prepare(this.abort.signal);
      this.current.snapshot = await this.bridge.snapshot(this.current.document, this.abort.signal);
      this.status('idle', 'Fresh test document ready: ' + this.current.document.windowTitle);
    } catch (e) {
      this.handleError(e);
    } finally {
      this.current.busy = false;
      this.publish();
    }
    return this.state();
  }
  async inspect(): Promise<ControllerState> {
    this.assertIdle();
    if (!this.current.document && !this.workspace) throw new Error('No desktop adapter is available.');
    this.current.busy = true;
    try {
      if (this.current.document) this.current.snapshot = await this.bridge.snapshot(this.current.document);
      else {
        this.current.observation = await this.workspace!.observe(this.current.observation?.context || {});
        this.current.snapshot = this.current.observation.snapshots[0] || null;
      }
      if (!this.current.snapshot) {
        this.event('observation', 'Read the available application inventory.');
        return this.state();
      }
      this.event(
        'observation',
        'Read ' + this.current.snapshot.elements.length + ' accessibility controls.',
        { snapshotId: this.current.snapshot.id, windowId: this.current.snapshot.windowId },
      );
    } finally {
      this.current.busy = false;
      this.publish();
    }
    return this.state();
  }
  start(input: unknown, singleStep = false): ControllerState {
    if (this.replacing) throw new Error('A replacement task is already waiting for the previous action to settle.');
    this.assertIdle();
    if (this.current.status === 'paused') throw new Error('Resume or stop the current task first.');
    if (this.current.status === 'needs_user') throw new Error('Answer or stop the current task first.');
    const parsed = this.validateInput(input);
    // A prepared blank document can be reused once. Each later task gets a fresh document.
    const prepared =
      parsed.mode === 'textedit' && this.current.taskId === null ? this.current.document : null;
    this.current = { ...initial(), taskId: randomUUID(), input: parsed, document: prepared, busy: true };
    this.abort = new AbortController();
    this.trace('task', { input: parsed });
    this.status(
      'preparing',
      parsed.provider === 'jev'
        ? 'Starting a live Jev task.'
        : 'Starting local test policy. This operates real TextEdit without calling Jev.',
    );
    this.activeRun = this.advance(singleStep);
    return this.state();
  }
  async replace(input: unknown, singleStep = false): Promise<ControllerState> {
    // Validate before disturbing the current task. Only one handoff may own
    // the desktop; late old-run results finish before new state is installed.
    const parsed = this.validateInput(input);
    if (this.replacing) throw new Error('A replacement task is already pending.');
    if (this.current.busy && !this.activeRun) throw new Error('Wait for the current setup operation to settle.');
    this.replacing = true;
    const previousTaskId = this.current.taskId;
    try {
      this.cancel();
      const revision = this.cancellationRevision;
      await this.activeRun;
      if (revision !== this.cancellationRevision) throw new Error('Replacement cancelled. No new task started.');
      this.replacing = false;
      const state = this.start(parsed, singleStep);
      this.event('state', 'Started the new instruction after the previous run stopped.', { previousTaskId });
      return state;
    } finally { this.replacing = false; }
  }
  resume(singleStep = false): ControllerState {
    this.assertIdle();
    if (this.current.status !== 'paused') throw new Error('There is no paused task to resume.');
    this.current.busy = true;
    this.activeRun = this.advance(singleStep);
    return this.state();
  }
  /** Answer a question or an irreversible-action confirmation raised by the v2 controller. */
  answer(text: unknown): ControllerState {
    this.assertIdle();
    if (this.current.status !== 'needs_user') throw new Error('There is no question waiting for an answer.');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Give an answer of at most 1,000 characters.');
    this.current.busy = true;
    this.trace('answer', { text });
    this.activeRun = this.advance(this.singleStep, text.trim());
    return this.state();
  }
  cancel(): ControllerState {
    this.cancellationRevision++;
    if (!this.current.busy && !['paused', 'needs_user'].includes(this.current.status)) return this.state();
    this.abort?.abort();
    this.status(
      this.current.busy ? 'stopping' : 'cancelled',
      this.current.busy
        ? 'Stopping. An already-dispatched native action may finish; no further step will start.'
        : 'Task cancelled.',
    );
    return this.state();
  }
  private handleError(error: unknown) {
    if (this.abort?.signal.aborted)
      this.status('cancelled', 'Cancelled. No further desktop actions will run.');
    else {
      this.current.status = 'failed';
      this.event('error', error instanceof Error ? error.message : String(error), nativeErrorDetails(error));
    }
  }
  private async advance(singleStep: boolean, answer?: string) {
    this.singleStep = singleStep;
    const signal = this.abort!.signal;
    const taskId = this.current.taskId!;
    const input = this.current.input!;
    const history: string[] = [];
    const deadline = Date.now() + 90_000;
    try {
      if (input.mode === 'desktop') {
        const host = {
          state: this.current,
          status: (status: TaskStatus, message: string) => this.status(status, message),
          event: (type: 'observation' | 'decision' | 'target' | 'step' | 'result', message: string,
            details?: Record<string, unknown>) => this.event(type, message, details),
          trace: (kind: string, data: unknown) => this.trace(kind, data),
        };
        if (input.controller === 'v2' && input.orchestration) await this.orchestrator!.advance(host, singleStep, signal, answer);
        else if (input.controller === 'v2') await this.plannerLoop!.advance(host, singleStep, signal, answer);
        else await this.desktopLoop!.advance(host, singleStep, signal);
        return;
      }
      if (!this.current.document) this.current.document = await this.bridge.prepare(signal);
      signal.throwIfAborted();
      let unchanged = 0;
      while (this.current.step < input.maxSteps && Date.now() < deadline) {
        signal.throwIfAborted();
        this.status('observing', 'Reading the current TextEdit accessibility tree.');
        const snapshot = await this.bridge.snapshot(this.current.document, signal);
        this.current.snapshot = snapshot;
        const editor = documentEditor(snapshot);
        if (!editor) throw new Error('The document editor is not uniquely accessible.');
        if (editor.value === input.text) {
          this.current.verifiedText = editor.value;
          this.status('completed', 'Verified: the document body matches the supplied text exactly.');
          this.event('result', 'Text-entry test passed.', {
            windowId: snapshot.windowId,
            characters: editor.value.length,
          });
          return;
        }
        if (editor.value !== '')
          throw new Error('The test document contains unexpected text. Stopped without overwriting it.');
        const candidates = candidatesFor(snapshot);
        if (!candidates.length) throw new Error('No supported document actions are available.');
        this.current.step++;
        this.status(
          'deciding',
          'Selecting the next action with ' +
            (input.provider === 'jev' ? 'Jev' : 'the local test policy') +
            '.',
        );
        const decision = await this.providers[input.provider].decide(
          {
            taskId,
            step: this.current.step,
            snapshotId: snapshot.id,
            goal: input.goal,
            app: 'TextEdit',
            windowId: snapshot.windowId,
            input: { id: 'document_text', text: input.text },
            candidates,
            history: history.slice(-12),
          },
          signal,
        );
        signal.throwIfAborted();
        if (decision.provider !== input.provider) throw new Error('Unexpected decision provider.');
        const candidate = validateDecision(decision, taskId, snapshot, candidates);
        this.current.decision = decision;
        this.event('decision', candidate.operation + ' → ' + candidate.name, {
          confidence: decision.confidence,
          model: decision.model,
          snapshotId: snapshot.id,
        });
        this.event('target', 'Resolved document target.', {
          targetRef: candidate.targetRef,
          bounds: candidate.bounds,
          coordinateSpace: 'native-screen',
        });
        signal.throwIfAborted();
        this.status('executing', 'Executing one native ' + candidate.operation + ' action.');
        // Once dispatched, allow the native call to return; cancelling a promise cannot undo OS input.
        const result = await this.bridge.execute(candidate, input.text, editor, signal);
        this.event('step', 'Native action returned; checking the observed result.', {
          disposition: result.disposition,
        });
        if (signal.aborted) {
          this.current.snapshot = await this.bridge
            .snapshot(this.current.document)
            .catch(() => this.current.snapshot!);
          signal.throwIfAborted();
        }
        this.status('verifying', 'Reading the document again to verify the action.');
        const after = await this.bridge.snapshot(this.current.document, signal);
        this.current.snapshot = after;
        const afterEditor = documentEditor(after);
        if (!afterEditor) throw new Error('The document editor disappeared after the action.');
        if (afterEditor.value === input.text) {
          this.current.verifiedText = afterEditor.value;
          this.status('completed', 'Verified: the document body matches the supplied text exactly.');
          this.event('result', 'Text-entry test passed.', {
            windowId: after.windowId,
            characters: afterEditor.value.length,
          });
          return;
        }
        if (candidate.operation === 'SET_VALUE')
          throw new Error('Text write was not verified. It will not be repeated automatically.');
        history.push(candidate.operation + ': text remains unchanged.');
        unchanged++;
        if (unchanged >= 2) throw new Error('Stopped after two steps without text-entry progress.');
        if (singleStep) {
          this.status('paused', 'Step complete. Continue with Step or Run.');
          return;
        }
      }
      this.status('blocked', 'Task reached its operation or time limit.');
    } catch (e) {
      this.handleError(e);
    } finally {
      this.current.busy = false;
      this.publish();
    }
  }
}
