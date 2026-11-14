/**
 * OverlayManager (spec §5.2): annotation state, visibility rules and history. No rendering.
 * STUB (Phase 0): implemented by the logic track.
 *
 * Rules applied when an annotation becomes visible (add without pending, or reveal):
 *  1. A new `highlight` replaces every visible/pending highlight → dismissed reason "replaced".
 *  2. A new `show_steps` replaces every visible/pending step set → "replaced".
 *  3. Max `maxVisible` (3) visible annotations; a step set counts as one. While over the limit,
 *     the oldest visible non-step annotation is dismissed → "evicted".
 *  Dismissed annotations move to state "exiting" (the service fades them, then calls remove()).
 *  "exiting" and "pending" annotations never count toward the visible limit.
 *
 * Pending (cue-gated) annotations: added with `pending: true`; reveal(cueId) makes every pending
 * annotation with that cue visible (applying the rules above, oldest first); endTurn() drops
 * pending annotations.
 *
 * History: every add() records `{ toolName, input }` in the current set; endTurn() pushes the
 * current set (if non-empty) onto history, keeping the last `historySize` (5) sets. lastSet()
 * returns the most recent pushed set (newest last within the set), or null.
 */
import type { Rect } from "@pointy/shared/overlay";
import type { ToolName } from "@pointy/shared/overlay";

export type AnnotationState = "pending" | "visible" | "exiting";

export interface Annotation {
  id: string;
  toolName: ToolName;
  /** Parsed tool input. */
  input: unknown;
  resolvedBounds: Rect | null;
  displayId: string | null;
  state: AnnotationState;
  createdAt: number;
  turnId?: string | undefined;
  cue?: string | undefined;
}

export interface NewAnnotation {
  id: string;
  toolName: ToolName;
  input: unknown;
  resolvedBounds: Rect | null;
  displayId: string | null;
  turnId?: string | undefined;
  cue?: string | undefined;
  /** Cue-gated: resolved and laid out but hidden until reveal(cue). */
  pending?: boolean;
}

export interface Dismissal {
  id: string;
  reason: "replaced" | "evicted";
}

export interface HistoryEntry {
  toolName: ToolName;
  input: unknown;
}

export interface OverlayManagerOptions {
  maxVisible?: number;
  historySize?: number;
  now?: () => number;
}

export class OverlayManager {
  private readonly maxVisible: number;
  private readonly historySize: number;
  private readonly now: () => number;
  private readonly items = new Map<string, Annotation>();
  private idCounter = 0;
  private currentSet: HistoryEntry[] = [];
  private history: HistoryEntry[][] = [];

  constructor(opts: OverlayManagerOptions = {}) {
    this.maxVisible = opts.maxVisible ?? 3;
    this.historySize = opts.historySize ?? 5;
    this.now = opts.now ?? Date.now;
  }

  /** Unique id with a readable prefix, e.g. nextId("hl") → "hl_1". */
  nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter}`;
  }

  add(a: NewAnnotation): { annotation: Annotation; dismissed: Dismissal[] } {
    const annotation: Annotation = {
      id: a.id,
      toolName: a.toolName,
      input: a.input,
      resolvedBounds: a.resolvedBounds,
      displayId: a.displayId,
      state: a.pending ? "pending" : "visible",
      createdAt: this.now(),
      turnId: a.turnId,
      cue: a.cue,
    };
    // Re-adding an id replaces the old record (and moves it to the end).
    this.items.delete(a.id);
    this.items.set(a.id, annotation);
    this.currentSet.push({ toolName: a.toolName, input: a.input });
    const dismissed = a.pending ? [] : this.applyRules(annotation);
    return { annotation, dismissed };
  }

  reveal(cueId: string): { revealed: Annotation[]; dismissed: Dismissal[] } {
    const revealed: Annotation[] = [];
    const dismissed: Dismissal[] = [];
    const pending = [...this.items.values()].filter((x) => x.state === "pending" && x.cue === cueId);
    for (const a of pending) {
      a.state = "visible";
      dismissed.push(...this.applyRules(a, new Set(pending)));
      revealed.push(a);
    }
    return { revealed, dismissed };
  }

  get(id: string): Annotation | undefined {
    return this.items.get(id);
  }

  /** All annotations, oldest first. */
  all(): Annotation[] {
    return [...this.items.values()];
  }

  visible(): Annotation[] {
    return this.all().filter((a) => a.state === "visible");
  }

  update(id: string, patch: Partial<Pick<Annotation, "resolvedBounds" | "displayId" | "input">>): void {
    const a = this.items.get(id);
    if (!a) return;
    if (patch.resolvedBounds !== undefined) a.resolvedBounds = patch.resolvedBounds;
    if (patch.displayId !== undefined) a.displayId = patch.displayId;
    if (patch.input !== undefined) a.input = patch.input;
  }

  /** visible|pending → exiting. Returns false if unknown or already exiting. */
  beginExit(id: string): boolean {
    const a = this.items.get(id);
    if (!a || a.state === "exiting") return false;
    a.state = "exiting";
    return true;
  }

  /** Forget an annotation entirely (after its exit animation). */
  remove(id: string): void {
    this.items.delete(id);
  }

  /** Drop pending annotations (returns their ids) and push the current history set. */
  endTurn(): string[] {
    const dropped: string[] = [];
    for (const a of [...this.items.values()]) {
      if (a.state === "pending") {
        dropped.push(a.id);
        this.items.delete(a.id);
      }
    }
    if (this.currentSet.length > 0) {
      this.history.push(this.currentSet);
      if (this.history.length > this.historySize) {
        this.history.splice(0, this.history.length - this.historySize);
      }
      this.currentSet = [];
    }
    return dropped;
  }

  lastSet(): HistoryEntry[] | null {
    const last = this.history[this.history.length - 1];
    return last ? last.map((e) => ({ ...e })) : null;
  }

  /** Apply replace/evict rules for an annotation that just became visible. Members of the same reveal `batch` are not replaced while still pending (later ones replace earlier ones as they are revealed). */
  private applyRules(added: Annotation, batch: ReadonlySet<Annotation> = new Set()): Dismissal[] {
    const dismissed: Dismissal[] = [];
    if (added.toolName === "highlight" || added.toolName === "show_steps") {
      for (const o of this.items.values()) {
        if (o === added || (batch.has(o) && o.state === "pending") || o.toolName !== added.toolName || o.state === "exiting") continue;
        o.state = "exiting";
        dismissed.push({ id: o.id, reason: "replaced" });
      }
    }
    for (;;) {
      const visible = this.visible();
      if (visible.length <= this.maxVisible) break;
      const victim = visible.find((o) => o !== added && o.toolName !== "show_steps");
      if (!victim) break;
      victim.state = "exiting";
      dismissed.push({ id: victim.id, reason: "evicted" });
    }
    return dismissed;
  }
}
