import type { CSSProperties } from "react";
import type { ImageSlot as Slot } from "@pointy/shared/overlay/render";
import { Icon } from "../icons/Icon";

/** Image area: calm shimmer while loading, the picture when ready, a large icon on failure. */
export function ImageSlotView({
  slot,
  fit = "cover",
  style,
  children,
}: {
  slot: Slot;
  fit?: "cover" | "contain";
  style?: CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <div className={`slot slot-${slot.status}`} data-slot={slot.status} style={style}>
      {slot.status === "ready" ? (
        <img className={`slot-img fit-${fit}`} src={slot.src} alt="" draggable={false} />
      ) : (
        <>
          {slot.status === "loading" ? <div className="shimmer" /> : null}
          <div className="slot-icon">
            <Icon name={slot.fallbackIcon} size={slot.status === "failed" ? 128 : 96} strokeWidth={slot.status === "failed" ? 3.5 : 3} />
          </div>
        </>
      )}
      {children}
    </div>
  );
}
