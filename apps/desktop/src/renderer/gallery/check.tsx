/** `?check=1`: renders every scene and compares real DOM sizes with measure.ts (never overflow). */
import { createRoot } from "react-dom/client";
import { CARD, LABEL } from "@pointy/shared/overlay/measure";
import { theme } from "@pointy/shared/overlay/theme";
import { OverlayScene } from "../overlay/OverlayScene";
import { ALL_SCENES } from "./scenes";

export interface CheckRow {
  scene: string;
  kind: "label" | "card";
  text: string;
  box: string;
  /** Height the DOM actually needs (px). */
  needed: number;
  /** Height measure.ts allotted (px). */
  allotted: number;
  /** allotted - needed; negative means overflow. */
  slack: number;
  lines: number;
  overflow: boolean;
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export async function runCheck(): Promise<{ rows: CheckRow[]; overflows: number }> {
  const stage = document.createElement("div");
  stage.className = "check-stage";
  document.body.appendChild(stage);
  const rows: CheckRow[] = [];
  for (const g of ALL_SCENES) {
    const host = document.createElement("div");
    stage.appendChild(host);
    const root = createRoot(host);
    root.render(<OverlayScene scene={g.scene} reduceMotion />);
    await frame();
    await frame();
    host.querySelectorAll<HTMLElement>('[data-measure="label"]').forEach((el) => {
      const text = el.querySelector<HTMLElement>(".label-text")!;
      const needed = text.offsetHeight + 2 * LABEL.padY + 2 * theme.outline;
      const allotted = el.offsetHeight;
      // A single unbreakable run can also overflow sideways.
      const wide = text.scrollWidth > text.clientWidth + 1;
      rows.push({
        scene: g.name,
        kind: "label",
        text: el.dataset.text ?? "",
        box: `${el.offsetWidth}x${allotted}`,
        needed,
        allotted,
        slack: allotted - needed,
        lines: Math.round(text.offsetHeight / (LABEL.fontSize * 1.25)),
        overflow: allotted < needed || wide,
      });
    });
    host.querySelectorAll<HTMLElement>('[data-measure="card"]').forEach((el) => {
      const flow = el.querySelector<HTMLElement>(".card-flow")!;
      const needed = flow.offsetHeight + 2 * CARD.pad;
      const allotted = el.offsetHeight;
      const sideways = flow.scrollWidth > flow.clientWidth + 1;
      rows.push({
        scene: g.name,
        kind: "card",
        text: el.querySelector(".card-title")?.textContent ?? "",
        box: `${el.offsetWidth}x${allotted}`,
        needed,
        allotted,
        slack: allotted - needed,
        lines: 0,
        overflow: allotted < needed || sideways,
      });
    });
    root.unmount();
    host.remove();
  }
  stage.remove();
  return { rows, overflows: rows.filter((r) => r.overflow).length };
}

export async function showCheck(): Promise<void> {
  const result = await runCheck();
  const out = document.createElement("div");
  out.className = "check-out";
  out.textContent =
    `overflows: ${result.overflows} / ${result.rows.length}\n` +
    result.rows.map((r) => `${r.overflow ? "OVERFLOW" : "ok      "} ${r.kind} ${r.scene.padEnd(26)} ${r.box.padEnd(9)} slack=${String(r.slack).padStart(4)} lines=${r.lines} ${r.text.slice(0, 50)}`).join("\n");
  document.body.appendChild(out);
  (window as unknown as { __check: unknown }).__check = result;
  document.documentElement.dataset.ready = "1";
}
