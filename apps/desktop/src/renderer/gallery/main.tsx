import { createRoot } from "react-dom/client";
import { OverlayScene } from "../overlay/OverlayScene";
import "../overlay/overlay.css";
import "./gallery.css";
import { showCheck } from "./check";
import { Desktop } from "./Desktop";
import { ALL_SCENES, SCENES, findScene } from "./scenes";

/**
 * `?scene=<name>&bg=light|dark&t=<ms>`: t freezes every animation at that time (deterministic
 * screenshots). `?check=1`: measure.ts vs real DOM report. No params: index of scenes.
 */
function freeze(t: number): void {
  document.getAnimations().forEach((a) => {
    a.pause();
    a.currentTime = t;
  });
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function boot() {
  const root = document.getElementById("root")!;
  const params = new URLSearchParams(location.search);
  if (params.get("check")) {
    await showCheck();
    return;
  }
  const g = findScene(params.get("scene") ?? "");
  if (!g) {
    root.className = "index";
    createRoot(root).render(
      <div>
        {SCENES.map((s) => (
          <a key={s.name} href={`?scene=${s.name}&bg=light`}>
            {s.name}: {s.title}
          </a>
        ))}
        <p style={{ color: "#fff" }}>{ALL_SCENES.length} scenes. Add &bg=dark and &t=ms.</p>
      </div>,
    );
    document.documentElement.dataset.ready = "1";
    return;
  }
  const bg = params.get("bg") === "dark" ? "dark" : "light";
  const tParam = params.get("t");
  createRoot(root).render(
    <Desktop bg={bg} targets={g.targets}>
      <OverlayScene scene={g.scene} reduceMotion={g.scene.reduceMotion} />
    </Desktop>,
  );
  await frame();
  await frame();
  if (tParam !== null) {
    freeze(Number(tParam));
    await frame();
  }
  document.documentElement.dataset.ready = "1";
}

void boot();
