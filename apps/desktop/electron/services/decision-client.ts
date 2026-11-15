import {
  DecisionRequestSchema,
  DesktopDecisionRequestSchema,
  DecisionSchema,
  TextResolutionRequestSchema,
  TextResolutionSchema,
  SupervisorRequestSchema,
  SupervisorGuidanceSchema,
  PlanRequestSchema,
  PlanStepSchema,
  GroundRequestSchema,
  GroundResultSchema,
  OrchestratorRequestSchema, OrchestratorResultSchema,
  type OrchestratorRequest, type OrchestratorResult,
  type PlanRequest,
  type PlanStep,
  type GroundRequest,
  type GroundResult,
  type SupervisorRequest,
  type SupervisorGuidance,
  type TextResolutionRequest,
  type TextResolution,
  type DecisionRequest,
  type DesktopDecisionRequest,
  type Decision,
  type Health,
} from '../../../../packages/contracts/src/index';

export interface DecisionProvider {
  decide(request: DecisionRequest | DesktopDecisionRequest, signal: AbortSignal): Promise<Decision>;
  resolveText?(request: TextResolutionRequest, signal: AbortSignal): Promise<TextResolution>;
  supervise?(request: SupervisorRequest, signal: AbortSignal): Promise<SupervisorGuidance>;
  plan?(request: PlanRequest, signal: AbortSignal): Promise<PlanStep>;
  ground?(request: GroundRequest, signal: AbortSignal): Promise<GroundResult>;
  orchestrate?(request: OrchestratorRequest, signal: AbortSignal): Promise<OrchestratorResult>;
}

/** A broker failure. `retryable` is false when an identical request would fail again. */
export class BrokerError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
  }
}

/** Model calls send no desktop input, so a transient failure can be retried from the same state. */
export async function withRetry<T>(call: () => Promise<T>, signal: AbortSignal,
  delays: readonly number[] = [500, 2000, 6000], onRetry?: (error: Error, attempt: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      signal.throwIfAborted();
      const retryable = error instanceof BrokerError ? error.retryable
        : error instanceof Error && ['TimeoutError', 'TypeError'].includes(error.name);
      if (!retryable || attempt >= delays.length) throw error;
      onRetry?.(error as Error, attempt + 1);
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delays[attempt]);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
}

export class JevDecisionClient implements DecisionProvider {
  constructor(
    private url: string,
    private token: string,
    private retryDelays: readonly number[] = [500, 2000, 6000],
  ) {}
  private post(route: string, body: unknown, signal: AbortSignal, timeoutMs: number, failure: string): Promise<any> {
    return withRetry(async () => {
      const response = await fetch(this.url + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
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
  async supervise(input: SupervisorRequest, signal: AbortSignal): Promise<SupervisorGuidance> {
    return SupervisorGuidanceSchema.parse(await this.post('/navigation/supervise',
      SupervisorRequestSchema.parse(input), signal, 90_000, 'Supervisor request failed.'));
  }
  async resolveText(input: TextResolutionRequest, signal: AbortSignal): Promise<TextResolution> {
    return TextResolutionSchema.parse(await this.post('/navigation/resolve-text',
      TextResolutionRequestSchema.parse(input), signal, 60_000, 'Text interpretation failed.'));
  }
  async plan(input: PlanRequest, signal: AbortSignal): Promise<PlanStep> {
    return PlanStepSchema.parse(await this.post('/navigation/plan',
      PlanRequestSchema.parse(input), signal, 90_000, 'Planner request failed.'));
  }
  async ground(input: GroundRequest, signal: AbortSignal): Promise<GroundResult> {
    return GroundResultSchema.parse(await this.post('/navigation/ground',
      GroundRequestSchema.parse(input), signal, 60_000, 'Target grounding failed.'));
  }
  async orchestrate(input: OrchestratorRequest, signal: AbortSignal): Promise<OrchestratorResult> {
    return OrchestratorResultSchema.parse(await this.post('/navigation/orchestrate',
      OrchestratorRequestSchema.parse(input), signal, 90_000, 'Orchestration request failed.'));
  }
  async health(): Promise<Health['backend']> {
    try {
      const response = await fetch(this.url + '/health', {
        headers: { Authorization: 'Bearer ' + this.token },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error('Decision broker returned HTTP ' + response.status);
      const data = (await response.json()) as Health['backend'];
      return { available: true, keyConfigured: data.keyConfigured, model: data.model,
        supervisorConfigured: data.supervisorConfigured, supervisorProvider: data.supervisorProvider, supervisorModel: data.supervisorModel,
        orchestratorConfigured: data.orchestratorConfigured, orchestratorProvider: data.orchestratorProvider, orchestratorModel: data.orchestratorModel };
    } catch (e) {
      return { available: false, keyConfigured: false, message: (e as Error).message };
    }
  }
  async decide(input: DecisionRequest | DesktopDecisionRequest, signal: AbortSignal): Promise<Decision> {
    const request =
      'mode' in input ? DesktopDecisionRequestSchema.parse(input) : DecisionRequestSchema.parse(input);
    return DecisionSchema.parse(await this.post('/navigation/decide', request, signal, 60_000,
      'Decision broker rejected the request.'));
  }
}
export class LocalTestPolicy implements DecisionProvider {
  async decide(request: DecisionRequest | DesktopDecisionRequest, signal: AbortSignal): Promise<Decision> {
    signal.throwIfAborted();
    if ('mode' in request)
      throw new Error(
        'Desktop navigation requires Jev. Local policy is only for the TextEdit regression test.',
      );
    const chosen = request.candidates.find((c) => c.operation === 'SET_VALUE');
    return {
      taskId: request.taskId,
      snapshotId: request.snapshotId,
      candidateId: chosen?.id ?? 'BLOCKED',
      confidence: 1,
      provider: 'local',
      model: 'deterministic-test-policy',
    };
  }
}
