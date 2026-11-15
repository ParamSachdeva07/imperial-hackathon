/** `livekit` is present for a Synthesia avatar: the room to join with sessionToken and the avatar's identity in it. */
export type TokenResult = { ok: true; sessionToken: string; livekit?: { url: string; avatarIdentity: string } } | { ok: false; error: string };
export type SpeakCommand =
  | { type: 'start'; session: number }
  | { type: 'end' }
  | { type: 'interrupt' }
  | { type: 'talk'; turnId: string; text: string; final: boolean }
  | { type: 'audio'; pcm: string | null };
export type SpeakReport = { connected?: boolean; speaking?: boolean; muted?: boolean; session?: number };
export interface OverlayBridge {
  /** True when launched with ANAM_SPEAK_ONLY=1: externally driven, mic-less, never sendUserMessage. */
  /** lipSync (ANAM_LIP_SYNC=1): the voice is played elsewhere; the avatar only moves its lips to the audio it is sent. */
  getMode(): Promise<{ speakOnly: boolean; lipSync: boolean }>;
  onSpeakCommand(callback: (command: SpeakCommand) => void): () => void;
  reportSpeak(report: SpeakReport): void;
  getSessionToken(): Promise<TokenResult>;
  /** Synthesia: bring the avatar into the room this window has joined. Resolves once it is live (can take a minute). */
  startAvatar(): Promise<{ ok: true } | { ok: false; error: string }>;
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
