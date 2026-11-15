/**
 * MockBoundsProvider (spec §6): stands in for the accessibility teammate's BoundsProvider.
 * Element rects come from named sources — such as a JSON file — and can be
 * perturbed with simulated moves and removals.
 */
import { readFileSync } from "node:fs";
import type { BoundsProvider, ElementBounds, ElementRect, Rect } from "@pointy/shared/overlay";
import { z } from "zod";

const ElementsFile = z.record(
  z.string(),
  z.object({
    rect: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
    displayId: z.string().optional(),
  }),
);

export class MockBoundsProvider implements BoundsProvider {
  private sources = new Map<string, Map<string, ElementBounds>>();
  private offsets = new Map<string, { dx: number; dy: number }>();
  private removed = new Set<string>();
  private listeners = new Set<() => void>();

  /** @param displayFor resolves a display id for rects without one . */
  constructor(private readonly displayFor: (rect: Rect) => string = () => "0") {}

  /** Replace one source's elements . */
  setSource(name: string, elements: Record<string, { rect: Rect; displayId?: string | undefined }>): void {
    const map = new Map<string, ElementBounds>();
    for (const [id, e] of Object.entries(elements)) map.set(id, { rect: e.rect, displayId: e.displayId ?? this.displayFor(e.rect) });
    this.sources.set(name, map);
    this.changed();
  }

  clearSource(name: string): void {
    if (this.sources.delete(name)) this.changed();
  }

  /** Load `{ "<elementId>": { "rect": {x,y,width,height}, "displayId"?: "..." } }`. */
  loadJsonFile(path: string, sourceName = "json"): void {
    const parsed = ElementsFile.parse(JSON.parse(readFileSync(path, "utf8")));
    this.setSource(sourceName, parsed);
  }

  /** Simulate an element moving by (dx, dy) DIP (cumulative). */
  simMove(elementId: string, dx: number, dy: number): void {
    const o = this.offsets.get(elementId) ?? { dx: 0, dy: 0 };
    this.offsets.set(elementId, { dx: o.dx + dx, dy: o.dy + dy });
    this.changed();
  }

  simRemove(elementId: string): void {
    this.removed.add(elementId);
    this.changed();
  }

  /** Undo simulation for one element, or for all when no id is given. */
  simRestore(elementId?: string): void {
    if (elementId) {
      this.removed.delete(elementId);
      this.offsets.delete(elementId);
    } else {
      this.removed.clear();
      this.offsets.clear();
    }
    this.changed();
  }

  /** Raw (un-simulated) lookup across sources; later sources win. */
  private lookup(elementId: string): ElementBounds | null {
    let found: ElementBounds | null = null;
    for (const src of this.sources.values()) found = src.get(elementId) ?? found;
    return found;
  }

  getBoundsSync(elementId: string): ElementBounds | null {
    if (this.removed.has(elementId)) return null;
    const b = this.lookup(elementId);
    if (!b) return null;
    const o = this.offsets.get(elementId);
    if (!o) return b;
    const rect = { ...b.rect, x: b.rect.x + o.dx, y: b.rect.y + o.dy };
    return { rect, displayId: this.displayFor(rect) };
  }

  async getBounds(elementId: string): Promise<ElementBounds | null> {
    return this.getBoundsSync(elementId);
  }

  /** Every element currently known (after simulation), with its rect — what the AI may point at. */
  listElementRects(): ElementRect[] {
    return this.listElementIds().flatMap((id) => {
      const b = this.getBoundsSync(id);
      return b ? [{ id, rect: b.rect }] : [];
    });
  }

  listElementIds(): string[] {
    const ids = new Set<string>();
    for (const src of this.sources.values()) for (const id of src.keys()) ids.add(id);
    return [...ids].sort();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }
}
