import type { DesktopContext, DesktopObservation, OrchestratorRequest, NavigationCompletionProposal } from '../../../../../packages/contracts/src/index';
import { VIEW_OPERATIONS, type Effect, type TaskState } from './task-state';
import { clip } from './text';

type Ledger = ReturnType<TaskState['toJSON']>;
export const isUnresolved = (effect: Effect) => ['delivered', 'uncertain'].includes(effect.delivery) &&
  effect.outcome === 'unknown' && !VIEW_OPERATIONS.has(effect.operation);

/** Keep unresolved work before recent history. The full ledger stays local across sessions. */
export function handoffEffects(effects: Effect[], limit = 16): Effect[] {
  const pending = effects.filter(isUnresolved).slice(-limit);
  const recent = effects.filter(e => !isUnresolved(e) && e.delivery !== 'proposed');
  const remaining = limit - pending.length;
  return [...pending, ...(remaining ? recent.slice(-remaining) : [])].sort((a, b) => a.step - b.step);
}

/** Derived from executor state, never from an LLM's prose claim of success. */
export function sessionHandoff(input: {
  outcome: string; reason: string; context: DesktopContext; observation?: DesktopObservation | null;
  ledger?: Ledger; issues: string[]; attemptedScopes: Iterable<string>;
  milestoneId?: string;
  completionProposal?: NavigationCompletionProposal;
}): NonNullable<OrchestratorRequest['handoff']> {
  const requirements = input.ledger?.requirements ?? [];
  const unresolved = (input.ledger?.effects ?? []).filter(isUnresolved);
  const verified = requirements.length > 0 && requirements.every(r => r.status === 'evidenced');
  const unverified = input.outcome === 'completed_unverified' && requirements.length > 0 &&
    requirements.every(r => r.status === 'evidenced' || r.status === 'unverifiable');
  return {
    outcome: input.outcome, reason: clip(input.reason, 1500),
    milestoneId: input.milestoneId || '',
    ...(input.completionProposal ? { completionProposal: input.completionProposal } : {}),
    app: input.context.app || '', windowId: input.context.windowId || '',
    windowTitle: clip(input.observation?.snapshots[0]?.windowTitle || '', 1000),
    surface: input.context.surface || input.context.driver || 'window',
    scope: (input.context.scopePath || []).slice(-50).map(p => clip(p.name, 300)),
    observationId: input.observation?.id || '',
    completedRequirements: requirements.filter(r => r.status === 'evidenced').map(r => r.id),
    remainingRequirements: requirements.filter(r => r.status !== 'evidenced').map(r => r.id),
    completion: verified ? 'verified' : unverified ? 'unverified' : 'incomplete',
    unresolvedEffects: unresolved.slice(-16).map(e => e.id), unresolvedEffectCount: unresolved.length,
    issues: input.issues.slice(-8).map(issue => clip(issue, 1000)),
    attemptedScopes: [...input.attemptedScopes].slice(-20).map(scope => clip(scope, 300)),
    next: verified ? 'verify_completion' : unverified ? 'inspect_or_report_unverified' :
      unresolved.length ? 'inspect_unresolved_effects' : 'continue_remaining_work',
  };
}
