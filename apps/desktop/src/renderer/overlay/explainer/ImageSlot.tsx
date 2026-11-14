import { useState, type CSSProperties } from "react";
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
  // A ready image that fails to decode (corrupt file / bad response) falls back like a failed one.
  const [broken, setBroken] = useState<string | null>(null);
  const effective: Slot =
    slot.status === "ready" && broken === slot.src ? { status: "failed", fallbackIcon: "photo" } : slot;
  return (
    <div className={`slot slot-${effective.status}`} data-slot={effective.status} style={style}>
      {effective.status === "ready" ? (
        <img
          className={`slot-img fit-${fit}`}
          src={effective.src}
          alt=""
          draggable={false}
          onError={() => setBroken(effective.src)}
        />
      ) : (
        <>
          {effective.status === "loading" ? <div className="shimmer" /> : null}
          <div className="slot-icon">
            <Icon
              name={effective.fallbackIcon}
              size={effective.status === "failed" ? 128 : 96}
              strokeWidth={effective.status === "failed" ? 3.5 : 3}
            />
          </div>
        </>
      )}
      {children}
    </div>
  );
}
