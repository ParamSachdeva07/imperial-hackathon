/**
 * Keeps image bytes (data URLs of concept/compare pictures and anatomy crops, often 100 KB–several
 * MB) out of the per-publish RenderScene. Main swaps each `data:` src for a short key and sends the
 * bytes to each window once; the renderer swaps them back. Pure, shared by both sides.
 */
import type { ExplainerBody, ImageSlot, RenderItem } from "./render";

export const IMAGE_KEY_PREFIX = "pointy-image:";

/** Map every ready ImageSlot `src` in the items through `fn` (returns new objects; input untouched). */
export function mapImageSrcs(items: RenderItem[], fn: (src: string) => string): RenderItem[] {
  const slot = (s: ImageSlot): ImageSlot => (s.status === "ready" ? { ...s, src: fn(s.src) } : s);
  const body = (b: ExplainerBody): ExplainerBody => {
    switch (b.kind) {
      case "concept":
        return { ...b, panels: b.panels.map((p) => ({ ...p, image: slot(p.image) })) };
      case "compare":
        return {
          ...b,
          left: { ...b.left, image: b.left.image ? slot(b.left.image) : null },
          right: { ...b.right, image: b.right.image ? slot(b.right.image) : null },
        };
      case "anatomy":
        return { ...b, image: slot(b.image) };
      case "sequence":
        return b;
    }
  };
  return items.map((it) => (it.kind === "explainer" ? { ...it, body: body(it.body) } : it));
}

/** Main side: assigns stable keys to data URLs and tracks which keys are referenced. */
export class ImageKeyRegistry {
  private keyBySrc = new Map<string, string>();
  private srcByKey = new Map<string, string>();
  private next = 1;

  /** Replace data URLs with keys; returns the keyed items and the keys they reference. */
  externalize(items: RenderItem[]): { items: RenderItem[]; keys: Set<string> } {
    const keys = new Set<string>();
    const out = mapImageSrcs(items, (src) => {
      if (!src.startsWith("data:")) return src;
      let key = this.keyBySrc.get(src);
      if (!key) {
        key = `${IMAGE_KEY_PREFIX}${this.next++}`;
        this.keyBySrc.set(src, key);
        this.srcByKey.set(key, src);
      }
      keys.add(key);
      return key;
    });
    return { items: out, keys };
  }

  src(key: string): string | undefined {
    return this.srcByKey.get(key);
  }

  /** Forget keys no longer referenced; returns the dropped keys. */
  prune(referenced: Set<string>): string[] {
    const dropped: string[] = [];
    for (const [key, src] of this.srcByKey) {
      if (referenced.has(key)) continue;
      this.srcByKey.delete(key);
      this.keyBySrc.delete(src);
      dropped.push(key);
    }
    return dropped;
  }
}

/** Renderer side: put the bytes back (unknown keys become a "loading"-looking empty src). */
export function rehydrateImages(items: RenderItem[], lookup: (key: string) => string | undefined): RenderItem[] {
  return mapImageSrcs(items, (src) => (src.startsWith(IMAGE_KEY_PREFIX) ? (lookup(src) ?? "") : src));
}
