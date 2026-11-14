/** Subscribes to scenes from main, renders them, and acks first paints of new item ids. */
import { useEffect, useRef, useState } from "react";
import type { RenderScene } from "@pointy/shared/overlay/render";
import { OverlayScene } from "./OverlayScene";

function usePrefersReducedMotion(): boolean {
  const [pref, setPref] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setPref(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return pref;
}

export function OverlayRoot() {
  const [scene, setScene] = useState<RenderScene | null>(null);
  const prefersReduced = usePrefersReducedMotion();
  const painted = useRef(new Set<string>());

  useEffect(() => {
    const api = window.pointyOverlay;
    if (!api) return;
    const off = api.onScene(setScene);
    api.ready();
    return off;
  }, []);

  useEffect(() => {
    if (!scene) return;
    const seen = painted.current;
    const present = new Set(scene.items.map((i) => i.id));
    for (const id of seen) if (!present.has(id)) seen.delete(id);
    const fresh = scene.items.map((i) => i.id).filter((id) => !seen.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.add(id);
    let raf2 = 0;
    let fired = false;
    // Two frames: the first lets React commit and the browser paint the new DOM, the second confirms it.
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        fired = true;
        window.pointyOverlay?.painted({ seq: scene.seq, ids: fresh });
      });
    });
    return () => {
      // A newer scene arrived before this paint: hand its ids back so they are acked with the next one.
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (!fired) for (const id of fresh) seen.delete(id);
    };
  }, [scene]);

  if (!scene) return <div data-items={0} />;
  return <OverlayScene scene={scene} reduceMotion={scene.reduceMotion || prefersReduced} />;
}
