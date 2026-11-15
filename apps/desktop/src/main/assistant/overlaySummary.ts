/** Compact description of what the overlay currently shows, for the model ("[overlays] ..."). Pure. */
import type { Rect, RenderItem, RenderLabel } from "@pointy/shared/overlay";

const r = (n: number) => Math.round(n);
const box = (b: Rect) => `${r(b.x)},${r(b.y)},${r(b.width)},${r(b.height)}`;
// eslint-disable-next-line no-control-regex
const clean =(s: string) => s.replace(/[\u0000-\u001f\u007f|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
const lbl = (l: RenderLabel | null) => (l ? ` "${clean(l.text)}"` : "");

function describe(item: RenderItem): string {
  switch (item.kind) {
    case "highlight":
      return `${item.style}${item.label ? "+label" : ""}${lbl(item.label)} at ${box(item.target.bounds)}`;
    case "pointer":
      return `pointer${lbl(item.label)} at ${box(item.target.bounds)}`;
    case "parts": {
      const n = item.parts.length;
      const first = item.parts[0];
      return `${n} labelled part${n === 1 ? "" : "s"}${item.title ? ` "${clean(item.title.text)}"` : ""}${first ? ` from ${box(first.target.bounds)}` : ""}`;
    }
    case "steps": {
      const cur = item.steps.find((s) => s.status === "current");
      return `step guide (${item.completed ? "done" : `step ${item.current + 1} of ${item.steps.length}`})${cur?.target ? ` at ${box(cur.target.bounds)}` : ""}`;
    }
    case "explainer":
      return `card '${clean(item.title)}' at ${box(item.card)}`;
  }
}

/** One line per overlay state: "[overlays] none visible" or "[overlays] 2 visible: ...; ...". */
export function summarizeOverlays(items: readonly RenderItem[]): string {
  const vis = items.filter((i) => i.state === "visible");
  if (vis.length === 0) return "[overlays] none visible";
  return `[overlays] ${vis.length} visible: ${vis.map(describe).join("; ")}`;
}
