/**
 * Hidden production-assistant page: owns the GPT Realtime WebRTC session and the microphone.
 * Main drives it through commands (connect/disconnect/send/mic); every server event is forwarded to
 * main, where AssistantController decides what to do. Text-only output: there is no audio playback.
 * WebRTC flow as in the dev voice window (renderer/voice/main.tsx): ephemeral secret from main ->
 * POST https://api.openai.com/v1/realtime/calls (application/sdp) -> data channel "oai-events".
 */
import type { AssistantCommand, AssistantMessage } from "../../main/assistant/ipc";
import { createCommandHandler, type RtcSession } from "./commands";

interface AssistantApi {
  getSecret(): Promise<{ value: string; expiresAt: number; model: string }>;
  emit(m: AssistantMessage): void;
  onCommand(cb: (c: AssistantCommand) => void): () => void;
}
const api = (window as unknown as { pointyAssistant: AssistantApi }).pointyAssistant;

function waitForIce(conn: RTCPeerConnection): Promise<void> {
  if (conn.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (conn.iceGatheringState === "complete") {
        conn.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    conn.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, 2000); // don't hang on slow ICE; send what we have
  });
}

/** Everything one connect() attempt owns. A stale attempt only ever tears down its own resources. */
interface Attempt {
  conn: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  mic: MediaStream | null;
  cancelled: boolean;
}
let active: Attempt | null = null;
let micEnabled = true;

function applyMic(a: Attempt | null): void {
  for (const t of a?.mic?.getAudioTracks() ?? []) t.enabled = micEnabled;
}

function teardownAttempt(a: Attempt): void {
  a.cancelled = true;
  for (const t of a.mic?.getTracks() ?? []) t.stop();
  a.mic = null;
  a.channel = null;
  const conn = a.conn;
  a.conn = null;
  if (active === a) active = null;
  if (conn) conn.close();
}

const session: RtcSession = {
  async connect() {
    if (active) teardownAttempt(active);
    const a: Attempt = { conn: null, channel: null, mic: null, cancelled: false };
    active = a;
    // After every await: if cancelled (or timed out) meanwhile, release whatever just arrived and stop.
    const alive = () => {
      if (a.cancelled) throw new Error("connection cancelled");
    };
    try {
      const secret = await api.getSecret();
      alive();
      const conn = new RTCPeerConnection();
      a.conn = conn;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      a.mic = stream; // owned now, so teardownAttempt stops it even if we were cancelled meanwhile
      alive();
      applyMic(a);
      for (const track of stream.getTracks()) conn.addTrack(track, stream);
      const channel = conn.createDataChannel("oai-events");
      a.channel = channel;
      channel.onmessage = (m) => {
        try {
          api.emit({ kind: "server", event: JSON.parse(String(m.data)) as { type: string } });
        } catch {
          /* ignore malformed frames */
        }
      };
      const lost = (reason: string) => {
        if (a.cancelled || active !== a) return;
        teardownAttempt(a);
        api.emit({ kind: "closed", reason });
      };
      channel.onclose = () => lost("data channel closed");
      conn.onconnectionstatechange = () => {
        if (conn.connectionState === "failed" || conn.connectionState === "closed") lost(`peer connection ${conn.connectionState}`);
      };
      let openTimer: ReturnType<typeof setTimeout> | undefined;
      const opened = new Promise<void>((resolve, reject) => {
        channel.onopen = () => resolve();
        openTimer = setTimeout(() => reject(new Error("data channel did not open")), 12_000);
      });
      opened.catch(() => undefined); // never an unhandled rejection if we fail earlier
      await conn.setLocalDescription(await conn.createOffer());
      alive();
      await waitForIce(conn);
      alive();
      const res = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { authorization: `Bearer ${secret.value}`, "content-type": "application/sdp" },
        body: conn.localDescription?.sdp ?? "",
      });
      alive();
      if (!res.ok) throw new Error(`realtime/calls ${res.status}`);
      const answer = await res.text();
      alive();
      await conn.setRemoteDescription({ type: "answer", sdp: answer });
      try {
        await opened;
      } finally {
        clearTimeout(openTimer);
      }
      alive();
      const max = conn.sctp?.maxMessageSize;
      return { maxMessageBytes: max && Number.isFinite(max) ? max : undefined };
    } catch (e) {
      teardownAttempt(a); // stop our own mic / peer; never touches a newer attempt
      throw e;
    }
  },
  close() {
    if (active) teardownAttempt(active);
  },
  send(event) {
    const ch = active?.channel;
    if (ch && ch.readyState === "open") ch.send(JSON.stringify(event));
  },
  setMic(enabled) {
    micEnabled = enabled;
    applyMic(active);
  },
};

const handle = createCommandHandler(session, (m) => api.emit(m));
api.onCommand(handle);
api.emit({ kind: "ready" });
