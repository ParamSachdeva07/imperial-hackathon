import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopCandidate, Element } from '../../../../packages/contracts/src/index';
import { NativeError } from './native-client';

export type NativeRunner = (args: string[], input?: string, signal?: AbortSignal) => Promise<any>;
export type ActionReport = {
  operation: string;
  target: string;
  delivery: string;
  verification: 'verified' | 'unverified' | 'already_satisfied' | 'reconciled';
  expectedValue?: string;
  observedValue?: string;
  clipboard?: string;
  nativeError?: { code: string; message: string; disposition?: unknown; details?: Record<string, unknown> };
};

export function nativeErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof NativeError)) return;
  return { code: error.code, message: error.message, disposition: error.disposition, details: error.details };
}

function deliveryOf(result: any): string {
  return result?.disposition?.delivery || 'unknown';
}

export async function readValue(run: NativeRunner, ref: string, signal?: AbortSignal): Promise<string> {
  const result = await run(['get', ref, '--property', 'value'], undefined, signal);
  const value = typeof result === 'string' ? result : result?.value;
  if (typeof value !== 'string') throw new Error('The field does not expose a complete readable value.');
  return value;
}

function expectedValue(
  candidate: DesktopCandidate,
  before: Element,
  text: string | undefined,
  result: any,
): string | undefined {
  if (candidate.operation === 'SET_VALUE') return text;
  if (candidate.operation !== 'TYPE') return;
  // The native adapter computes insertion from the actual UTF-16 selection.
  if (typeof result?.details?.expected_value === 'string') return result.details.expected_value;
  if (before.value === '') return text;
}

function statePostcondition(operation: string): { state: string; present: boolean } | undefined {
  switch (operation) {
    case 'CHECK':
      return { state: 'checked', present: true };
    case 'UNCHECK':
      return { state: 'checked', present: false };
    case 'EXPAND':
      return { state: 'expanded', present: true };
    case 'COLLAPSE':
      return { state: 'expanded', present: false };
    case 'FOCUS':
      return { state: 'focused', present: true };
  }
}

export class ActionVerifier {
  constructor(
    private run: NativeRunner,
    private settleMs = 1500,
  ) {}

  async execute(
    candidate: DesktopCandidate,
    before: Element,
    text: string | undefined,
    args: string[],
    signal: AbortSignal,
  ): Promise<{ result: any; report: ActionReport }> {
    const writesText = ['SET_VALUE', 'TYPE'].includes(candidate.operation);
    const report: ActionReport = {
      operation: candidate.operation,
      target: candidate.name,
      delivery: 'unknown',
      verification: 'unverified',
    };
    if (writesText) {
      if (text === undefined) throw new Error('Missing text input.');
      const current = await readValue(this.run, before.ref, signal);
      if (current !== before.value)
        throw new Error('Text target changed since observation. Stopped before overwriting a user edit.');
      if (candidate.operation === 'SET_VALUE' && current === text) {
        return {
          result: {},
          report: {
            ...report,
            delivery: 'not_delivered',
            verification: 'already_satisfied',
            expectedValue: text,
            observedValue: current,
          },
        };
      }
    }

    let result: any;
    let failure: NativeError | undefined;
    signal.throwIfAborted();
    // Dispatch once. Cancelling after delivery cannot justify replaying the input.
    try {
      result = await this.run(args, writesText ? text : undefined);
    } catch (error) {
      const delivery = error instanceof NativeError ? deliveryOf(error) : 'unknown';
      const canReconcile =
        error instanceof NativeError &&
        ['ACTION_FAILED', 'TIMEOUT', 'APP_UNRESPONSIVE'].includes(error.code) &&
        delivery !== 'not_delivered';
      if (!canReconcile) throw error;
      failure = error as NativeError;
      result = failure.details?.after_action || {};
      report.nativeError = {
        code: failure.code,
        message: failure.message,
        disposition: failure.disposition,
        details: failure.details,
      };
    }
    report.delivery = failure ? deliveryOf(failure) : deliveryOf(result);
    report.expectedValue = expectedValue(candidate, before, text, result);
    const expectedState = statePostcondition(candidate.operation);
    const requiresReadback = writesText || (!!failure && !!expectedState);
    if (!requiresReadback) {
      // A press can replace its window or open another surface. Reading the old
      // target cannot establish that outcome. Preserve ambiguous delivery for a
      // fresh workspace observation and semantic reconciliation; never replay it.
      signal.throwIfAborted();
      report.verification = !failure && report.delivery === 'delivered_verified' ? 'verified' : 'unverified';
      return { result, report };
    }
    if (writesText && report.expectedValue === undefined) {
      throw (
        failure ||
        new NativeError(
          'UNVERIFIED_ACTION',
          'The insertion position could not be verified. Input may have landed; it will not be repeated.',
          result?.disposition,
          { after_action: result },
        )
      );
    }

    const deadline = Date.now() + this.settleMs;
    let matched = false;
    let readError: unknown;
    do {
      signal.throwIfAborted();
      try {
        if (writesText) {
          report.observedValue = await readValue(this.run, before.ref, signal);
          matched = report.observedValue === report.expectedValue;
        } else {
          const value = await this.run(['get', before.ref, '--property', 'states'], undefined, signal);
          const states = Array.isArray(value) ? value : value?.states || value?.value;
          matched = Array.isArray(states) && states.includes(expectedState!.state) === expectedState!.present;
        }
        readError = undefined;
      } catch (error) {
        readError = error;
        // A different or disappeared element is not proof of this postcondition.
        if (!(error instanceof NativeError) || !['TIMEOUT', 'APP_UNRESPONSIVE'].includes(error.code)) break;
      }
      if (matched) break;
      if (Date.now() < deadline) await delay(Math.min(75, deadline - Date.now()), undefined, { signal });
    } while (Date.now() < deadline);

    if (!matched) {
      const details = {
        ...failure?.details,
        reconciliation: {
          expectedValue: report.expectedValue,
          observedValue: report.observedValue,
          readError: readError instanceof Error ? readError.message : undefined,
          outcome: 'unverified',
          replayed: false,
        },
      };
      throw new NativeError(
        failure?.code || 'UNVERIFIED_ACTION',
        'The action was sent, but its requested effect could not be verified. Input was not repeated.',
        failure?.disposition || result?.disposition,
        details,
      );
    }
    report.verification = failure ? 'reconciled' : 'verified';
    return { result, report };
  }
}
