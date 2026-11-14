import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Mic, MicOff, PhoneOff, RotateCcw } from 'lucide-react';
import { useAnam } from './useAnam';

export function App() {
  const anam = useAnam();
  const [expanded, setExpanded] = useState(false);
  const [launcherVisible, setLauncherVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [windowError, setWindowError] = useState('');
  const expandedRef = useRef(false);
  const closingRef = useRef(false);
  const dot = useRef<HTMLButtonElement>(null);
  const end = useRef<HTMLButtonElement>(null);
  const opening = useRef(0);
  const previousPhase = useRef(anam.phase);
  const restoreLauncherFocus = useRef(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const connected = anam.phase === 'connected';
  const failed = !!windowError || anam.phase === 'error' || (anam.phase === 'idle' && !!anam.error);

  async function open() {
    if (expandedRef.current || closingRef.current) return;
    const attempt = ++opening.current;
    expandedRef.current = true;
    setWindowError('');
    setExpanded(true);
    try {
      await window.overlay.setExpanded(true);
      if (opening.current === attempt) void anam.start(true);
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
      <span className="launcher-dot" aria-hidden="true" />
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
