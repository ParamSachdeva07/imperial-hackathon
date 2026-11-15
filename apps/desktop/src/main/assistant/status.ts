/** Assistant status + tiny typed emitter. No electron imports. */
export type AssistantStatus = "idle" | "opening" | "listening" | "thinking" | "speaking" | "error";

export class StatusEmitter {
  private value: AssistantStatus = "idle";
  private readonly listeners = new Set<(s: AssistantStatus) => void>();

  get(): AssistantStatus {
    return this.value;
  }

  /** Sets the status; listeners fire only on change. */
  set(next: AssistantStatus): void {
    if (next === this.value) return;
    this.value = next;
    for (const l of [...this.listeners]) l(next);
  }

  onChange(cb: (s: AssistantStatus) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
