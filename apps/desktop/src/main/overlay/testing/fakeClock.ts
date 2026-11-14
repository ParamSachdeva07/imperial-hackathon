import type { BoundsProvider, ElementBounds } from "@pointy/shared/overlay";
import type { Clock, TimerHandle } from "../clock";

interface Timer {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
}

/** Deterministic Clock for tests. `advance(ms)` runs due timers in order, including nested ones. */
export class FakeClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, Timer>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { id, at: this.t + Math.max(0, ms), seq: id, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.timers.values()) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq)) next = timer;
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = target;
  }
}

/** Controllable BoundsProvider. Each element is a value, null (missing) or an Error (rejects). */
export class FakeBoundsProvider implements BoundsProvider {
  readonly elements = new Map<string, ElementBounds | null | Error>();
  readonly calls: string[] = [];
  private listeners = new Set<() => void>();
  /** When set, getBounds waits on this promise before answering. */
  gate: Promise<void> | null = null;

  set(id: string, value: ElementBounds | null | Error): void {
    this.elements.set(id, value);
  }

  async getBounds(elementId: string): Promise<ElementBounds | null> {
    this.calls.push(elementId);
    if (this.gate) await this.gate;
    const v = this.elements.get(elementId) ?? null;
    if (v instanceof Error) throw v;
    return v;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  fireChange(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** Let pending promise continuations run. */
export async function flushPromises(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
