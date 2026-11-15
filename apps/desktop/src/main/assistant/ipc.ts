/** IPC protocol between the main-side transport and the hidden assistant renderer. No electron import. */
export const ASSISTANT_IPC = {
  /** renderer -> main (invoke): mint a Realtime client secret. */
  secret: "assistant:secret",
  /** main -> renderer: AssistantCommand. */
  command: "assistant:cmd",
  /** renderer -> main (send): AssistantMessage. */
  message: "assistant:msg",
} as const;

export type AssistantCommand =
  | { kind: "connect" }
  | { kind: "disconnect" }
  | { kind: "send"; event: object }
  | { kind: "mic"; enabled: boolean }
  /** Whether Pointy plays the model's voice itself (false while the avatar's own audio is the voice). */
  | { kind: "voice"; local: boolean };

export type AssistantMessage =
  | { kind: "ready" }
  | { kind: "open"; maxMessageBytes?: number }
  | { kind: "failed"; error: string }
  | { kind: "closed"; reason: string }
  | { kind: "server"; event: { type: string; [k: string]: unknown } }
  /** The model's voice as it plays: base64 PCM (16-bit, 24 kHz, mono); null marks the end of an utterance. */
  | { kind: "audio"; pcm: string | null };
