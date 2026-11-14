import { useCallback, useEffect, useRef, useState } from 'react';
import { AnamEvent, ConnectionClosedCode, createClient } from '@anam-ai/js-sdk';

type Client = ReturnType<typeof createClient>;
type Phase = 'idle' | 'connecting' | 'connected' | 'stopping' | 'error';
type Message = { id: string; role: 'user' | 'persona'; content: string };
type ActiveSession = { client: Client; dispose: () => void; streams: MediaStream[]; stopped?: Promise<void> };
class UserVisibleError extends Error {}

function cleanup(session: ActiveSession): Promise<void> {
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
      setPhase('idle'); setMuted(false); setStatus('Conversation ended');
      const video = document.getElementById('persona-video') as HTMLVideoElement | null;
      if (video) video.srcObject = null;
    }
  }, []);

  const start = useCallback(async (useMicrophone: boolean) => {
    if (busy.current || session.current) return;
    busy.current = true;
    const attempt = ++generation.current;
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
      active = { client, streams: [], dispose: () => disposers.splice(0).forEach((dispose) => dispose()) };
      session.current = active;
      const onVideo = () => { if (current()) setStatus(useMicrophone ? 'Listening · speak naturally' : 'Connected · type a message'); };
      const onSpeech = () => { if (current()) setStatus('Listening to you…'); };
      const onMessage = (message: Message) => {
        if (!current()) return;
        setMessages((previous) => {
          const existing = previous.find((item) => item.id === message.id);
          const next = existing
            ? previous.map((item) => item.id === message.id ? { ...item, content: item.content + message.content } : item)
            : [...previous, { id: message.id, content: message.content, role: message.role }];
          return next.slice(-100);
        });
        setStatus(message.role === 'persona' ? 'Your AI persona is responding' : 'Listening to you…');
      };
      const onClose = (reason: ConnectionClosedCode) => {
        if (!current()) return;
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
      client.addListener(AnamEvent.MIC_PERMISSION_DENIED, onDenied);
      client.addListener(AnamEvent.INPUT_AUDIO_STREAM_STARTED, onInputStream);
      disposers.push(
        () => client.removeListener(AnamEvent.VIDEO_PLAY_STARTED, onVideo),
        () => client.removeListener(AnamEvent.USER_SPEECH_STARTED, onSpeech),
        () => client.removeListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, onMessage),
        () => client.removeListener(AnamEvent.CONNECTION_CLOSED, onClose),
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
      setStatus(useMicrophone ? 'Listening · speak naturally' : 'Connected · type a message');
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

  const send = (text: string): boolean => {
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

  return { phase, status, error, muted, messages, start, stop, toggleMute, send };
}
