/**
 * GA Realtime shapes used by the production assistant (text-only output, manual responses).
 * Verified against the real API by scripts/realtime-smoke.ts. No electron imports.
 */
/** Read lazily: the repo .env is loaded after this module is imported. */
export function realtimeModel(): string {
  return process.env.POINTY_REALTIME_MODEL || process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL;
}

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
export const FALLBACK_REASONING_EFFORT = "low";

/** Reasoning effort (GA field: session.reasoning.effort). Verified accepted: minimal|low|medium|high|xhigh (+none). */
export function reasoningEffort(): string {
  return process.env.POINTY_REASONING_EFFORT || "low";
}

/** One-line summary for a start log. */
export function describeRealtimeConfig(model = realtimeModel(), effort: string | undefined = reasoningEffort()): string {
  return `model=${model}, effort=${effort ?? "default"}`;
}

export interface AssistantSessionOpts {
  instructions: string;
  tools: unknown[];
  model?: string;
  /** Reasoning effort; omit for the model default. */
  effort?: string;
}

/**
 * `session` payload for session.update / client_secrets. Text-only output (Anam does the speaking),
 * server VAD that only reports speech (we decide when to respond, and we never auto-cancel).
 */
export function assistantSessionConfig(opts: AssistantSessionOpts): Record<string, unknown> {
  return {
    type: "realtime",
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { reasoning: { effort: opts.effort } } : {}),
    instructions: opts.instructions,
    output_modalities: ["text"],
    audio: {
      input: {
        transcription: { model: "gpt-4o-transcribe" },
        turn_detection: { type: "server_vad", create_response: false, interrupt_response: false },
      },
    },
    tools: opts.tools,
    tool_choice: "auto",
  };
}
