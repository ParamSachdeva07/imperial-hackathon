import type { EffectView, PlanOperation } from '../../../../packages/contracts/src/index';
import { atLeast, matchIdentity, type ElementIdentity } from './identity';
import { clip } from './text';

export type Delivery = 'proposed' | 'not_delivered' | 'delivered' | 'uncertain';
export type Outcome = 'unknown' | 'confirmed' | 'refuted';
export type Effect = {
  id: string;
  /** The navigator decision that proposed it, counted across the whole task. */
  step: number;
  operation: PlanOperation;
  args: { text?: string; key?: string; direction?: string };
  target?: ElementIdentity;
  targetLabel: string;
  /** The focused element at dispatch time, for keyboard input. */
  recipient?: ElementIdentity;
  expect: string;
  delivery: Delivery;
  outcome: Outcome;
  readback?: { expected?: string; observed?: string };
  delta: { added: string[]; removed: string[]; scopeChanged: boolean };
  note: string;
  /** What settled the outcome: the navigator citing the screen, or the controller's own observation. */
  settledBy?: 'navigator' | 'readback' | 'postcondition' | 'observed_change';
};

/** Changing what is shown, not what is stored. Their outcome is never an open question. */
export const VIEW_OPERATIONS: ReadonlySet<string> = new Set(['SCROLL', 'SCROLL_TO', 'FOCUS', 'FOCUS_WINDOW', 'OPEN_APP']);
export const WRITE_OPERATIONS: ReadonlySet<string> = new Set(['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE']);

/** Every action a task sent, in order. It calls neither a model nor the desktop. */
export class Ledger {
  effects: Effect[] = [];

  propose(effect: Omit<Effect, 'id' | 'delivery' | 'outcome' | 'delta' | 'note'>): Effect {
    const created: Effect = { ...effect, id: 'fx' + (this.effects.length + 1), delivery: 'proposed', outcome: 'unknown',
      delta: { added: [], removed: [], scopeChanged: false }, note: '' };
    this.effects.push(created);
    return created;
  }

  /** Returns why the verdict was not recorded, if it was not. */
  settle(effectId: string, outcome: 'confirmed' | 'refuted', by: NonNullable<Effect['settledBy']>, cited = 0): string | undefined {
    const effect = this.effects.find(e => e.id === effectId);
    if (!effect) return 'Unknown effect ' + effectId + '.';
    if (effect.delivery === 'proposed' || effect.delivery === 'not_delivered') return 'Effect ' + effectId + ' was never delivered; there is nothing to reconcile.';
    // The controller's own observation outranks a model's opinion of the same action.
    if (by === 'navigator' && effect.settledBy && effect.settledBy !== 'navigator') return;
    if (by === 'navigator' && !cited) return 'Reconciling ' + effectId + ' needs at least one cited element from the current observation.';
    effect.outcome = outcome;
    effect.settledBy = by;
  }

  /** Sent, with an outcome nobody has seen yet. */
  unknown(): Effect[] {
    return this.effects.filter(e => (e.delivery === 'delivered' || e.delivery === 'uncertain') && e.outcome === 'unknown' &&
      !VIEW_OPERATIONS.has(e.operation));
  }
  /** May or may not have reached the application. */
  uncertain(): Effect[] { return this.unknown().filter(e => e.delivery === 'uncertain'); }

  /**
   * The one rule about repeating an action: the same action is not sent again while the earlier
   * one may or may not have arrived, or straight after it was sent and nothing changed. Either
   * way the screen is looked at first.
   */
  retryBlock(step: number, operation: string, args: Effect['args'], target?: ElementIdentity, recipient?: ElementIdentity): Effect | undefined {
    const same = (a?: ElementIdentity, b?: ElementIdentity) => {
      if (!a || !b) return !a && !b;
      const match = matchIdentity(a, b);
      // An unlabeled control can only be recognised by position; treat that as the same control.
      return atLeast(match, 'strong') || (match === 'weak' && !a.label);
    };
    return this.unknown().find(e => e.operation === operation && (e.args.text ?? '') === (args.text ?? '') &&
      (e.args.key ?? '') === (args.key ?? '') && (e.args.direction ?? '') === (args.direction ?? '') &&
      same(e.target, target) && (!!e.target || same(e.recipient, recipient)) &&
      (e.delivery === 'uncertain' || e.step >= step - 1));
  }

  describe(effect: Effect): string {
    return clip(effect.operation + ' ' + (effect.targetLabel || effect.args.key || '') +
      (effect.args.text ? ' ' + JSON.stringify(clip(effect.args.text, 120)) : '') + ': ' +
      (effect.delivery === 'uncertain' ? 'may or may not have been delivered' : 'delivered, no result observed') +
      (effect.note ? '. ' + effect.note : ''), 600);
  }

  /** Open questions first, then the most recent history. */
  view(limit = 16): EffectView[] {
    const pending = this.unknown().slice(-10);
    const rest = this.effects.filter(e => !pending.includes(e) && e.delivery !== 'proposed');
    return [...pending, ...rest.slice(-(limit - pending.length))].sort((a, b) => a.step - b.step).map(e => ({
      id: e.id, operation: e.operation, target: clip(e.targetLabel, 400),
      text: e.args.text === undefined ? undefined : clip(e.args.text, 600), key: e.args.key, direction: e.args.direction,
      delivery: e.delivery, outcome: VIEW_OPERATIONS.has(e.operation) && e.outcome === 'unknown' ? 'view_change' : e.outcome,
      expect: clip(e.expect, 500), readback: e.readback?.observed === undefined ? undefined : clip(e.readback.observed, 600),
      added: e.delta.added, removed: e.delta.removed, scopeChanged: e.delta.scopeChanged, note: clip(e.note, 500),
    }));
  }
}
