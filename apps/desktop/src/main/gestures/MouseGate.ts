/**
 * Attaches the (async) system mouse only while the gesture session is active. Pure: the attach
 * function is injected. Handles attach() resolving after the session already closed (detaches at once).
 */
export type AttachMouse = () => Promise<() => void>;

export interface MouseGateSession {
  isActive(): boolean;
  onChange(cb: (active: boolean) => void): () => void;
}

export function gateMouseToSession(
  session: MouseGateSession,
  attach: AttachMouse,
  log: (msg: string) => void = () => {},
): () => void {
  let detach: (() => void) | null = null;
  let generation = 0; // bumps on every open/close so stale async attaches are discarded

  const open = () => {
    if (detach) return;
    const gen = ++generation;
    attach().then(
      (d) => {
        if (gen !== generation || !session.isActive()) {
          d();
          return;
        }
        detach = d;
        log("system mouse attached");
      },
      (err: unknown) => log(`system mouse attach failed: ${String(err)}`),
    );
  };
  const close = () => {
    generation++;
    if (detach) {
      const d = detach;
      detach = null;
      d();
      log("system mouse detached");
    }
  };

  const off = session.onChange((a) => (a ? open() : close()));
  if (session.isActive()) open();
  return () => {
    off();
    close();
  };
}
