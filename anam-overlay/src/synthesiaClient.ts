// A Synthesia interactive avatar behind the same surface useAnam uses for the Anam client.
//
// Synthesia renders the avatar as a participant ("synthesia-avatar-agent") in a LiveKit room we own. This window
// joins that room, asks the local backend to start the avatar there, shows the avatar's video, and sends it the
// voice audio to lip-sync to. The wire format is LiveKit's avatar protocol (livekit-agents DataStreamAudioOutput):
//   - audio: a byte stream on topic "lk.audio_stream" to the avatar, attributes sample_rate / num_channels,
//     raw 16-bit PCM; closing the stream ends the utterance
//   - interrupt: RPC "lk.clear_buffer" to the avatar
//   - the avatar calls RPC "lk.playback_finished" on us when it has finished an utterance
// The avatar also publishes the audio it lip-syncs to, in sync with its video: that is played here (the audible voice),
// and "avatar-speaking" is emitted from the first chunk of an utterance until playback finishes.
// The avatar only lip-syncs here: speech comes as audio from the app that drives this window (lip-sync mode).
import { AnamEvent, ConnectionClosedCode } from '@anam-ai/js-sdk';
import { Room, RoomEvent, Track } from 'livekit-client';
import type { RemoteParticipant, RemoteTrack } from 'livekit-client';

const AUDIO_TOPIC = 'lk.audio_stream';
/** Synthesia documents joins of around 45 seconds. */
export const SYNTHESIA_JOIN_MS = 110_000;
/** Slack on top of the audio's own duration before speaking is cleared without a playback_finished. */
const SPEAKING_SAFETY_MS = 2_000;
/** Emitted with a boolean: the avatar is (not) playing a voice. */
export const AVATAR_SPEAKING = 'avatar-speaking';

export type SynthesiaSession = {
  url: string;
  token: string;
  avatarIdentity: string;
  /** Ask the backend to start the avatar in the room this window has joined; resolves once it is live. */
  startAvatar(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The call is over: have the backend close the room, which is what ends the avatar's session. */
  endAvatar(): Promise<void>;
};

type Listener = (...args: never[]) => void;
type Writer = { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createSynthesiaClient(session: SynthesiaSession) {
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args);
  };
  const room = new Room({ adaptiveStream: false }); // the avatar's resolution is fixed by Synthesia: never downscale it
  let stopped = false;
  let live = false;
  let writer: Writer | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let speaking = false;
  let sentBytes = 0;
  let speakingSince = 0;
  let speakingTimer: ReturnType<typeof setTimeout> | undefined;
  const setSpeaking = (value: boolean) => {
    if (!value) { clearTimeout(speakingTimer); speakingTimer = undefined; sentBytes = 0; }
    if (speaking === value) return;
    speaking = value;
    emit(AVATAR_SPEAKING, value);
  };
  /** Audio operations run one after another so chunks stay in order and an end never overtakes its audio. */
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => { queue = queue.then(work).catch(() => undefined); };

  const closed = (code: ConnectionClosedCode) => {
    if (stopped) return;
    stopped = true;
    live = false;
    emit(AnamEvent.CONNECTION_CLOSED, code);
  };

  return {
    addListener(event: string, callback: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(callback);
    },
    removeListener(event: string, callback: Listener) { listeners.get(event)?.delete(callback); },

    async streamToVideoElement(id: string) {
      const video = document.getElementById(id) as HTMLVideoElement | null;
      if (!video) throw new Error('Video element missing');
      const attached = new Promise<void>((resolve) => {
        const attach = (track: RemoteTrack, participant: RemoteParticipant) => {
          if (participant.identity !== session.avatarIdentity) return;
          console.info(`[avatar] track ${track.kind}`);
          if (track.kind === Track.Kind.Audio) {
            // The avatar's own audio, in sync with its lips: this is the voice that is heard.
            audioEl ??= document.createElement('audio');
            audioEl.autoplay = true;
            audioEl.muted = false;
            audioEl.style.display = 'none';
            if (!audioEl.isConnected) document.body.appendChild(audioEl);
            track.attach(audioEl);
            void audioEl.play().catch(() => undefined);
            return;
          }
          if (track.kind !== Track.Kind.Video) return;
          track.attach(video);
          resolve();
        };
        room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => attach(track, participant));
      });
      room.on(RoomEvent.Disconnected, () => closed(ConnectionClosedCode.NORMAL));
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant.identity === session.avatarIdentity) closed(ConnectionClosedCode.WEBRTC_FAILURE);
      });
      // The room must exist with us in it before the avatar is started: its token publishes on our behalf.
      await room.connect(session.url, session.token);
      room.registerRpcMethod('lk.playback_finished', async () => { setSpeaking(false); return 'ok'; });
      const started = await session.startAvatar();
      if (!started.ok) throw new Error(started.error);
      await attached;
      if (stopped) return;
      live = true;
      emit(AnamEvent.VIDEO_PLAY_STARTED);
    },

    async stopStreaming() {
      stopped = true;
      live = false;
      writer = null;
      setSpeaking(false);
      if (audioEl) { audioEl.srcObject = null; audioEl.remove(); audioEl = null; }
      await Promise.all([room.disconnect().catch(() => undefined), session.endAvatar().catch(() => undefined)]);
    },

    /** Lip-sync input. Only 16-bit mono PCM is sent; the rate is passed on as given. */
    createAgentAudioInputStream(config: { sampleRate: number; channels: number }) {
      return {
        sendAudioChunk(chunk: string) {
          if (!live) return;
          const bytes = decode(chunk);
          // Speaking from the first chunk of an utterance; the avatar says when it has finished playing it.
          if (!writer && sentBytes === 0) speakingSince = Date.now();
          sentBytes += bytes.length;
          const audioMs = (sentBytes / (config.sampleRate * 2 * config.channels)) * 1000;
          clearTimeout(speakingTimer);
          speakingTimer = setTimeout(() => setSpeaking(false), Math.max(0, speakingSince + audioMs + SPEAKING_SAFETY_MS - Date.now()));
          setSpeaking(true);
          enqueue(async () => {
            writer ??= await room.localParticipant.streamBytes({
              name: `AUDIO_${crypto.randomUUID().slice(0, 8)}`,
              topic: AUDIO_TOPIC,
              destinationIdentities: [session.avatarIdentity],
              attributes: { sample_rate: String(config.sampleRate), num_channels: String(config.channels) },
            });
            await writer.write(bytes);
          });
        },
        endSequence() {
          enqueue(async () => {
            const open = writer;
            writer = null;
            await open?.close();
          });
        },
      };
    },

    interruptPersona() {
      if (!live) return;
      setSpeaking(false);
      enqueue(async () => {
        const open = writer;
        writer = null;
        await open?.close().catch(() => undefined);
        await room.localParticipant.performRpc({ destinationIdentity: session.avatarIdentity, method: 'lk.clear_buffer', payload: '' });
      });
    },

    // The avatar has no voice or model of its own here: text cannot be spoken, and there is no microphone to mute.
    createTalkMessageStream(): never { throw new Error('This avatar only lip-syncs to audio.'); },
    async talk(): Promise<never> { throw new Error('This avatar only lip-syncs to audio.'); },
    sendUserMessage(): never { throw new Error('This avatar only lip-syncs to audio.'); },
    muteInputAudio: () => ({ isMuted: true }),
    unmuteInputAudio: () => ({ isMuted: false }),
  };
}
