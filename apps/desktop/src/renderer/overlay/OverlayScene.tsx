/** Pure rendering of one RenderScene (shared by the real overlay window and the gallery). */
import type { RenderScene } from "@pointy/shared/overlay/render";
import { CardView } from "./explainer/Card";
import { HighlightView } from "./HighlightView";
import { PointerView } from "./primitives/Pointer";
import { StepsView } from "./primitives/StepBadges";
import { allKeyframesCss } from "./pointerTimeline";
import { themeStyle } from "./tokens";

const KEYFRAMES = allKeyframesCss();

export function OverlayScene({ scene, reduceMotion }: { scene: RenderScene; reduceMotion: boolean }) {
  const { x, y } = scene.display.bounds;
  return (
    <div
      className={`overlay-root${reduceMotion ? " reduce" : ""}`}
      data-seq={scene.seq}
      data-display={scene.display.id}
      style={{ ...themeStyle, transform: `translate(${-x}px, ${-y}px)` }}
    >
      <style>{KEYFRAMES}</style>
      {scene.items.map((item) => {
        switch (item.kind) {
          case "highlight":
            return <HighlightView key={item.id} item={item} display={scene.display.bounds} />;
          case "pointer":
            return <PointerView key={item.id} item={item} />;
          case "steps":
            return <StepsView key={item.id} item={item} />;
          case "explainer":
            return <CardView key={item.id} item={item} />;
        }
      })}
    </div>
  );
}
