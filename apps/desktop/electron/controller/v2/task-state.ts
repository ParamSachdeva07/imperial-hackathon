import type { PlanOperation } from '../../../../../packages/contracts/src/index';
import { atLeast, matchIdentity, type ElementIdentity } from './identity';

export type CheckKind = 'target_present' | 'text_equals' | 'state_present' | 'state_absent' | 'value_advances';
export type BoundCheck = { kind: CheckKind; target: ElementIdentity; value: string };
export type EvidenceRef = { observationId: string; row: string };
export type RequirementStatus = 'open' | 'evidenced' | 'refuted' | 'unverifiable';
/** text_entry: the whole obligation is that given text ends up in a field or document. */
export type RequirementKind = 'outcome' | 'text_entry';
export type Requirement = {
  id: string;
  text: string;
  irreversible: boolean;
  kind: RequirementKind;
  checks: BoundCheck[];
  status: RequirementStatus;
  evidence: EvidenceRef[];
};
export type Risk = 'read' | 'reversible' | 'irreversible';
export type Delivery = 'proposed' | 'not_delivered' | 'delivered' | 'uncertain';
export type Outcome = 'unknown' | 'confirmed' | 'refuted';
export type Effect = {
  id: string;
  step: number;
  requirementId: string;
  operation: PlanOperation;
  args: { text?: string; key?: string; direction?: string };
  target?: ElementIdentity;
  targetLabel: string;
  /** The focused element at dispatch time, for keyboard input. */
  recipient?: ElementIdentity;
  risk: Risk;
  expect: string;
  delivery: Delivery;
  outcome: Outcome;
  readback?: { expected?: string; observed?: string };
  delta: { added: string[]; removed: string[]; scopeChanged: boolean };
  note: string;
  reconciledBy?: { observationId: string; rows: string[]; source: 'planner' | 'readback' | 'postcondition' };
};
export type CitedRow = { row: string; text: string; identity?: ElementIdentity };

/** Changing what is shown, not what is stored. Repeating these needs no reconciliation. */
export const VIEW_OPERATIONS: ReadonlySet<string> = new Set(['SCROLL', 'SCROLL_TO', 'FOCUS', 'FOCUS_WINDOW', 'OPEN_APP']);
export const WRITE_OPERATIONS: ReadonlySet<string> = new Set(['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE']);

type StateEvent = { at: number; kind: string; detail: Record<string, unknown> };

/**
 * The single record of what the task needs and what was attempted. It calls neither a
 * model nor the desktop, so every rule here can be tested without either.
 */
export class TaskState {
  requirements: Requirement[] = [];
  effects: Effect[] = [];
  answers: { question: string; answer: string }[] = [];
  log: StateEvent[] = [];
  private declared = false;
  private reworded = new Set<string>();

  constructor(readonly taskId: string, readonly goal: string, readonly literals: string[] = []) {}

  private record(kind: string, detail: Record<string, unknown>) {
    this.log.push({ at: Date.now(), kind, detail });
  }

  /**
   * Requirements are stated once. More can be added; none is deleted, and none is reworded: if
   * the text could change after the evidence was accepted, "evidenced" would stop meaning anything.
   */
  declare(declarations: { id: string; text: string; irreversible: boolean; kind?: RequirementKind }[]): string[] {
    const issues: string[] = [];
    const seen = new Set<string>();
    for (const declaration of declarations) {
      if (seen.has(declaration.id)) { issues.push('Duplicate requirement id ' + declaration.id + ' was ignored.'); continue; }
      seen.add(declaration.id);
      const existing = this.requirements.find(r => r.id === declaration.id);
      if (!existing) {
        if (this.requirements.length >= 12) { issues.push('At most 12 requirements are kept.'); continue; }
        // Only the first statement, read from the user's goal, can authorise an irreversible effect.
        const irreversible = declaration.irreversible && !this.declared;
        if (declaration.irreversible && this.declared)
          issues.push('Requirement ' + declaration.id + ' was added later, so it cannot authorise an irreversible action.');
        const kind = declaration.kind ?? 'outcome';
        this.requirements.push({ id: declaration.id, text: declaration.text, irreversible, kind, checks: [], status: 'open', evidence: [] });
        this.record(this.declared ? 'requirement_added' : 'requirement_declared', { id: declaration.id, text: declaration.text, irreversible, kind });
      } else if (existing.text !== declaration.text && !this.reworded.has(existing.id)) {
        this.reworded.add(existing.id);
        this.record('requirement_rewording_ignored', { id: existing.id, kept: existing.text, offered: declaration.text });
      }
    }
    if (this.requirements.length) this.declared = true;
    return issues;
  }

  requirement(id: string): Requirement | undefined {
    return this.requirements.find(r => r.id === id);
  }

  private sameAction(effect: Effect, operation: string, args: Effect['args'], target?: ElementIdentity, recipient?: ElementIdentity): boolean {
    if (effect.operation !== operation || (effect.args.text ?? '') !== (args.text ?? '') ||
        (effect.args.key ?? '') !== (args.key ?? '') || (effect.args.direction ?? '') !== (args.direction ?? '')) return false;
    const same = (a?: ElementIdentity, b?: ElementIdentity) => {
      if (!a || !b) return !a && !b;
      const match = matchIdentity(a, b);
      // An unlabeled control can only be recognised by position; treat that as the same control.
      return atLeast(match, 'strong') || (match === 'weak' && !a.label);
    };
    return same(effect.target, target) && (!!effect.target || same(effect.recipient, recipient));
  }

  /** The earlier attempt that must be reconciled before this action may be sent again. */
  retryBlock(operation: string, args: Effect['args'], target?: ElementIdentity, recipient?: ElementIdentity): Effect | undefined {
    if (VIEW_OPERATIONS.has(operation)) return;
    return this.effects.find(effect => this.sameAction(effect, operation, args, target, recipient) &&
      (effect.delivery === 'uncertain' || effect.delivery === 'delivered') && effect.outcome === 'unknown');
  }

  pendingRequirement(requirementId: string): Effect | undefined {
    return this.unreconciled().find(effect => effect.requirementId === requirementId);
  }

  /**
   * An identical action that already succeeded. Reconciling it as confirmed ends the uncertainty;
   * a further invocation must be intentionally selected for the current state using repeat=true.
   */
  confirmedTwin(operation: string, args: Effect['args'], target?: ElementIdentity, recipient?: ElementIdentity): Effect | undefined {
    if (VIEW_OPERATIONS.has(operation)) return;
    return this.effects.find(effect => this.sameAction(effect, operation, args, target, recipient) &&
      (effect.delivery === 'delivered' || effect.delivery === 'uncertain') && effect.outcome === 'confirmed');
  }

  propose(effect: Omit<Effect, 'id' | 'delivery' | 'outcome' | 'delta' | 'note'>): Effect {
    const created: Effect = { ...effect, id: 'fx' + (this.effects.length + 1), delivery: 'proposed', outcome: 'unknown',
      delta: { added: [], removed: [], scopeChanged: false }, note: '' };
    this.effects.push(created);
    this.record('effect_proposed', { id: created.id, operation: created.operation, target: created.targetLabel, risk: created.risk });
    return created;
  }

  delivered(effect: Effect, update: Pick<Effect, 'delivery'> & Partial<Pick<Effect, 'readback' | 'delta' | 'note' | 'recipient'>>) {
    Object.assign(effect, update);
    // New delivered work supersedes an earlier refuted attempt at the same requirement.
    const requirement = this.requirement(effect.requirementId);
    if (requirement?.status === 'refuted' && effect.delivery !== 'not_delivered') requirement.status = 'open';
    this.record('effect_dispatched', { id: effect.id, delivery: effect.delivery, note: effect.note });
  }

  /** An outcome is set only with a cited observation, or by the executor's own readback. */
  reconcile(effectId: string, outcome: 'confirmed' | 'refuted', observationId: string, rows: string[],
    source: 'planner' | 'readback' | 'postcondition' = 'planner'): string | undefined {
    const effect = this.effects.find(e => e.id === effectId);
    if (!effect) return 'Unknown effect ' + effectId + '.';
    if (effect.delivery === 'proposed' || effect.delivery === 'not_delivered') return 'Effect ' + effectId + ' was never delivered; there is nothing to reconcile.';
    // A model repeating a successful verdict must not erase the executor's stronger readback
    // proof. Otherwise a correctly filled text field suddenly stops counting as evidence.
    if (effect.outcome === outcome && source === 'planner' && effect.reconciledBy && effect.reconciledBy.source !== 'planner') return;
    // A quiet or partial observation is not evidence that an action failed. In particular, a
    // slow response or a result outside this scope must not silently authorize another mutation.
    if (source === 'planner' && !rows.length)
      return 'Reconciling ' + effectId + ' needs at least one cited element from the current observation.';
    // Either outcome ends the uncertainty, so the action no longer withholds a retry.
    effect.outcome = outcome;
    effect.reconciledBy = { observationId, rows, source };
    this.record('effect_reconciled', { id: effectId, outcome, source, rows });
    return;
  }

  /**
   * Evidence must show the result itself. A control the task wrote into as a means to
   * something else (a font-size box) holds the value it was given whether or not the
   * application applied it, so it is not accepted.
   */
  setStatus(requirementId: string, status: 'open' | 'evidenced' | 'refuted', observationId: string,
    cited: CitedRow[], checks: BoundCheck[] = [], checksPass = true): string | undefined {
    const requirement = this.requirement(requirementId);
    if (!requirement) return 'Unknown requirement ' + requirementId + '.';
    if (status !== 'evidenced') {
      if (requirement.status !== status) this.record('requirement_status', { id: requirementId, status });
      requirement.status = status;
      if (status === 'open') requirement.evidence = [];
      return;
    }
    const delivered = this.effects.filter(e => e.delivery === 'delivered' || e.delivery === 'uncertain');
    const worked = delivered.some(e => e.requirementId === requirementId && !VIEW_OPERATIONS.has(e.operation));
    // A control the task typed into shows the task's own input. Whether that input is also the
    // result depends on what the requirement means, which code cannot judge. So the planner says
    // which kind each requirement is when it first states it, before anything has been done, and
    // that cannot change. A typed field then counts only when all of this holds:
    //   - the requirement was declared text_entry;
    //   - the text was read back from the field and matched exactly;
    //   - nothing else had to be done for that requirement afterwards, on any other control.
    // An address bar, a search box or a size field fails the first test or the last.
    const writes = delivered.filter(e => WRITE_OPERATIONS.has(e.operation) && e.target);
    const isResult = (e: Effect) => requirement.kind === 'text_entry' && e.requirementId === requirementId &&
      e.outcome === 'confirmed' && e.reconciledBy?.source === 'readback' &&
      !delivered.some(later => later.requirementId === requirementId && later.step > e.step && !VIEW_OPERATIONS.has(later.operation) &&
        !(later.target && atLeast(matchIdentity(later.target, e.target!), 'strong')));
    // The latest write to a control decides: an earlier draft of the same field proves nothing.
    const instruments = writes.filter(e => !isResult(e) && !writes.some(other => other !== e && isResult(other) &&
      atLeast(matchIdentity(other.target!, e.target!), 'strong')));
    const echo = (identity?: ElementIdentity) => !!identity && (
      instruments.some(e => atLeast(matchIdentity(e.target!, identity), 'strong')) ||
      // An entry in the window or application list says nothing about work done inside it.
      // (The window's own node in the tree carries the document or page title and is accepted.)
      (worked && (identity.role === 'os-window' || identity.role === 'os-application')));
    const independent = cited.filter(row => !echo(row.identity));
    const independentChecks = checks.filter(check => !echo(check.target));
    if (!cited.length && !checks.length) return 'Requirement ' + requirementId + ' needs cited elements or a check to be evidenced.';
    if (!independent.length && !independentChecks.length)
      return 'Requirement ' + requirementId + ' is supported only by a field this task typed into or by the window list. A field shows ' +
        'what was typed, not what happened next. Do what the requirement still needs (opening, searching, submitting, applying, sending) ' +
        'and cite what changed: a title, heading, row, state or value elsewhere. A typed field counts only for a requirement declared ' +
        'text_entry, after its text was read back and with nothing further done for it.';
    checks = independentChecks;
    if (!checksPass) return 'A check for requirement ' + requirementId + ' does not hold in the current observation.';
    requirement.status = 'evidenced';
    requirement.evidence = independent.map(row => ({ observationId, row: row.text }));
    if (checks.length) requirement.checks = checks;
    this.record('requirement_status', { id: requirementId, status, rows: independent.map(r => r.row), checks: checks.length });
    return;
  }

  unreconciled(): Effect[] {
    return this.effects.filter(e => (e.delivery === 'delivered' || e.delivery === 'uncertain') && e.outcome === 'unknown' &&
      !VIEW_OPERATIONS.has(e.operation));
  }
  private latest(requirement: Requirement): Effect | undefined {
    // Opening an application or scrolling is not work on a requirement.
    return [...this.effects].reverse().find(e => e.requirementId === requirement.id && !VIEW_OPERATIONS.has(e.operation) &&
      (e.delivery === 'delivered' || e.delivery === 'uncertain'));
  }
  /** Work known not to have taken effect, with nothing delivered since: planning must continue. */
  hasRefutedWork(): boolean {
    return this.requirements.some(r => r.status !== 'evidenced' &&
      (r.status === 'refuted' || this.latest(r)?.outcome === 'refuted'));
  }
  private served(requirement: Requirement): boolean {
    const latest = this.latest(requirement);
    return !!latest && latest.outcome !== 'refuted';
  }
  allEvidenced(): boolean {
    return this.requirements.length > 0 && this.requirements.every(r => r.status === 'evidenced');
  }
  /** Every unevidenced requirement already has delivered work: only checking remains. */
  verificationReady(): boolean {
    const pending = this.requirements.filter(r => r.status !== 'evidenced');
    return this.requirements.length > 0 && pending.length > 0 && !this.hasRefutedWork() && pending.every(r => this.served(r));
  }
  /** The bounded exit: delivered work whose result the application does not expose. */
  markUnverifiable(reason: string, requirementId?: string): Requirement[] {
    const changed = this.requirements.filter(r => r.status === 'open' && this.served(r) &&
      (!requirementId || r.id === requirementId));
    for (const requirement of changed) requirement.status = 'unverifiable';
    if (changed.length) this.record('requirements_unverifiable', { ids: changed.map(r => r.id), reason });
    return changed;
  }

  toJSON() {
    return { taskId: this.taskId, goal: this.goal, literals: this.literals, requirements: this.requirements,
      effects: this.effects, answers: this.answers, declared: this.declared, log: this.log };
  }
  static fromJSON(data: ReturnType<TaskState['toJSON']>): TaskState {
    const state = new TaskState(data.taskId, data.goal, data.literals);
    Object.assign(state, { requirements: data.requirements, effects: data.effects, answers: data.answers, log: data.log });
    state.declared = data.declared;
    return state;
  }
}
