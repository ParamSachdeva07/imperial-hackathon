// Speak-only controller (ANAM_SPEAK_ONLY=1). Pure: no electron import, so it is tested in plain node.
// Another local app (Pointy) drives the avatar as a mouth: it starts a mic-less call, sends text
// to speak, interrupts, and ends the call. The LLM lives elsewhere; nothing here listens.
export type Talk = { turnId: string; text: string; final: boolean };
export type SpeakCommand =
  | { type: 'start'; session: number }
  | { type: 'end' }
  | { type: 'interrupt' }
  | ({ type: 'talk' } & Talk);
// `session` echoes the start command of the call the report is about; reports for an older call are ignored.
export type SpeakReport = { connected?: boolean; speaking?: boolean; session?: number };
export type SpeakState = { connected: boolean; speaking: boolean; starting: boolean };
export type TalkResult = 'sent' | 'queued' | 'no_call' | 'queue_full';

export type SpeakDeps = {
  send(command: SpeakCommand): void; // to the renderer
  setExpanded(expanded: boolean): void; // native window expand/collapse
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  idleMs?: number;
  queueMax?: number;
  queueMaxAgeMs?: number;
};

export const IDLE_MS = 3 * 60_000;
export const QUEUE_MAX = 20;
export const QUEUE_MAX_AGE_MS = 30_000;

export function createSpeakController(deps: SpeakDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; });
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const idleMs = deps.idleMs ?? IDLE_MS;
  const queueMax = deps.queueMax ?? QUEUE_MAX;
  const maxAge = deps.queueMaxAgeMs ?? QUEUE_MAX_AGE_MS;
  let connected = false;
  let speaking = false;
  let starting = false;
  let session = 0; // generation of the current call, bumped on every new start
  let idle: unknown = null;
  let queue: { talk: Talk; at: number }[] = [];

  const touch = () => {
    if (idle !== null) clearTimer(idle);
    idle = setTimer(() => { idle = null; end(); }, idleMs); // billing safety: never leave a call open
  };
  const stopIdle = () => { if (idle !== null) { clearTimer(idle); idle = null; } };

  function start() {
    if (connected || starting) { touch(); return; }
    starting = true;
    session++;
    touch();
    deps.setExpanded(true);
    deps.send({ type: 'start', session });
  }

  function end() {
    const active = connected || starting;
    stopIdle();
    queue = [];
    connected = false; speaking = false; starting = false;
    if (active) deps.send({ type: 'end' });
    deps.setExpanded(false);
  }

  function talk(t: Talk): TalkResult {
    if (connected) { touch(); deps.send({ type: 'talk', ...t }); return 'sent'; }
    if (!starting) return 'no_call';
    const cutoff = now() - maxAge;
    queue = queue.filter((q) => q.at >= cutoff);
    if (queue.length >= queueMax) return 'queue_full';
    queue.push({ talk: t, at: now() });
    touch();
    return 'queued';
  }

  function interrupt() {
    queue = [];
    if (connected || starting) deps.send({ type: 'interrupt' });
  }

  // Renderer reports. connected:false while we were connected/starting means the call ended
  // (user clicked End call, connection dropped, start failed): reset and make sure the window is a dot.
  function report(r: SpeakReport) {
    // A teardown report from an earlier call can land after a newer start: it must not cancel the new call.
    if (r.session !== undefined && r.session !== session) return;
    if (r.speaking !== undefined) speaking = connected && r.speaking;
    if (r.connected === undefined) return;
    if (r.connected) {
      const wasConnected = connected;
      connected = true; starting = false;
      if (wasConnected) return;
      touch();
      const cutoff = now() - maxAge;
      const pending = queue.filter((q) => q.at >= cutoff);
      queue = [];
      for (const q of pending) deps.send({ type: 'talk', ...q.talk });
    } else if (connected || starting) {
      stopIdle();
      queue = []; connected = false; speaking = false; starting = false;
      deps.setExpanded(false);
    }
  }

  return { start, end, talk, interrupt, report,
    state: (): SpeakState => ({ connected, speaking, starting }) };
}
export type SpeakController = ReturnType<typeof createSpeakController>;
