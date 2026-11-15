import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Mic, MicOff, Phone, PhoneOff, RotateCcw } from 'lucide-react';
import { useAnam } from './useAnam';

export function App() {
  const anam = useAnam();
  const [expanded, setExpanded] = useState(false);
  const [launcherVisible, setLauncherVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [windowError, setWindowError] = useState('');
  const expandedRef = useRef(false);
  /** True while the call was started by the speak-only control API (Pointy), which owns the window. */
  const externalRef = useRef(false);
  /** ANAM_SPEAK_ONLY (decided by the main process): a failed call, even a manual one, must not strand the window expanded. */
  const speakOnlyRef = useRef(false);
  const closingRef = useRef(false);
  /** A start that arrived mid-teardown, replayed afterwards: its session id, or null. */
  const pendingStart = useRef<number | null>(null);
  /** Session of the call currently running (echoed in reports so main can ignore an older call's teardown). */
  const callSession = useRef<number | undefined>(undefined);
  /** callSession as of the phase machine's last 'connecting': an old call's teardown keeps reporting as itself. */
  const phaseSession = useRef<number | undefined>(undefined);
  const dot = useRef<HTMLButtonElement>(null);
  const end = useRef<HTMLButtonElement>(null);
  const opening = useRef(0);
  const previousPhase = useRef(anam.phase);
  const restoreLauncherFocus = useRef(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const connected = anam.phase === 'connected';
  const failed = !!windowError || anam.phase === 'error' || (anam.phase === 'idle' && !!anam.error);

  async function open(external = false, reexpand = false, session?: number) {
    if (closingRef.current) {
      // Speak-only: a start that arrives mid-teardown is replayed once the teardown finishes.
      if (external) pendingStart.current = session ?? 0;
      return;
    }
    if (expandedRef.current) return;
    const attempt = ++opening.current;
    expandedRef.current = true;
    externalRef.current = external;
    callSession.current = session;
    setWindowError('');
    setExpanded(true);
    try {
      // External (speak-only) starts are already expanded natively and must not steal focus.
      if (!external || reexpand) await window.overlay.setExpanded(true);
      if (opening.current === attempt) void anam.start(true); // speak-only forces mic-less inside the hook
    } catch {
      setWindowError('The desktop overlay could not open. Please relaunch Anam.');
    }
  }

  const endCall = useCallback(async (restoreFocus = false) => {
    if (!expandedRef.current || closingRef.current) return;
    ++opening.current;
    restoreLauncherFocus.current = restoreFocus;
    closingRef.current = true;
    setClosing(true);
    await anam.stop();
    try {
      // Shrink the actual native window, not just the content inside it.
      await window.overlay?.setExpanded(false);
      expandedRef.current = false;
      setExpanded(false);
    } catch {
      setWindowError('The call ended. Please relaunch Anam to restore the dot.');
    } finally {
      closingRef.current = false;
      setClosing(false);
      if (pendingStart.current !== null) {
        const next = pendingStart.current;
        pendingStart.current = null;
        // The native window was just collapsed by this teardown, so the replayed start must expand it again.
        queueMicrotask(() => { void handlers.current.open(true, true, next || undefined); });
      }
    }
  }, [anam.stop]);

  useEffect(() => {
    if (expanded) end.current?.focus();
    else if (restoreLauncherFocus.current) dot.current?.focus({ preventScroll: true });
  }, [expanded]);

  useEffect(() => {
    if (!window.overlay) return;
    let disposed = false;
    let eventReceived = false;
    const unsubscribe = window.overlay.onLauncherVisibility((visible) => {
      eventReceived = true;
      setLauncherVisible(visible);
    });
    void window.overlay.getLauncherVisibility().then((visible) => {
      if (!disposed && !eventReceived) setLauncherVisible(visible);
    });
    return () => { disposed = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (previousPhase.current === 'connected' && anam.phase === 'idle' && !anam.error) void endCall();
    previousPhase.current = anam.phase;
  }, [anam.phase, anam.error, endCall]);

  useEffect(() => {
    let disposed = false;
    void window.overlay?.getMode?.().then((mode) => { if (!disposed) speakOnlyRef.current = mode.speakOnly; }, () => undefined);
    return () => { disposed = true; };
  }, []);

  // Speak-only: the control API (Pointy) starts, speaks, interrupts and ends the call.
  const handlers = useRef({ open, endCall, talk: anam.talk, interrupt: anam.interrupt });
  handlers.current = { open, endCall, talk: anam.talk, interrupt: anam.interrupt };
  useEffect(() => {
    if (!window.overlay?.onSpeakCommand) return;
    return window.overlay.onSpeakCommand((command) => {
      if (command.type === 'start') void handlers.current.open(true, false, command.session);
      else if (command.type === 'end') { pendingStart.current = null; void handlers.current.endCall(); } // an end supersedes a start queued behind a teardown
      else if (command.type === 'interrupt') handlers.current.interrupt();
      else handlers.current.talk({ turnId: command.turnId, text: command.text, final: command.final });
    });
  }, []);

  // Report call state so the main process can flush queued talk and Pointy can see an End call.
  const reportedPhase = useRef(anam.phase);
  useEffect(() => {
    const before = reportedPhase.current;
    reportedPhase.current = anam.phase;
    if (anam.phase === 'connecting' || (anam.phase === 'connected' && before !== 'connected')) phaseSession.current = callSession.current;
    if (anam.phase === 'connected') window.overlay?.reportSpeak?.({ connected: true, session: phaseSession.current });
    else if ((before === 'connecting' || before === 'connected') && before !== anam.phase) {
      window.overlay?.reportSpeak?.({ connected: false, session: phaseSession.current });
      // Speak-only: main already collapsed the native window on this failure/drop. Reset the renderer too,
      // otherwise expandedRef stays true and later start/end commands are ignored.
      // A manual call (user clicked the dot) in speak-only mode is not tracked by main, so the native
      // window is still expanded: collapse it too, restoring the dot, so later control-API starts work.
      if ((externalRef.current || speakOnlyRef.current) && !closingRef.current && (anam.phase === 'error' || anam.error)) {
        const manual = !externalRef.current;
        ++opening.current;
        externalRef.current = false;
        expandedRef.current = false;
        setExpanded(false);
        if (manual) void Promise.resolve(window.overlay?.setExpanded(false)).catch(() => setWindowError('The call failed. Please relaunch Anam to restore the dot.'));
      }
    }
  }, [anam.phase, anam.error]);
  useEffect(() => { window.overlay?.reportSpeak?.({ speaking: anam.speaking, session: phaseSession.current }); }, [anam.speaking]);

  function keyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && expanded) { event.preventDefault(); void endCall(true); return; }
    if (event.altKey && expanded) {
      const amount = event.shiftKey ? 40 : 10;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount],
      };
      if (moves[event.key]) { event.preventDefault(); window.overlay?.moveBy(...moves[event.key]); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); window.overlay?.resizeBy(20); }
      if (event.key === '-') { event.preventDefault(); window.overlay?.resizeBy(-20); }
    }
  }

  function pointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.retry-button')) return;
    drag.current = { x: event.screenX, y: event.screenY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    window.overlay?.moveStart();
  }
  function pointerMove(event: PointerEvent<HTMLElement>) {
    if (!drag.current) return;
    if (Math.hypot(event.screenX - drag.current.x, event.screenY - drag.current.y) > 5) drag.current.moved = true;
    if (drag.current.moved) window.overlay?.moveUpdate();
  }
  function pointerUp(event: PointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    window.overlay?.moveEnd();
  }
  const dragProps = { onPointerDown: pointerDown, onPointerMove: pointerMove,
    onPointerUp: pointerUp, onLostPointerCapture: () => { drag.current = null; window.overlay?.moveEnd(); } };

  return <main className={`companion ${expanded ? 'expanded' : 'collapsed'}`} onKeyDown={keyDown}>
    <button ref={dot} className={`launcher ${launcherVisible ? 'is-revealed' : ''}`} hidden={expanded}
      aria-label="Open Anam and start a call" aria-expanded={expanded} aria-controls="anam-call"
      title="Talk to Anam"
      onFocus={() => window.overlay?.setLauncherFocused(true)}
      onBlur={() => window.overlay?.setLauncherFocused(false)}
      onClick={() => void open()}>
      <span className="launcher-dot" aria-hidden="true"><Phone size={17} strokeWidth={0} fill="currentColor" /></span>
    </button>

    <section id="anam-call" className="call" hidden={!expanded} aria-label="Anam call">
      <div className={`avatar ${connected ? 'live' : ''} ${failed ? 'failed' : ''}`} {...dragProps}>
        <video id="persona-video" autoPlay playsInline aria-label="Your Anam AI persona" />
        {!connected && <div className="avatar-placeholder">
          {failed ? <>
            <span className="placeholder-name">anam</span>
            <p role="alert">{windowError || anam.error}</p>
            {!windowError && <button className="retry-button" onClick={() => void anam.start(true)}><RotateCcw size={15} aria-hidden="true" />Try again</button>}
          </> : <>
            <span className="connection-orbit" aria-hidden="true" />
            <span className="placeholder-name">anam</span>
            <p>{closing ? 'Ending your call…' : 'Connecting…'}</p>
          </>}
        </div>}
        <span className="avatar-label"><span className={connected ? 'live-indicator' : ''} />{anam.muted && connected ? 'Mic muted' : 'Anam · AI'}</span>
      </div>

      <div className="call-controls">
        <button className={`call-button mute-button ${anam.muted ? 'is-muted' : ''}`}
          aria-label={anam.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={anam.muted}
          disabled={!connected || closing} onClick={anam.toggleMute}>
          {anam.muted ? <MicOff size={20} strokeWidth={2.1} aria-hidden="true" /> : <Mic size={20} strokeWidth={2.1} aria-hidden="true" />}
          <span>{anam.muted ? 'Unmute' : 'Mute'}</span>
        </button>
        <button ref={end} className="call-button end-button" aria-label="End call and return to dot"
          disabled={closing} onClick={(event) => void endCall(event.detail === 0)}>
          <PhoneOff size={20} strokeWidth={2.1} aria-hidden="true" /><span>{closing ? 'Ending…' : 'End call'}</span>
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{anam.status}</p>
    </section>
  </main>;
}
