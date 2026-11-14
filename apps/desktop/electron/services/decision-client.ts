import {
  DecisionRequestSchema,
  DesktopDecisionRequestSchema,
  DecisionSchema,
  TextResolutionRequestSchema,
  TextResolutionSchema,
  SupervisorRequestSchema,
  SupervisorGuidanceSchema,
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
}
export class JevDecisionClient implements DecisionProvider {
  constructor(
    private url: string,
    private token: string,
  ) {}
  async supervise(input: SupervisorRequest, signal: AbortSignal): Promise<SupervisorGuidance> {
    const response = await fetch(this.url + '/navigation/supervise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
      body: JSON.stringify(SupervisorRequestSchema.parse(input)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Supervisor request failed.');
    return SupervisorGuidanceSchema.parse(data);
  }
  async resolveText(input: TextResolutionRequest, signal: AbortSignal): Promise<TextResolution> {
    const response = await fetch(this.url + '/navigation/resolve-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
      body: JSON.stringify(TextResolutionRequestSchema.parse(input)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    const data = (await response.json()) as any;
    if (!response.ok)
      throw new Error(typeof data.detail === 'string' ? data.detail : 'Text interpretation failed.');
    return TextResolutionSchema.parse(data);
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
        supervisorConfigured: data.supervisorConfigured, supervisorProvider: data.supervisorProvider, supervisorModel: data.supervisorModel };
    } catch (e) {
      return { available: false, keyConfigured: false, message: (e as Error).message };
    }
  }
  async decide(input: DecisionRequest | DesktopDecisionRequest, signal: AbortSignal): Promise<Decision> {
    const request =
      'mode' in input ? DesktopDecisionRequestSchema.parse(input) : DecisionRequestSchema.parse(input);
    const response = await fetch(this.url + '/navigation/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
      body: JSON.stringify(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    const data = (await response.json()) as any;
    if (!response.ok)
      throw new Error(
        typeof data.detail === 'string' ? data.detail : 'Decision broker rejected the request.',
      );
    return DecisionSchema.parse(data);
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
