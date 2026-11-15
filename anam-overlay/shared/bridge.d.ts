export type TokenResult = { ok: true; sessionToken: string } | { ok: false; error: string };
export type SpeakCommand =
  | { type: 'start'; session: number }
  | { type: 'end' }
  | { type: 'interrupt' }
  | { type: 'message'; text: string }
  | { type: 'talk'; turnId: string; text: string; final: boolean };
export type SpeakReport = { connected?: boolean; speaking?: boolean; session?: number };
export interface OverlayBridge {
  /** True when launched with ANAM_SPEAK_ONLY=1: externally driven, mic-less, never sendUserMessage. */
  getMode(): Promise<{ speakOnly: boolean; agent?: boolean; tools?: string[] }>;
  /** Agent mode: run a tool the ElevenLabs agent called, in the main app; resolves with its result as text. */
  callTool(name: string, args: unknown): Promise<string>;
  /** Agent mode: tell the main app what was said (for memory and status). */
  agentEvent(event: { role: 'user' | 'persona'; id: string; content: string; end: boolean; interrupted: boolean }): void;
  onSpeakCommand(callback: (command: SpeakCommand) => void): () => void;
  reportSpeak(report: SpeakReport): void;
  getSessionToken(): Promise<TokenResult>;
  requestMicrophone(): Promise<boolean>;
  setExpanded(expanded: boolean): Promise<void>;
  getLauncherVisibility(): Promise<boolean>;
  onLauncherVisibility(callback: (visible: boolean) => void): () => void;
  setLauncherFocused(focused: boolean): void;
  moveStart(): void;
  moveUpdate(): void;
  moveEnd(): void;
  resizeBy(amount: number): void;
  moveBy(x: number, y: number): void;
}
