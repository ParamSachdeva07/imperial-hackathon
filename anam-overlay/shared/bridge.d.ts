export type TokenResult = { ok: true; sessionToken: string } | { ok: false; error: string };
export type SpeakCommand =
  | { type: 'start'; session: number }
  | { type: 'end' }
  | { type: 'interrupt' }
  | { type: 'talk'; turnId: string; text: string; final: boolean };
export type SpeakReport = { connected?: boolean; speaking?: boolean; session?: number };
export interface OverlayBridge {
  /** True when launched with ANAM_SPEAK_ONLY=1: externally driven, mic-less, never sendUserMessage. */
  getMode(): Promise<{ speakOnly: boolean }>;
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
