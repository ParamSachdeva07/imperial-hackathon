import type { Decision, DesktopDecisionRequest, DesktopObservation, OutcomeCheck } from '../../../../packages/contracts/src/index';
import { checkOutcomes, type Measurement } from './outcome-checks';

type CompletionCheck = { kind: 'confirmed' } | { kind: 'blocked' | 'refresh'; message: string };

export class CompletionVerifier {
  private probe?: {
    context: string; modelVerified: boolean; needsInspection: boolean; attempts: number;
    observationId: string; capturedAt: number; measurements: Measurement[];
  };

  clear(): void { this.probe = undefined; }
  needsEvidence(): boolean { return this.probe?.needsInspection === true; }

  assess(request: DesktopDecisionRequest, decision: Decision, observation: DesktopObservation): CompletionCheck {
    if (request.tree.view !== 'tree') throw new Error('Completion requires an observed app tree.');
    const outcome = request.supervisor?.expectedOutcome;
    const context = JSON.stringify([request.phase.index, observation.context.app, observation.context.windowId,
      outcome?.kind, outcome?.target, outcome?.value, outcome?.checks.map(check => JSON.stringify(check)).sort()]);
    const previous = this.probe?.context === context ? this.probe : undefined;
    const fresh = !!previous && observation.id !== previous.observationId && observation.capturedAt > previous.capturedAt;
    const modelVerified = decision.goalStatus === 'completed' &&
      (decision.goalCompletionProbability === undefined || decision.goalCompletionProbability > 0.5) && observation.snapshots.length > 0 &&
      observation.snapshots.every(s => s.complete) && (!request.supervisor || request.supervisor.status === 'completed');
    const checks: OutcomeCheck[] = [...(outcome?.checks || [])];
    let missingContract: string | undefined;
    if (outcome?.kind === 'text_equals') checks.push({ kind: 'text_equals', target: outcome.target, value: outcome.value });
    if (outcome?.kind === 'media_playing') {
      const identity = outcome.target;
      if (!identity.name && !identity.windowTitle && !identity.windowId && !identity.nativeId)
        missingContract = 'The intended media identity has not been bound. Inspect the requested content.';
      else checks.push({ kind: 'target_present', target: identity, value: '' });
      if (!checks.some(c => c.kind === 'value_advances') ||
        !outcome.checks.some(c => ['target_present', 'state_present'].includes(c.kind)))
        missingContract = 'Playback needs bound active-state and advancing-position checks. Inspect the actual player controls.';
    }
    const checked = checkOutcomes(observation, checks, previous?.measurements || [], fresh);
    const message = missingContract || checked.message || (!modelVerified
      ? 'The current evidence does not confirm all requested work is complete.' : undefined);
    // The supervisor has already reconciled the result, then Jev assesses the
    // current observed state. Static predicates need no second identical model
    // judgment. Temporal predicates still require fresh advancing measurements.
    if (request.supervisor?.status === 'completed' && modelVerified && !message &&
        !checks.some(c => c.kind === 'value_advances')) return { kind: 'confirmed' };
    if (previous?.modelVerified && modelVerified && fresh && !message) return { kind: 'confirmed' };
    if (previous && previous.attempts >= 2 && message)
      return { kind: 'blocked', message };
    this.probe = { context, modelVerified, needsInspection: !!missingContract || checked.needsInspection || !modelVerified,
      observationId: observation.id, capturedAt: observation.capturedAt, measurements: checked.measurements,
      attempts: (previous?.attempts || 0) + 1 };
    return { kind: 'refresh', message: message || 'Reassess the requested result on a fresh observation. Do not repeat completed actions.' };
  }
}
