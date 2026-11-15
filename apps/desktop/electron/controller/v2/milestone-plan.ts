import type { BranchDecision, NavigationMilestone } from '../../../../../packages/contracts/src/index';
import type { Requirement } from './task-state';

/** The coordinator owns the workflow; the navigator can only evidence its assigned milestone. */
export class MilestonePlan {
  milestones: NavigationMilestone[] = [];
  branches: BranchDecision[] = [];

  define(offered: NavigationMilestone[]): string | undefined {
    if (!offered.length) return this.milestones.length ? undefined : 'Define the task milestones before navigating.';
    const additions = offered.filter(m => !this.milestones.some(existing => existing.id === m.id));
    if (offered.some(m => this.milestones.some(existing => existing.id === m.id && JSON.stringify(existing) !== JSON.stringify(m))))
      return 'This milestone is already defined. Add discovered work without changing an existing obligation or its completion criteria.';
    const seen = new Set(this.milestones.map(m => m.id));
    if (new Set(offered.map(m => m.id)).size !== offered.length) return 'Milestone ids must be unique.';
    for (const milestone of additions) {
      if (seen.has(milestone.id)) return 'Milestone ids must be unique.';
      if (milestone.dependsOn.some(id => !seen.has(id))) return 'Dependencies must refer to earlier milestones.';
      if (milestone.condition && !milestone.dependsOn.length) return 'A conditional milestone needs an earlier evidence-producing dependency.';
      seen.add(milestone.id);
    }
    this.milestones = [...this.milestones, ...additions];
  }

  decide(decisions: BranchDecision[], requirements: Requirement[]): string | undefined {
    const pending = [...this.branches];
    for (const decision of decisions) {
      const milestone = this.milestones.find(m => m.id === decision.milestoneId);
      if (!milestone) return 'Branch decisions must name a milestone from the plan.';
      if (!milestone.condition) {
        // "Run" is redundant for unconditional work, not an invalid task plan. Dependency
        // ordering is still enforced by select(); only skipping would erase an obligation.
        if (decision.disposition === 'run') continue;
        return 'Unconditional milestones cannot be skipped.';
      }
      if (decision.sourceMilestoneIds.some(id => !milestone.dependsOn.includes(id) ||
        !requirements.some(r => r.id === id && r.status === 'evidenced' && r.evidence.length)))
        return 'Branch decisions need completed dependency evidence. A blocked, unverified or unvisited page is not a negative finding.';
      const existing = pending.find(d => d.milestoneId === decision.milestoneId);
      if (existing && existing.disposition !== decision.disposition)
        return 'A resolved branch cannot be reversed after execution. Inspect the existing result instead.';
      if (!existing) pending.push(decision);
    }
    this.branches = pending;
  }

  private resolved(id: string, requirements: Requirement[]): boolean {
    return requirements.some(r => r.id === id && r.status === 'evidenced') ||
      this.branches.some(d => d.milestoneId === id && d.disposition === 'skip');
  }

  select(id: string, requirements: Requirement[]): NavigationMilestone | string {
    const milestone = this.milestones.find(m => m.id === id);
    if (!milestone) return 'Select a milestoneId from the task plan.';
    if (this.resolved(id, requirements)) return 'That milestone is already completed or skipped. Choose unfinished work.';
    if (milestone.dependsOn.some(dep => !this.resolved(dep, requirements))) return 'Complete the prerequisite milestones first.';
    if (milestone.condition && !this.branches.some(d => d.milestoneId === id && d.disposition === 'run'))
      return 'Resolve this condition from dependency evidence before navigating its branch.';
    return milestone;
  }

  complete(requirements: Requirement[]): boolean {
    return this.milestones.length > 0 && this.milestones.every(m => this.resolved(m.id, requirements)) &&
      requirements.some(r => r.status === 'evidenced');
  }

  completeUnverified(requirements: Requirement[]): boolean {
    return this.milestones.length > 0 && requirements.some(r => r.status === 'unverifiable') &&
      this.milestones.every(m => this.resolved(m.id, requirements) ||
        ((!m.condition || this.branches.some(b => b.milestoneId === m.id && b.disposition === 'run')) &&
          requirements.some(r => r.id === m.id && r.status === 'unverifiable')));
  }
}
