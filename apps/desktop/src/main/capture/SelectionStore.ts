/** Holds the latest gesture selection snapshot for the AI to pick up (pure). */
import type { SelectionSnapshot } from "@pointy/shared/context/selection";

export class SelectionStore {
  private current: SelectionSnapshot | null = null;
  private readonly snapshotListeners = new Set<(s: SelectionSnapshot) => void>();
  private readonly clearListeners = new Set<() => void>();

  set(snapshot: SelectionSnapshot): void {
    this.current = snapshot;
    for (const cb of [...this.snapshotListeners]) cb(snapshot);
  }

  latest(): SelectionSnapshot | null {
    return this.current;
  }

  /** Returns the latest snapshot and clears it (without notifying clear listeners). */
  consume(): SelectionSnapshot | null {
    const s = this.current;
    this.current = null;
    return s;
  }

  clear(): void {
    if (!this.current) return;
    this.current = null;
    for (const cb of [...this.clearListeners]) cb();
  }

  onSnapshot(cb: (s: SelectionSnapshot) => void): () => void {
    this.snapshotListeners.add(cb);
    return () => this.snapshotListeners.delete(cb);
  }

  onClear(cb: () => void): () => void {
    this.clearListeners.add(cb);
    return () => this.clearListeners.delete(cb);
  }
}

/** Clear the store whenever the gesture session closes. Returns the unsubscribe function. */
export function clearOnSessionClose(store: SelectionStore, source: { onSession(cb: (active: boolean) => void): () => void }): () => void {
  return source.onSession((active) => {
    if (!active) store.clear();
  });
}
