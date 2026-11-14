/** PLACEHOLDER (Phase 0): replaced by the renderer track. Subscribes to scenes and acks paints. */
import { useEffect, useState } from "react";
import type { RenderScene } from "@pointy/shared/overlay/render";

export function OverlayRoot() {
  const [scene, setScene] = useState<RenderScene | null>(null);
  useEffect(() => {
    const api = window.pointyOverlay;
    if (!api) return;
    const off = api.onScene(setScene);
    api.ready();
    return off;
  }, []);
  useEffect(() => {
    if (!scene) return;
    const id = requestAnimationFrame(() => window.pointyOverlay?.painted({ seq: scene.seq, ids: scene.items.map((i) => i.id) }));
    return () => cancelAnimationFrame(id);
  }, [scene]);
  return <div data-items={scene?.items.length ?? 0} />;
}
