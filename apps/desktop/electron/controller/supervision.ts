import {
  SupervisorGuidanceSchema,
  type DesktopDecisionRequest,
  type SupervisorGuidance,
  type SupervisorRequest,
} from '../../../../packages/contracts/src/index';
import type { DecisionProvider } from '../services/decision-client';
import { sameBoundIdentity } from './target-identity';

type Reason = SupervisorRequest['reason'];

/** One planning session per user task. Reviewing never resets the execution ledger. */
export class Supervision {
  guidance: SupervisorGuidance | null = null;
  revision = 0;
  private reviewedAt = -1;
  private pending?: { reason: Reason; issue: string };
  private repeated = new Map<string, number>();

  constructor(private provider: DecisionProvider) {}

  reset(): void {
    this.guidance = null;
    this.revision = 0;
    this.reviewedAt = -1;
    this.pending = undefined;
    this.repeated.clear();
  }

  request(reason: Reason, issue: string): void {
    const priority = (r: Reason) => r === 'uncertain_action' ? 3 : r === 'interruption' ? 2 : r === 'action_result' ? 1 : 0;
    if (!this.pending || priority(reason) >= priority(this.pending.reason))
      this.pending = { reason, issue: issue.slice(0, 4000) };
  }

  track(choice: string): void {
    const count = (this.repeated.get(choice) || 0) + 1;
    this.repeated.set(choice, count);
    if (count === 3) this.request('no_progress', 'The navigator repeatedly selected ' + choice + '. Reassess the subgoal and evidence; repeating input is not recovery.');
  }

  due(step: number, every: number): boolean {
    return !this.guidance || !!this.pending || (this.guidance.status !== 'completed' && step - this.reviewedAt >= every);
  }

  invalidateCompletion(): void {
    if (this.guidance?.status === 'completed') this.guidance = { ...this.guidance, status: 'continue' };
  }

  async review(request: DesktopDecisionRequest, every: number, signal: AbortSignal,
    forced?: Reason, issue = ''): Promise<{ guidance: SupervisorGuidance; reason: Reason; changed: boolean }> {
    if (!this.provider.supervise) throw new Error('This provider does not support LLM supervision. Configure the OpenAI supervisor backend.');
    const reason = forced || this.pending?.reason || (!this.guidance ? 'initial' : 'interval');
    const previous = this.guidance;
    const guidance = SupervisorGuidanceSchema.parse(await this.provider.supervise({
      taskId: request.taskId, snapshotId: request.snapshotId, step: request.step,
      goal: request.overallGoal, observation: request, previous,
      reason, issue: (issue || this.pending?.issue || `Review after at most ${every} Jev decisions.`).slice(0, 4000),
    }, signal));
    signal.throwIfAborted();
    if (guidance.taskId !== request.taskId || guidance.snapshotId !== request.snapshotId)
      throw new Error('Rejected stale supervisor guidance.');
    if (new Set(guidance.inputs.map(i => i.id)).size !== guidance.inputs.length)
      throw new Error('Supervisor returned duplicate input identifiers.');
    if (guidance.status === 'completed' && previous && previous.expectedOutcome.kind !== 'observed_state') {
      const before = previous.expectedOutcome;
      const after = guidance.expectedOutcome;
      if (before.target.name && after.target.name && before.target.name !== after.target.name &&
          !sameBoundIdentity(before.target, after.target)) {
        // A semantic mismatch is a recovery signal, not a fatal protocol error.
        guidance.status = 'continue';
        guidance.memory.push(('The completion target differs from the previous bound target: ' + before.target.name +
          '. Inspect whether this is the same intended object before claiming completion.').slice(0, 1000));
        guidance.memory = guidance.memory.slice(-16);
      }
    }
    const changed = !!previous && previous.subgoal !== guidance.subgoal;
    if (changed) this.revision++;
    this.guidance = guidance;
    this.reviewedAt = request.step - 1;
    this.pending = undefined;
    this.repeated.clear();
    return { guidance, reason, changed };
  }
}
