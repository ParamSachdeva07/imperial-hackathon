import {
  DecisionSchema,
  type ControllerState,
  type DesktopCandidate,
  type DesktopContext,
  type DesktopObservation,
  type DesktopDecisionRequest,
  type SupervisorRequest,
  type TaskStatus,
  type ActionResult,
} from '../../../../packages/contracts/src/index';
import { type WorkspaceBridge } from '../desktop/workspace';
import type { DecisionProvider } from '../services/decision-client';
import { TreeBrowser } from './tree-browser';
import { CompletionVerifier } from './completion-verifier';
import { WriteHistory } from './write-history';
import { exactInputs, executionInputs } from './task-instructions';
import { Supervision } from './supervision';
import { ValueEntries } from './value-entries';
import { desktopCandidates } from './desktop-candidates';
import { decisionPage, fingerprint } from './decision-context';
import { resolveActionText } from './resolve-action-text';
import { NativeError } from '../desktop/native-client';
import { actionResult, readOperations } from './action-result';

export type LoopHost = {
  state: ControllerState;
  status(status: TaskStatus, message: string): void;
  event(
    type: 'observation' | 'decision' | 'target' | 'step' | 'result',
    message: string,
    details?: Record<string, unknown>,
  ): void;
};
export class DesktopLoop {
  private context: DesktopContext = {};
  private history: string[] = [];
  private deadline = 0;
  private performed = new Set<string>();
  private writes = new WriteHistory();
  private valueEntries = new ValueEntries();
  private completion = new CompletionVerifier();
  private inspected = new Map<string, { app: string; name: string; count: number; summary: string }>();
  private inspectionKey(candidate: DesktopCandidate) {
    return JSON.stringify([
      candidate.app,
      candidate.windowId,
      candidate.role,
      candidate.name,
      candidate.description,
    ]);
  }
  private lastTask = '';
  private phase = 0;
  private phaseEvidence: string[] = [];
  private supervisor: Supervision;
  private completionReviewed = false;
  private declinedCompletionStates = new Set<string>();
  private modalIdentity = '';
  private uncertain = new Set<string>();
  private lastActionResult?: ActionResult;
  private verificationState?: string;
  private baselineApps = new Set<string>();
  constructor(
    private bridge: WorkspaceBridge,
    private provider: DecisionProvider,
  ) { this.supervisor = new Supervision(provider); }

  private actionIdentity(candidate: DesktopCandidate, observation?: DesktopObservation): string {
    const target = observation?.snapshots.flatMap(s => s.elements).find(e => e.ref === candidate.targetRef);
    // Use observed identity, not presentation text that TreeBrowser enriches with child previews.
    const identity = target ? [target.role, target.name, target.nativeId, target.path] : [candidate.role, candidate.name];
    return JSON.stringify([candidate.app, candidate.windowId, candidate.operation, identity,
      candidate.key, candidate.inputId, candidate.direction]);
  }

  private observeInterruption(browser: TreeBrowser): void {
    const modal = browser.modal;
    const identity = modal ? JSON.stringify([this.context.app, this.context.windowId,
      modal.role, modal.name, modal.nativeId]) : '';
    if (identity && identity !== this.modalIdentity && this.supervisor.guidance) {
      this.completionReviewed = false;
      this.declinedCompletionStates.clear();
      this.supervisor.invalidateCompletion();
      this.supervisor.request('interruption', 'A blocking dialog appeared. Reassess its observed controls before continuing the original task; preserve unrelated user work.');
    }
    this.modalIdentity = identity;
  }

  private async review(host: LoopHost, request: DesktopDecisionRequest, signal: AbortSignal,
    reason?: SupervisorRequest['reason'], issue = ''): Promise<boolean> {
    host.status('deciding', 'The supervisor is reviewing progress and the next subgoal.');
    const started = Date.now();
    const result = await this.supervisor.review(request, host.state.input!.supervisorEvery, signal, reason, issue);
    host.event('decision', 'Supervisor: ' + result.guidance.subgoal, {
      reason: result.reason, durationMs: Date.now() - started, guidance: result.guidance,
    });
    this.completionReviewed = result.guidance.status === 'completed';
    if (result.changed && result.guidance.status !== 'completed') {
      this.completion.clear();
      this.phase = this.supervisor.revision;
    }
    if (result.guidance.status === 'blocked') {
      host.status('blocked', 'Supervisor: ' + result.guidance.rationale);
      return false;
    }
    return true;
  }

  async advance(host: LoopHost, singleStep: boolean, signal: AbortSignal) {
    const { state } = host,
      input = state.input!,
      taskId = state.taskId!;
    if (this.lastTask !== taskId) {
      this.context = input.app ? { app: input.app } : {};
      this.history = [];
      this.performed.clear();
      this.inspected.clear();
      this.writes.clear();
      this.valueEntries.clear();
      this.completion.clear();
      this.deadline = Date.now() + 20 * 60_000;
      this.lastTask = taskId;
      this.phase = 0;
      this.phaseEvidence = [];
      this.supervisor.reset();
      this.completionReviewed = false;
      this.declinedCompletionStates.clear();
      this.modalIdentity = '';
      this.uncertain.clear();
      this.lastActionResult = undefined;
      this.verificationState = undefined;
      this.baselineApps.clear();
      host.event(
        'observation',
        input.supervisorEnabled
          ? `Supervisor reviews every ${input.supervisorEvery} Jev decisions and on exceptions. Target, text and result checks remain active.`
          : 'Jev selects the next choice; target, text and result validation remain active.',
      );
    }
    let observation: DesktopObservation | undefined;
    let browser: TreeBrowser | undefined;
    let rejected = new Set<string>();
    let page = 0,
      seen = new Set<number>(),
      pageMoves = 0;
    let staleRecoveries = 0;
    while (state.step < input.maxSteps && Date.now() < this.deadline) {
      signal.throwIfAborted();
      if (!observation) {
        host.status('observing', 'Reading applications, windows and the current accessibility tree.');
        observation = await this.bridge.observe(this.context, signal);
        signal.throwIfAborted();
        this.context = observation.context;
        state.observation = observation;
        this.valueEntries.observe(observation);
        browser = new TreeBrowser(observation);
        this.observeInterruption(browser);
        rejected = new Set();
        state.snapshot = observation.snapshots[0] || null;
        page = 0;
        seen = new Set([0]);
        pageMoves = 0;
      }
      const guidance = this.supervisor.guidance;
      const activeInput = { ...input, goal: guidance?.subgoal || input.goal,
        inputs: executionInputs(input, guidance?.inputs) };
      const observedState = fingerprint(observation);
      const candidates = desktopCandidates(observation, activeInput).filter(c =>
        (guidance?.status !== 'completed' || readOperations.has(c.operation)) &&
        !rejected.has(c.id) && !this.uncertain.has(this.actionIdentity(c, observation)) &&
        !this.performed.has(observedState + this.actionIdentity(c, observation)));
      const inspectionKeys = new Map(
        candidates.filter((c) => c.operation === 'INSPECT_REGION').map((c) => [c.id, this.inspectionKey(c)]),
      );
      for (const candidate of candidates) {
        const previous = this.inspected.get(inspectionKeys.get(candidate.id) || '');
        if (previous)
          candidate.description = (
            'Previously inspected ' +
            previous.count +
            ' time(s) since the last desktop action. Observed: ' +
            previous.summary +
            '. Prefer a different unread branch if this did not contain the needed evidence. ' +
            candidate.description
          ).slice(0, 2000);
      }
      const view = browser!.view(candidates);
      const evidenceState = fingerprint(view.observation);
      const request = decisionPage(
        view.observation,
        view.candidates,
        input,
        taskId,
        state.step + 1,
        page,
        seen,
        this.history,
      );
      request.tree = browser!.metadata();
      request.completionNeedsEvidence = (this.completion.needsEvidence() && this.verificationState === evidenceState) ||
        (guidance?.status !== 'completed' && this.declinedCompletionStates.has(evidenceState));
      if (this.declinedCompletionStates.has(evidenceState))
        request.notices.push('The supervisor already reviewed this unchanged evidence and found remaining work. Inspect another relevant scope or perform the remaining supported action before proposing completion again.');
      for (const previous of [...this.inspected.values()]
        .filter((v) => v.app === observation!.context.app)
        .slice(-6)) {
        request.notices.push(
          (
            'Earlier branch read (historical, not fresh completion evidence): ' +
            previous.name +
            ' => ' +
            previous.summary +
            '. Try other unread branches when this did not reveal the requested result.'
          ).slice(0, 1000),
        );
      }
      request.goal = activeInput.goal;
      request.inputs = exactInputs(activeInput);
      const originalInputs = exactInputs(input);
      if (originalInputs.length) request.notices.unshift(
        'Authoritative user inputs (preserve exact text; planning summaries cannot shorten or replace them): ' +
        JSON.stringify(originalInputs).slice(0, 850));
      request.phase = { index: this.phase, count: this.phase + 1 };
      request.supervisor = guidance;
      request.actionResult = this.lastActionResult;
      if (guidance?.status === 'completed')
        request.notices.push('Verification phase: the supervisor found the original task complete. Assess current evidence or inspect it; no further desktop mutations are offered.');
      request.notices = [...this.valueEntries.notices(), ...request.notices].slice(0, 20);
      if (this.uncertain.size) request.notices = [
        'Unresolved dispatched actions must not be repeated, including via equivalent shortcuts: ' + [...this.uncertain].slice(-6).join('; ').slice(0, 850),
        ...request.notices,
      ].slice(0, 20);
      if (input.supervisorEnabled && this.supervisor.due(state.step, input.supervisorEvery)) {
        if (!await this.review(host, request, signal)) return;
        // Rebuild choices so newly supplied inputs are bound to observed controls.
        continue;
      }
      host.event(
        'observation',
        (this.context.app || 'Desktop') +
          ' › ' +
          request.tree.path.map((n) => n.name).join(' › ') +
          (request.page.count > 1
            ? ' · siblings ' + (request.page.index + 1) + '/' + request.page.count
            : '') +
          ' · ' +
          request.candidates.length +
          ' choices.',
      );
      state.step++;
      host.status('deciding', 'Jev is choosing from the observed tree and navigation options.');
      let decision = DecisionSchema.parse(await this.provider.decide(request, signal));
      signal.throwIfAborted();
      if (decision.taskId !== taskId || decision.snapshotId !== observation.id || decision.provider !== 'jev')
        throw new Error('Rejected a stale or mismatched desktop decision.');
      state.decision = decision;
      const selected = request.candidates.find(c => c.id === decision.candidateId);
      host.event('decision', selected ? selected.operation + ' → ' + selected.name : decision.candidateId, {
        confidence: decision.confidence, model: decision.model, goalCompletionProbability: decision.goalCompletionProbability,
      });
      // Binary completion assessment, not an action-confidence gate. Reconcile
      // before ANY choice (including a conflicting mutation) can be dispatched.
      // A rejected assessment on unchanged evidence does not cause review loops.
      const completionProbability = decision.goalCompletionProbability;
      if (completionProbability !== undefined && completionProbability >= 0.5 &&
          !request.completionNeedsEvidence && !this.declinedCompletionStates.has(evidenceState)) {
        if (completionProbability === 0.5 && input.supervisorEnabled) {
          if (!await this.review(host, request, signal, 'completion', 'The completion Noul is exactly undecided. Inspect the original goal and current evidence before more input.')) return;
          this.declinedCompletionStates.add(evidenceState);
          continue;
        }
        if (completionProbability > 0.5 && request.tree.view === 'tree') {
          host.event('result', 'Completion Noul prefers yes; verifying before further desktop input.',
            { goalCompletionProbability: completionProbability, proposedChoice: decision.candidateId });
          decision = { ...decision, candidateId: 'DONE', goalStatus: 'completed' };
          state.decision = decision;
        }
      }
      this.supervisor.track(selected ? this.actionIdentity(selected, observation) : decision.candidateId);

      // Browsing changes the observed branch without sending desktop input.
      const browse = request.candidates.find(
        (c) => c.id === decision.candidateId && ['BROWSE_TREE', 'BROWSE_APPS'].includes(c.operation),
      );
      if (browse || decision.candidateId === 'GO_PARENT' || decision.candidateId === 'GO_ROOT') {
        const scope = browser!.nativeNavigation(decision.candidateId);
        if (scope) {
          this.context = scope;
          observation = undefined;
          this.history.push(
            'Reading ' +
              (decision.candidateId === 'GO_ROOT' ? 'the window top level' : 'the parent scope') +
              '; no desktop input sent.',
          );
          continue;
        }
        if (browse) browser!.navigate(browse);
        else if (decision.candidateId === 'GO_PARENT') browser!.up();
        else browser!.goRoot();
        page = 0;
        seen = new Set([0]);
        this.history.push(
          'Read tree branch: ' +
            browser!
              .metadata()
              .path.map((n) => n.name)
              .join(' > ') +
            '; no desktop input sent.',
        );
        continue;
      }
      if (['NEXT_PAGE', 'PREVIOUS_PAGE'].includes(decision.candidateId)) {
        const next = page + (decision.candidateId === 'NEXT_PAGE' ? 1 : -1);
        if (next < 0 || next >= request.page.count) throw new Error('Invalid sibling page choice.');
        page = next;
        seen.add(page);
        pageMoves++;
        this.history.push(
          'Read more siblings in this tree branch: ' +
            (page + 1) +
            '/' +
            request.page.count +
            '; no desktop input sent.',
        );
        if (pageMoves > request.page.count * 2) {
          if (!input.supervisorEnabled) {
            host.status('blocked', 'Stopped after repeatedly browsing the same siblings without progress.');
            return;
          }
          this.supervisor.request('no_progress', 'Repeated sibling paging without locating a useful control.');
          pageMoves = 0;
        }
        continue;
      }
      const proposedAction = request.candidates.find((c) => c.id === decision.candidateId);
      if (decision.candidateId === 'STOP' || decision.candidateId === 'BLOCKED') {
        if (input.supervisorEnabled) {
          if (!await this.review(host, request, signal, 'blocked', 'Jev could not identify a next step. Assess available capabilities and another observed route.')) return;
          observation = undefined;
          continue;
        }
        host.status('blocked', 'Jev chose to stop: it could not identify a supported next step.');
        return;
      }
      const readOnly = proposedAction && readOperations.has(proposedAction.operation);
      if (decision.candidateId === 'DONE') {
        if (input.supervisorEnabled) {
          if (!this.completionReviewed && !await this.review(host, request, signal, 'completion', 'Jev proposed the subgoal complete. Check the OVERALL goal, intended target, unresolved actions and current evidence. Continue with remaining work if any.')) return;
          request.supervisor = this.supervisor.guidance;
          if (request.supervisor?.status !== 'completed') {
            this.declinedCompletionStates.add(evidenceState);
            this.history.push('Supervisor found remaining work: ' + request.supervisor?.subgoal);
            // Planning sent no desktop input. Reuse the current observation and let
            // Jev request another scope only when the next subgoal needs one.
            rejected = new Set();
            page = 0;
            seen = new Set([0]);
            continue;
          }
          this.completionReviewed = true;
        }
        const check = this.completion.assess(request, decision, observation);
        if (check.kind !== 'confirmed') this.verificationState = evidenceState;
        host.event('result', 'Completion check: ' + (check.kind === 'confirmed' ? 'confirmed by current evidence.' : check.message),
          { goalStatus: decision.goalStatus, verification: check.kind });
        if (check.kind === 'blocked') {
          if (input.supervisorEnabled) {
            this.completionReviewed = false;
            this.supervisor.request('no_progress', check.message);
            this.history.push(check.message);
            this.completion.clear();
            observation = undefined;
            continue;
          }
          host.status('blocked', check.message);
          return;
        }
        if (check.kind === 'refresh') {
          host.status('verifying', 'Re-observing the goal on a fresh tree before accepting completion.');
          observation = await this.bridge.observe(this.context, signal);
          signal.throwIfAborted();
          this.context = observation.context;
          state.observation = observation;
          this.valueEntries.observe(observation);
          state.snapshot = observation.snapshots[0] || null;
          browser = new TreeBrowser(observation);
          this.observeInterruption(browser);
          rejected = new Set();
          page = 0;
          seen = new Set([0]);
          this.history.push(check.message);
          // If verification needs a different scope, expose reads to Jev. A
          // positive Noul must not keep overriding those reads with DONE.
          continue;
        }
        state.observation = observation;
        state.snapshot = observation.snapshots[0] || null;
        const evidence = request.observations
          .flatMap((s) => [s.app + ' / ' + s.title + ' / ' + s.surface, ...s.text])
          .slice(0, 100);
        this.phaseEvidence.push('Phase ' + (this.phase + 1) + ': ' + request.goal, ...evidence);
        state.completion = {
          kind: 'model-assessed',
          summary: input.supervisorEnabled ? 'Supervisor and Jev assessed the goal complete with fresh outcome checks.' : 'Jev assessed the requested goal as complete from the observed UI.',
          evidence: this.phaseEvidence.slice(-300),
        };
        host.status('completed', 'Goal assessed complete from a fresh accessibility tree.');
        host.event('result', state.completion.summary, {
          assessment: 'model-assessed',
          confidence: decision.goalConfidence,
        });
        return;
      }
      const candidate = request.candidates.find((c) => c.id === decision.candidateId);
      if (!candidate) throw new Error('Jev selected an action outside the current tree page.');
      const actionKey = fingerprint(observation) + this.actionIdentity(candidate, observation);
      if (!readOnly && this.performed.has(actionKey)) {
        if (input.supervisorEnabled) {
          rejected.add(candidate.id);
          this.supervisor.request('no_progress', 'A repeated action on unchanged UI was withheld: ' + candidate.operation + ' ' + candidate.name);
          continue;
        }
        host.status(
          'blocked',
          'Stopped a repeated action against an unchanged UI. Inspect the app before retrying.',
        );
        return;
      }
      if (candidate.targetRef)
        host.event('target', 'Resolved accessibility target.', {
          targetRef: candidate.targetRef,
          bounds: candidate.bounds,
          coordinateSpace: 'native-screen',
          app: candidate.app,
          windowId: candidate.windowId,
        });
      const resolvedText = await resolveActionText(
        this.provider,
        host,
        candidate,
        request,
        observation,
        this.history,
        signal,
      );
      if (!resolvedText.resolved) {
        rejected.add(candidate.id);
        if (input.supervisorEnabled) this.supervisor.request('text_needed', 'Exact text was unavailable for ' + candidate.name + '. Supply a named input supported by the user goal.');
        continue;
      }
      const { text } = resolvedText;
      const writeTarget = ['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE'].includes(candidate.operation)
        ? observation.snapshots.flatMap((s) => s.elements).find((e) => e.ref === candidate.targetRef)
        : undefined;
      if (this.writes.alreadyApplied(0, candidate, writeTarget, text)) {
        rejected.add(candidate.id);
        this.history.push(
          'This text insertion is already verified in ' +
            candidate.name +
            '. Do not type it again. Inspect or accept a pending suggestion, or continue to the next field.',
        );
        host.event('result', 'Prevented a duplicate text write to ' + candidate.name + '.');
        continue;
      }
      if (!readOnly) this.completion.clear();
      if (candidate.operation === 'OPEN_APP' && this.bridge.windowInventory && !this.baselineApps.has(candidate.app)) {
        const windows = await this.bridge.windowInventory(candidate.app, signal);
        this.baselineApps.add(candidate.app);
        this.history.push(('Pre-existing windows BEFORE opening/activating ' + candidate.app + ': ' + JSON.stringify(windows) +
          '. These are not newly created by this task. Opening the app is not evidence of creating its content.').slice(0, 1000));
      }
      host.status(
        'executing',
        'Executing ' + candidate.operation + ' in ' + (candidate.name || candidate.app) + '.',
      );
      if (!readOnly) {
        this.completionReviewed = false;
        this.declinedCompletionStates.clear();
        this.supervisor.invalidateCompletion();
        this.performed.add(actionKey);
        this.inspected.clear();
      }
      try {
        this.context = await this.bridge.act(candidate, observation, text, input.allowPhysical, signal);
      } catch (error) {
        const disposition = error instanceof NativeError ? error.disposition as { delivery?: string; retry?: string } : undefined;
        const refreshable = error instanceof NativeError && disposition?.delivery === 'not_delivered' &&
          ((['STALE_REF', 'SNAPSHOT_NOT_FOUND'].includes(error.code) && disposition.retry === 'safe') ||
            (error.code === 'PASTE_PRECONDITION' && disposition.retry === 'inspect' && error.details?.pasteAttempted === false));
        if (refreshable && staleRecoveries++ < 3) {
          this.performed.delete(actionKey);
          this.history.push('Target changed before dispatch; nothing was sent. Read fresh state and choose the next action again.');
          host.event('result', this.history.at(-1)!);
          observation = undefined;
          continue;
        }
        const uncertain = !readOnly && error instanceof NativeError && disposition?.delivery !== 'not_delivered';
        if (uncertain && input.supervisorEnabled) {
          this.uncertain.add(this.actionIdentity(candidate, observation));
          const message = `Uncertain ${candidate.operation} on ${candidate.name}: ${error.message}. Do not repeat it. Inspect the new app state before continuing.`;
          this.history.push(message.slice(0, 1000));
          host.event('result', message, { delivery: disposition?.delivery || 'unknown', replayed: false });
          this.supervisor.request('uncertain_action', message);
          // Clear the old branch/window binding: creation can replace either of them.
          this.context = { app: candidate.app, surface: 'window' };
          observation = undefined;
          continue;
        }
        state.observation = await this.bridge.observe(this.context).catch(() => observation!);
        state.snapshot = state.observation.snapshots[0] || null;
        throw error;
      }
      const report = this.bridge.takeActionReport?.();
      staleRecoveries = 0;
      if (report?.verification === 'unverified' && (report.nativeError || report.delivery === 'uncertain')) {
        this.uncertain.add(this.actionIdentity(candidate, observation));
        const issue = `The ${candidate.operation} on ${candidate.name} was dispatched, but its outcome is unknown. Do not repeat it. Inspect fresh app state and continue only from evidence.`;
        this.history.push(issue);
        if (input.supervisorEnabled) this.supervisor.request('uncertain_action', issue);
        this.context = { app: candidate.app, surface: 'window' };
      }
      if (report) {
        this.writes.record(0, candidate, writeTarget, text, report.observedValue);
        host.event(
          'result',
          report.verification === 'reconciled'
            ? 'Verified the requested change after a native error. Input was not repeated.'
            : report.verification === 'already_satisfied'
              ? 'The field already contains the requested text. No text inserted.'
              : report.verification === 'verified'
                ? candidate.operation === 'FOCUS_AND_PASTE'
                  ? 'Verified the full field after pasting once.'
                  : ['SET_VALUE', 'TYPE'].includes(candidate.operation)
                    ? 'Verified the text value. Checking whether the requested effect also occurred.'
                    : 'Verified the control postcondition.'
                : 'Input dispatched. Checking the application result next.',
          { action: report },
        );
      }
      if (!readOnly) this.valueEntries.record(candidate, observation, report);
      host.status('verifying', 'Reading the desktop again after the action.');
      const after = await this.bridge.observe(this.context, signal.aborted ? undefined : signal);
      this.valueEntries.observe(after);
      state.observation = after;
      state.snapshot = after.snapshots[0] || null;
      this.context = after.context;
      if (!readOnly) {
        this.lastActionResult = actionResult(candidate, observation, after, text, report);
        host.event('result', 'Observed the action result; checking remaining work before another mutation.',
          { actionResult: this.lastActionResult });
        // The next batched Noul/choice reads this receipt. Review only at a
        // completion/subgoal boundary, interval or exception. Legacy providers
        // without a Noul retain the conservative per-action checkpoint.
        if (input.supervisorEnabled && decision.goalCompletionProbability === undefined &&
            !['FOCUS', 'FOCUS_WINDOW'].includes(candidate.operation))
          this.supervisor.request('action_result', 'Reconcile the last action against its before/after evidence. Was the requested effect achieved, does it need read-only verification, or what distinct work remains? Do not repeat a creation/submission merely to verify it.');
      }
      const changed = fingerprint(after) !== fingerprint(observation);
      if (!changed && !readOnly && input.supervisorEnabled)
        this.supervisor.request('no_progress', candidate.operation + ' on ' + candidate.name +
          ' produced no observable change. Inspect the intended effect or choose another supported approach; do not replay it.');
      const observedResult = after.snapshots
        .flatMap((s) => [
          'Window ' + JSON.stringify(s.windowTitle),
          ...(s.text || []).filter((line) => line.includes('statictext')).slice(0, 5),
          ...s.elements
            .filter((e) => e.value)
            .slice(0, 3)
            .map((e) => e.role + ' ' + e.name + ' = ' + e.value.slice(0, 180)),
        ])
        .join('; ')
        .slice(0, 500);
      const inspectionKey = inspectionKeys.get(candidate.id);
      if (inspectionKey)
        this.inspected.set(inspectionKey, {
          app: candidate.app,
          name: candidate.name,
          count: (this.inspected.get(inspectionKey)?.count || 0) + 1,
          summary: observedResult || 'No result labels or field values in this chunk.',
        });
      this.history.push(
        (
          candidate.app +
          ': ' +
          candidate.operation +
          ' ' +
          candidate.name +
          (text !== undefined ? ' with ' + JSON.stringify(text) : '') +
          ': ' +
          (changed ? 'UI changed.' : 'UI appears unchanged; do not repeat this action.') +
          ' Observed: ' +
          observedResult
        ).slice(0, 1000),
      );
      host.event('step', this.history.at(-1)!);
      signal.throwIfAborted();
      if (singleStep && !readOnly) {
        host.status('paused', 'One desktop action finished. Continue with Step or Run.');
        return;
      }
      observation = after;
      browser = new TreeBrowser(after);
      this.observeInterruption(browser);
      rejected = new Set();
      page = 0;
      seen = new Set([0]);
      pageMoves = 0;
    }
    host.status('blocked', 'Task reached its decision or time limit.');
  }
}
