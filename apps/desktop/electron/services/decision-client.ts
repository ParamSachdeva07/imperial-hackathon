import type { Health, OrchestratorRequest, OrchestratorResult, PlanRequest, PlanStep } from '../../../../packages/contracts/src/index';

/** The two model calls the controller makes. Neither sends anything to the desktop. */
export interface DecisionProvider {
  plan(request: PlanRequest, signal: AbortSignal): Promise<PlanStep>;
  orchestrate(request: OrchestratorRequest, signal: AbortSignal): Promise<OrchestratorResult>;
}

/** A broker failure. `retryable` is false when an identical request would fail again. */
export class BrokerError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
  }
}

/** Model calls send no desktop input, so a transient failure can be retried from the same state. */
export async function withRetry<T>(call: () => Promise<T>, signal: AbortSignal,
  delays: readonly number[] = [500, 2000, 6000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof BrokerError && error.retryable) || attempt >= delays.length) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delays[attempt]);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
}

export class DecisionClient implements DecisionProvider {
  constructor(private url: string, private token: string, private retryDelays: readonly number[] = [500, 2000, 6000]) {}

  private post(route: string, body: unknown, signal: AbortSignal, timeoutMs: number, failure: string): Promise<any> {
    return withRetry(async () => {
      let response: Response;
      try {
        response = await fetch(this.url + route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error) {
        signal.throwIfAborted();
        // The broker did not answer in time or could not be reached. Nothing was decided, so asking again is safe.
        throw new BrokerError(failure + ' ' + (error as Error).message, true);
      }
      const data = (await response.json().catch(() => ({}))) as any;
      if (!response.ok) {
        // The broker marks provider failures an identical request would repeat
        // (bad key, oversized or malformed question). Everything else is transient.
        const marked = response.headers.get('X-Retryable');
        const retryable = marked ? marked === '1' : response.status === 429 || response.status >= 500 && response.status !== 503;
        throw new BrokerError(typeof data.detail === 'string' ? data.detail : failure, retryable, response.status);
      }
      return data;
    }, signal, this.retryDelays);
  }
  plan(input: PlanRequest, signal: AbortSignal): Promise<PlanStep> {
    return this.post('/navigation/plan', input, signal, 30_000, 'Navigator request failed.');
  }
  orchestrate(input: OrchestratorRequest, signal: AbortSignal): Promise<OrchestratorResult> {
    return this.post('/navigation/orchestrate', input, signal, 30_000, 'Orchestration request failed.');
  }
  async health(): Promise<Health['backend']> {
    try {
      const response = await fetch(this.url + '/health', { headers: { Authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('Decision broker returned HTTP ' + response.status);
      return { available: true, ...((await response.json()) as Omit<Health['backend'], 'available'>) };
    } catch (e) {
      return { available: false, message: (e as Error).message };
    }
  }
}
