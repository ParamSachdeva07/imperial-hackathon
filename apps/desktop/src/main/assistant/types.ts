/** Interfaces for the assistant core. No electron imports. */
export interface AnamTalk {
  turnId: string;
  text: string;
  final: boolean;
}

export interface AnamSpeakerState {
  connected: boolean;
  speaking: boolean;
  expanded: boolean;
  /** A start was issued and the call is not connected yet (false + !connected = the call is over). */
  starting?: boolean;
}

/** Speak-only Anam control API client (HTTP, implemented by T2). */
export interface AnamSpeakerClient {
  startSession(): Promise<void>;
  endSession(): Promise<void>;
  talk(t: AnamTalk): Promise<void>;
  interrupt(): Promise<void>;
  /** null when Anam is unreachable. */
  state(): Promise<AnamSpeakerState | null>;
}

/** A server event from the Realtime data channel (loosely typed on purpose). */
export type RealtimeServerEvent = { type: string; [k: string]: unknown };

/**
 * The Realtime connection as the controller sees it (implemented over the hidden renderer window by
 * assistantWindow.ts; faked in tests). Half-duplex mic gating lives here: the renderer disables the
 * mic *track*, so no audio reaches the model while Anam speaks.
 */
export interface RealtimeTransport {
  /** Mint a secret, open the WebRTC session with the mic, resolve once the data channel is open. */
  connect(): Promise<void>;
  disconnect(): void;
  /** Send a client event (JSON) on the data channel. */
  send(event: object): void;
  setMicEnabled(enabled: boolean): void;
  /** SCTP max message size once connected (for fitting images), else undefined. */
  maxMessageBytes(): number | undefined;
  onEvent(cb: (e: RealtimeServerEvent) => void): () => void;
  /** The connection dropped by itself (not via disconnect()). */
  onClosed(cb: (reason: string) => void): () => void;
}
