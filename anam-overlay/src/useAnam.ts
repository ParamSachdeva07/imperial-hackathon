import { useCallback, useEffect, useRef, useState } from 'react';
import { AnamEvent, ConnectionClosedCode, createClient } from '@anam-ai/js-sdk';
import type { MessageDeliveryFailure } from '@anam-ai/js-sdk';

type Client = ReturnType<typeof createClient>;
type Phase = 'idle' | 'connecting' | 'connected' | 'stopping' | 'error';
type Message = { id: string; role: 'user' | 'persona'; content: string };
type Turn = {
  stream: ReturnType<Client['createTalkMessageStream']> | null;
  text: string; chain: Promise<void>; ended: boolean; failed: boolean; fellBack: boolean; cancelled: boolean;
};
type ActiveSession = { client: Client; dispose: () => void; streams: MediaStream[]; stopped?: Promise<void>;
  turns: Map<string, Turn> };
const MAX_TURNS = 16;
export type Talk = { turnId: string; text: string; final: boolean };
class UserVisibleError extends Error {}

function cleanup(session: ActiveSession): Promise<void> {
  session.turns.forEach((turn) => { turn.cancelled = true; });
  session.dispose();
  session.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  if (!session.stopped) {
    session.stopped = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      void session.client.stopStreaming().catch(() => undefined).finally(() => { clearTimeout(timeout); resolve(); });
    });
  }
  return session.stopped;
}

export function useAnam() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('Ready when you are');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const session = useRef<ActiveSession | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const [speaking, setSpeaking] = useState(false);
  const speakOnlyRef = useRef(false);
  // Resolved once from the main process: speak-only is decided by ANAM_SPEAK_ONLY, not by the page.
  const modeRef = useRef<Promise<boolean> | null>(null);
  modeRef.current ??= (window.overlay?.getMode?.() ?? Promise.resolve({ speakOnly: false }))
    .then((mode) => mode.speakOnly, () => false);

  const stop = useCallback(async () => {
    ++generation.current;
    const previous = session.current;
    session.current = null;
    busy.current = true;
    setPhase('stopping');
    setStatus('Ending conversation…');
    if (previous) await cleanup(previous);
    busy.current = false;
    if (mounted.current) {
      setPhase('idle'); setMuted(false); setSpeaking(false); setStatus('Conversation ended');
      const video = document.getElementById('persona-video') as HTMLVideoElement | null;
      if (video) video.srcObject = null;
    }
  }, []);

  const start = useCallback(async (wantMicrophone: boolean) => {
    if (busy.current || session.current) return;
    busy.current = true;
    const attempt = ++generation.current;
    const speakOnly = await modeRef.current!;
    speakOnlyRef.current = speakOnly;
    const useMicrophone = wantMicrophone && !speakOnly; // speak-only never touches the microphone
    if (generation.current !== attempt) { busy.current = false; return; }
    const current = () => mounted.current && generation.current === attempt;
    setPhase('connecting'); setError(''); setMessages([]); setMuted(!useMicrophone);
    setStatus('Creating your session…');
    let active: ActiveSession | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await window.overlay.getSessionToken();
      if (!current()) return;
      if (!result.ok) throw new UserVisibleError(result.error);
      if (useMicrophone) {
        setStatus('Waiting for microphone permission…');
        if (!await window.overlay.requestMicrophone()) {
          throw new UserVisibleError('Microphone access is off. Allow Electron in System Settings → Privacy & Security → Microphone, then try again.');
        }
      }
      if (!current()) return;
      const client = createClient(result.sessionToken, { disableInputAudio: !useMicrophone });
      const disposers: (() => void)[] = [];
      active = { client, streams: [], turns: new Map(), dispose: () => disposers.splice(0).forEach((dispose) => dispose()) };
      session.current = active;
      const idleStatus = speakOnly ? 'Connected · speaking only' : useMicrophone ? 'Listening · speak naturally' : 'Connected · type a message';
      const onVideo = () => { if (current()) setStatus(idleStatus); };
      const onSpeech = () => { if (current()) setStatus('Listening to you…'); };
      const onMessage = (message: Message & { endOfSpeech?: boolean; interrupted?: boolean }) => {
        if (!current()) return;
        if (message.role === 'persona') setSpeaking(!(message.endOfSpeech || message.interrupted));
        setMessages((previous) => {
          const existing = previous.find((item) => item.id === message.id);
          const next = existing
            ? previous.map((item) => item.id === message.id ? { ...item, content: item.content + message.content } : item)
            : [...previous, { id: message.id, content: message.content, role: message.role }];
          return next.slice(-100);
        });
        setStatus(message.role === 'persona' ? 'Your AI persona is responding' : 'Listening to you…');
      };
      const onTalkInterrupted = (correlationId: string) => {
        const turn = active?.turns.get(correlationId);
        if (turn) turn.cancelled = true;
        if (current()) setSpeaking(false);
      };
      const onDeliveryFailed = (failure: MessageDeliveryFailure) => {
        const turn = active?.turns.get(failure.correlationId);
        if (turn && active) markFailed(active, turn);
      };
      const onClose = (reason: ConnectionClosedCode) => {
        if (!current()) return;
        setSpeaking(false);
        ++generation.current;
        session.current = null;
        busy.current = false;
        if (active) void cleanup(active);
        setPhase('idle'); setMuted(false);
        setStatus('Conversation ended');
        if (reason !== ConnectionClosedCode.NORMAL) {
          setError('The session disconnected. Check your connection and start a new conversation.');
        }
      };
      const onDenied = () => {
        if (current()) setError('Microphone permission was denied. Allow access in System Settings, then try again.');
      };
      const onInputStream = (stream: MediaStream) => {
        if (current()) active?.streams.push(stream);
        else stream.getTracks().forEach((track) => track.stop());
      };
      client.addListener(AnamEvent.VIDEO_PLAY_STARTED, onVideo);
      client.addListener(AnamEvent.USER_SPEECH_STARTED, onSpeech);
      client.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, onMessage);
      client.addListener(AnamEvent.CONNECTION_CLOSED, onClose);
      client.addListener(AnamEvent.TALK_STREAM_INTERRUPTED, onTalkInterrupted);
      client.addListener(AnamEvent.MESSAGE_DELIVERY_FAILED, onDeliveryFailed);
      client.addListener(AnamEvent.MIC_PERMISSION_DENIED, onDenied);
      client.addListener(AnamEvent.INPUT_AUDIO_STREAM_STARTED, onInputStream);
      disposers.push(
        () => client.removeListener(AnamEvent.VIDEO_PLAY_STARTED, onVideo),
        () => client.removeListener(AnamEvent.USER_SPEECH_STARTED, onSpeech),
        () => client.removeListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, onMessage),
        () => client.removeListener(AnamEvent.CONNECTION_CLOSED, onClose),
        () => client.removeListener(AnamEvent.TALK_STREAM_INTERRUPTED, onTalkInterrupted),
        () => client.removeListener(AnamEvent.MESSAGE_DELIVERY_FAILED, onDeliveryFailed),
        () => client.removeListener(AnamEvent.MIC_PERMISSION_DENIED, onDenied),
        () => client.removeListener(AnamEvent.INPUT_AUDIO_STREAM_STARTED, onInputStream),
      );
      setStatus('Connecting to your persona…');
      const starting = client.streamToVideoElement('persona-video');
      // If setup completes after a timeout/cancel, stop the newly created connection too.
      void starting.then(() => { if (!current()) void client.stopStreaming().catch(() => undefined); }, () => undefined);
      await Promise.race([starting, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UserVisibleError('Connection timed out. Check your network and retry.')), 45_000);
      })]);
      if (!current()) return;
      setPhase('connected');
      setStatus(idleStatus);
    } catch (cause) {
      if (current()) {
        ++generation.current;
        session.current = null;
        if (active) await cleanup(active);
        if (mounted.current) {
          setPhase('error'); setStatus('Unable to connect');
          // SDK exceptions can contain server details. Only our explicit errors are shown.
          setError(cause instanceof UserVisibleError ? cause.message
            : 'The avatar could not connect. Check your network and microphone permissions, then retry.');
        }
      }
    } finally {
      clearTimeout(timer);
      if (generation.current === attempt || generation.current === attempt + 1) busy.current = false;
    }
  }, []);

  const toggleMute = () => {
    const client = session.current?.client;
    if (!client || phase !== 'connected') return;
    const next = muted ? client.unmuteInputAudio() : client.muteInputAudio();
    setMuted(next.isMuted);
    setStatus(next.isMuted ? 'Microphone muted' : 'Listening · speak naturally');
  };

  // Delivery failures are unconfirmed, so a fallback may repeat words already spoken; it runs at
  // most once per turn and never for a cancelled (interrupted / ended-session) turn.
  function markFailed(active: ActiveSession, turn: Turn) {
    turn.failed = true;
    maybeFallback(active, turn);
  }
  function maybeFallback(active: ActiveSession, turn: Turn) {
    if (!turn.failed || !turn.ended || turn.fellBack || turn.cancelled || !turn.text.trim()) return;
    turn.fellBack = true;
    void active.client.talk(turn.text).catch(() => undefined);
  }

  /** Speak-only: stream one chunk of a turn. One TalkMessageStream per turnId, chunks strictly ordered. */
  const talk = useCallback((chunk: Talk) => {
    const active = session.current;
    if (!active) return;
    let turn = active.turns.get(chunk.turnId);
    if (turn?.ended) return; // a finished turn id is not reused
    if (!turn) {
      turn = { stream: null, text: '', chain: Promise.resolve(), ended: false, failed: false, fellBack: false, cancelled: false };
      try { turn.stream = active.client.createTalkMessageStream(chunk.turnId); } catch { turn.failed = true; }
      active.turns.set(chunk.turnId, turn);
      if (active.turns.size > MAX_TURNS) {
        for (const [id, old] of active.turns) { if (old.ended) { active.turns.delete(id); break; } }
      }
    }
    const t = turn;
    t.text += chunk.text;
    if (chunk.final) t.ended = true;
    setSpeaking(true);
    t.chain = t.chain.then(async () => {
      if (t.cancelled) return;
      if (t.failed) { maybeFallback(active, t); return; }
      try {
        if (!t.stream?.isActive()) throw new Error('stream inactive');
        if (chunk.text) await t.stream.streamMessageChunk(chunk.text, chunk.final);
        else await t.stream.endMessage();
      } catch { markFailed(active, t); }
    });
  }, []);

  const interrupt = useCallback(() => {
    const active = session.current;
    if (!active) return;
    active.turns.forEach((turn) => { turn.cancelled = true; });
    try { active.client.interruptPersona(); } catch { /* not connected */ }
    setSpeaking(false);
  }, []);

  const send = (text: string): boolean => {
    if (speakOnlyRef.current) return false; // speak-only never sends user messages (the LLM is off)
    if (!text.trim() || !session.current || phase !== 'connected') return false;
    const id = crypto.randomUUID();
    setMessages((previous) => [...previous, { id, role: 'user' as const, content: text.trim() }].slice(-100));
    setError(''); setStatus('Waiting for your persona…');
    try {
      session.current.client.sendUserMessage(text.trim());
      return true;
    } catch {
      setMessages((previous) => previous.filter((message) => message.id !== id));
      setError('Your message could not be sent. Please retry.'); return false;
    }
  };

  useEffect(() => {
    mounted.current = true;
    const onUnload = () => {
      ++generation.current;
      const active = session.current;
      session.current = null;
      if (active) void cleanup(active);
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      mounted.current = false;
      window.removeEventListener('beforeunload', onUnload);
      onUnload();
    };
  }, []);

  return { phase, status, error, muted, messages, speaking, start, stop, toggleMute, send, talk, interrupt };
}
