/** Pure decision logic for production.ts, extracted so it can be unit tested without Electron. */

export interface ScrollEventLike {
  type: string;
  phase?: string;
}

/**
 * Whether a gesture event should invalidate coordinate annotations: a fist scroll that really scrolls the page
 * (the real mouse is attached) moves content under any screenshot-derived drawing. Fires on scroll end, and
 * throttled on move so a long scroll does not leave stale marks on screen.
 */
export function createScrollInvalidator(opts: { mouseAttached: () => boolean; now: () => number; throttleMs?: number }): (e: ScrollEventLike) => boolean {
  const throttle = opts.throttleMs ?? 400;
  let last = -Infinity;
  return (e) => {
    if (e.type !== "scroll" || !opts.mouseAttached()) return false;
    const t = opts.now();
    if (e.phase === "end") {
      last = t;
      return true;
    }
    if (e.phase === "move" && t - last >= throttle) {
      last = t;
      return true;
    }
    return false;
  };
}

/**
 * before-quit guard: the first quit is cancelled while `close` (with a timeout) runs, then `quit` is called
 * again and let through. Returns true when the caller must preventDefault and stop its own teardown.
 */
export function createQuitGuard(opts: { close: () => Promise<void>; timeoutMs?: number; quit: () => void }): () => boolean {
  let state: "idle" | "closing" | "done" = "idle";
  return () => {
    if (state === "done") return false;
    if (state === "closing") return true;
    state = "closing";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, opts.timeoutMs ?? 2000)));
    void Promise.race([opts.close().catch(() => undefined), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
      state = "done";
      opts.quit();
    });
    return true;
  };
}
