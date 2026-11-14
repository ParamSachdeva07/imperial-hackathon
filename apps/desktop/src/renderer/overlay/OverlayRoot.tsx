/** Subscribes to scenes from main, renders them, and acks first paints of new item ids. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RenderItem, RenderScene } from "@pointy/shared/overlay/render";
import type { Rect } from "@pointy/shared/overlay/schemas";
import { intersects } from "@pointy/shared/overlay/geometry";
import { rehydrateImages } from "@pointy/shared/overlay/sceneImages";
import { GestureLayer } from "./gesture/GestureLayer";
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

/** Bounds that decide which display an item "is on" (for the overlay.shown ack). */
function itemRects(item: RenderItem): Rect[] {
  switch (item.kind) {
    case "highlight":
      return [item.target.bounds];
    case "pointer":
      return [item.target.bounds];
    case "steps":
      return item.steps.flatMap((s) => (s.target ? [s.target.bounds] : []));
    case "explainer":
      return [item.card];
  }
}

/** Only the window that actually shows an item acks its paint (multi-display). */
export function isOnThisDisplay(item: RenderItem, display: Rect): boolean {
  return itemRects(item).some((r) => intersects(r, display));
}

export function OverlayRoot() {
  const [raw, setScene] = useState<RenderScene | null>(null);
  const images = useRef(new Map<string, string>());
  const [imageVersion, setImageVersion] = useState(0);
  const prefersReduced = usePrefersReducedMotion();
  const painted = useRef(new Set<string>());

  useEffect(() => {
    const api = window.pointyOverlay;
    if (!api) return;
    const offScene = api.onScene(setScene);
    const offImage = api.onImage(({ key, src }) => {
      images.current.set(key, src);
      setImageVersion((v) => v + 1);
    });
    const offDrop = api.onImageDrop(({ keys }) => {
      for (const k of keys) images.current.delete(k);
    });
    api.ready();
    return () => {
      offScene();
      offImage();
      offDrop();
    };
  }, []);

  // Put image bytes (sent once, by key) back into the scene.
  const scene = useMemo(
    () => (raw ? { ...raw, items: rehydrateImages(raw.items, (k) => images.current.get(k)) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- imageVersion signals new bytes in the ref
    [raw, imageVersion],
  );

  useEffect(() => {
    if (!scene) return;
    const seen = painted.current;
    const present = new Set(scene.items.map((i) => i.id));
    for (const id of seen) if (!present.has(id)) seen.delete(id);
    const fresh = scene.items
      .filter((i) => !seen.has(i.id) && isOnThisDisplay(i, scene.display.bounds))
      .map((i) => i.id);
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
  }, [scene?.seq, scene?.display.bounds]); // eslint-disable-line react-hooks/exhaustive-deps -- re-run per scene, not per image

  // Gesture feedback is its own stream (never part of the scene) and stays mounted across scenes.
  const reduceMotion = Boolean(scene?.reduceMotion) || prefersReduced;
  return (
    <>
      {scene ? <OverlayScene scene={scene} reduceMotion={reduceMotion} /> : <div data-items={0} />}
      <GestureLayer display={scene?.display.bounds ?? null} reduceMotion={reduceMotion} />
    </>
  );
}
