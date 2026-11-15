/**
 * GA Realtime shapes used by the production assistant (manual responses; the model speaks unless POINTY_VOICE=anam).
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

/**
 * The voice the model speaks with, or null when the avatar does the speaking from text (POINTY_VOICE=anam).
 * The model's own audio is what gives Realtime its low latency.
 */
export function realtimeVoice(): string | null {
  if (process.env.POINTY_VOICE === "anam") return null;
  return process.env.POINTY_REALTIME_VOICE || "marin";
}

/**
 * How long the user must be silent before their turn counts as finished. Every answer waits at least this long,
 * so it is the largest fixed part of the response delay (the API default is 500).
 */
export const SILENCE_MS = 350;

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
  /** Voice for audio output; null or omitted for text-only output. */
  voice?: string | null;
}

/**
 * `session` payload for session.update / client_secrets. Audio output in the given voice, or text-only when the avatar speaks;
 * server VAD that only reports speech (we decide when to respond, and we never auto-cancel).
 */
export function assistantSessionConfig(opts: AssistantSessionOpts): Record<string, unknown> {
  return {
    type: "realtime",
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { reasoning: { effort: opts.effort } } : {}),
    instructions: opts.instructions,
    output_modalities: [opts.voice ? "audio" : "text"],
    audio: {
      ...(opts.voice ? { output: { voice: opts.voice } } : {}),
      input: {
        transcription: { model: "gpt-4o-transcribe" },
        turn_detection: { type: "server_vad", silence_duration_ms: SILENCE_MS, create_response: false, interrupt_response: false },
      },
    },
    tools: opts.tools,
    tool_choice: "auto",
  };
}
