/**
 * Hidden production-assistant page: owns the GPT Realtime WebRTC session and the microphone.
 * Main drives it through commands (connect/disconnect/send/mic); every server event is forwarded to
 * main, where AssistantController decides what to do. When the model speaks (audio output), its voice is
 * played here, in the page that owns the microphone, so the browser's echo cancellation removes it from
 * what the model hears; the same audio is reported to main as PCM for the avatar to lip-sync to.
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

/** The model's voice: played through `el`, and tapped as PCM while the server says audio is playing. */
interface Voice {
  el: HTMLAudioElement;
  ctx: AudioContext;
  forwarding: boolean;
  stopTimer: ReturnType<typeof setTimeout> | undefined;
}
const VOICE_RATE = 24_000; // the avatar's native rate
const VOICE_TAIL_MS = 200; // audio still in the local playout buffer when the server reports the end

function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.max(-1, Math.min(1, samples[i] ?? 0)) * 0x7fff, true);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function playVoice(stream: MediaStream): Voice {
  const el = new Audio();
  el.srcObject = stream;
  void el.play().catch(() => undefined);
  const ctx = new AudioContext({ sampleRate: VOICE_RATE });
  const tap = ctx.createScriptProcessor(2048, 1, 1); // ~85 ms chunks
  const silent = ctx.createGain(); // the tap only runs when connected to an output; the audible copy is `el`
  silent.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(tap);
  tap.connect(silent);
  silent.connect(ctx.destination);
  const voice: Voice = { el, ctx, forwarding: false, stopTimer: undefined };
  tap.onaudioprocess = (e) => {
    if (voice.forwarding) api.emit({ kind: "audio", pcm: pcm16Base64(e.inputBuffer.getChannelData(0)) });
  };
  return voice;
}

/** Follow the server's playback events: report the voice only while there is something to hear. */
function trackVoice(voice: Voice, type: string): void {
  const stop = () => {
    voice.stopTimer = undefined;
    if (!voice.forwarding) return;
    voice.forwarding = false;
    api.emit({ kind: "audio", pcm: null });
  };
  if (type === "output_audio_buffer.started") {
    clearTimeout(voice.stopTimer);
    voice.stopTimer = undefined;
    voice.forwarding = true;
  } else if (type === "output_audio_buffer.stopped") {
    clearTimeout(voice.stopTimer);
    voice.stopTimer = setTimeout(stop, VOICE_TAIL_MS);
  } else if (type === "output_audio_buffer.cleared") {
    clearTimeout(voice.stopTimer);
    stop();
  }
}

/** Everything one connect() attempt owns. A stale attempt only ever tears down its own resources. */
interface Attempt {
  conn: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  mic: MediaStream | null;
  voice: Voice | null;
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
  if (a.voice) {
    clearTimeout(a.voice.stopTimer);
    a.voice.el.srcObject = null;
    void a.voice.ctx.close().catch(() => undefined);
    a.voice = null;
  }
  a.channel = null;
  const conn = a.conn;
  a.conn = null;
  if (active === a) active = null;
  if (conn) conn.close();
}

const session: RtcSession = {
  async connect() {
    if (active) teardownAttempt(active);
    const a: Attempt = { conn: null, channel: null, mic: null, voice: null, cancelled: false };
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
      conn.ontrack = (e) => {
        if (!a.cancelled && !a.voice && e.track.kind === "audio") a.voice = playVoice(e.streams[0] ?? new MediaStream([e.track]));
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) // the voice plays in this page, so its echo is cancelled;
      a.mic = stream; // owned now, so teardownAttempt stops it even if we were cancelled meanwhile
      alive();
      applyMic(a);
      for (const track of stream.getTracks()) conn.addTrack(track, stream);
      const channel = conn.createDataChannel("oai-events");
      a.channel = channel;
      channel.onmessage = (m) => {
        try {
          const event = JSON.parse(String(m.data)) as { type: string };
          if (a.voice) trackVoice(a.voice, event.type);
          api.emit({ kind: "server", event });
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
