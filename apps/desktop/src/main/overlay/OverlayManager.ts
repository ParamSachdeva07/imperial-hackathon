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
  constructor(_opts: OverlayManagerOptions = {}) {}

  /** Unique id with a readable prefix, e.g. nextId("hl") → "hl_1". */
  nextId(_prefix: string): string {
    throw new Error("not implemented: OverlayManager.nextId");
  }

  add(_a: NewAnnotation): { annotation: Annotation; dismissed: Dismissal[] } {
    throw new Error("not implemented: OverlayManager.add");
  }

  reveal(_cueId: string): { revealed: Annotation[]; dismissed: Dismissal[] } {
    throw new Error("not implemented: OverlayManager.reveal");
  }

  get(_id: string): Annotation | undefined {
    throw new Error("not implemented: OverlayManager.get");
  }

  /** All annotations, oldest first. */
  all(): Annotation[] {
    throw new Error("not implemented: OverlayManager.all");
  }

  visible(): Annotation[] {
    throw new Error("not implemented: OverlayManager.visible");
  }

  update(_id: string, _patch: Partial<Pick<Annotation, "resolvedBounds" | "displayId" | "input">>): void {
    throw new Error("not implemented: OverlayManager.update");
  }

  /** visible|pending → exiting. Returns false if unknown or already exiting. */
  beginExit(_id: string): boolean {
    throw new Error("not implemented: OverlayManager.beginExit");
  }

  /** Forget an annotation entirely (after its exit animation). */
  remove(_id: string): void {
    throw new Error("not implemented: OverlayManager.remove");
  }

  /** Drop pending annotations (returns their ids) and push the current history set. */
  endTurn(): string[] {
    throw new Error("not implemented: OverlayManager.endTurn");
  }

  lastSet(): HistoryEntry[] | null {
    throw new Error("not implemented: OverlayManager.lastSet");
  }
}
