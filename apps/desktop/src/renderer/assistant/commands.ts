/**
 * Command handling for the hidden assistant page, separated from WebRTC so it is unit-testable:
 * the real RTC session (main.ts) and the emit function are injected.
 */
import type { AssistantCommand, AssistantMessage } from "../../main/assistant/ipc";

export interface RtcSession {
  /** Mint + connect + resolve once the data channel is open. */
  connect(): Promise<{ maxMessageBytes?: number }>;
  close(): void;
  send(event: object): void;
  setMic(enabled: boolean): void;
}

export function createCommandHandler(session: RtcSession, emit: (m: AssistantMessage) => void): (cmd: AssistantCommand) => void {
  let connecting = false;
  let connected = false;
  /** Bumped by disconnect so a connect finishing late is discarded. */
  let generation = 0;
  let mic = true;

  return (cmd) => {
    switch (cmd.kind) {
      case "connect": {
        if (connecting || connected) return;
        connecting = true;
        const gen = ++generation;
        session.connect().then(
          (info) => {
            if (gen !== generation) return; // stale: connect() released its own resources (never close the newer session)
            connecting = false;
            connected = true;
            session.setMic(mic);
            emit({ kind: "open", ...(info.maxMessageBytes ? { maxMessageBytes: info.maxMessageBytes } : {}) });
          },
          (e: unknown) => {
            if (gen !== generation) return;
            connecting = false;
            session.close();
            emit({ kind: "failed", error: e instanceof Error ? e.message : String(e) });
          },
        );
        return;
      }
      case "disconnect":
        generation++;
        connecting = false;
        connected = false;
        mic = true;
        session.close();
        return;
      case "send":
        if (connected) session.send(cmd.event);
        return;
      case "mic":
        mic = cmd.enabled;
        session.setMic(cmd.enabled);
        return;
    }
  };
}
