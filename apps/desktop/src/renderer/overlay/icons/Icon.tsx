/** Inline SVG icons (48x48 grid, stroke based, inherit `currentColor`). Never rely on external assets. */
import type { ReactNode } from "react";
import type { IconName } from "@pointy/shared/overlay/schemas";

export type GlyphName = IconName | "info";

const paths: Record<GlyphName, ReactNode> = {
  click: <path d="M14 7v30l8-7 5 11 6-3-5-11h11z" />,
  type: (
    <>
      <rect x="4" y="12" width="40" height="25" rx="4" />
      <path d="M11 20h2M19 20h2M27 20h2M35 20h2M11 28h2M35 28h2M18 29h12" />
    </>
  ),
  folder: <path d="M5 13a2 2 0 0 1 2-2h12l4 5h18a2 2 0 0 1 2 2v21a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />,
  file: <path d="M12 5h17l9 9v28a1 1 0 0 1-1 1H12a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM29 5v10h9M17 25h14M17 32h14" />,
  photo: (
    <>
      <rect x="5" y="8" width="38" height="32" rx="4" />
      <circle cx="17" cy="19" r="3.5" />
      <path d="M5 34l12-11 8 8 6-6 12 11" />
    </>
  ),
  email: (
    <>
      <rect x="5" y="10" width="38" height="28" rx="4" />
      <path d="M6 13l18 14 18-14" />
    </>
  ),
  attach: <path d="M34 22L22 34a6 6 0 0 1-8.5-8.5L27 12a4 4 0 0 1 5.7 5.7L19.2 31.2a2 2 0 0 1-2.8-2.8L27 18" />,
  send: <path d="M5 22L43 6 34 42 23 28zM23 28L43 6" />,
  search: (
    <>
      <circle cx="20" cy="20" r="12" />
      <path d="M29 29l12 12" />
    </>
  ),
  settings: (
    <>
      <circle cx="24" cy="24" r="16.5" strokeWidth="6" strokeDasharray="6.5 6.5" />
      <circle cx="24" cy="24" r="12" />
      <circle cx="24" cy="24" r="5" />
    </>
  ),
  wifi: (
    <>
      <path d="M5 19a28 28 0 0 1 38 0M11 26a19 19 0 0 1 26 0M17 33a10 10 0 0 1 14 0" />
      <circle cx="24" cy="40" r="1.5" />
    </>
  ),
  cloud: <path d="M13 37a8 8 0 0 1 0-16 12 12 0 0 1 23 2 7 7 0 0 1-1 14z" />,
  lock: (
    <>
      <rect x="10" y="22" width="28" height="20" rx="4" />
      <path d="M16 22v-6a8 8 0 0 1 16 0v6M24 29v6" />
    </>
  ),
  warning: <path d="M24 6L44 40H4zM24 18v11M24 35v.5" />,
  check: <path d="M8 25l11 11L40 13" />,
  trash: <path d="M8 12h32M18 12V6h12v6M12 12l2 30h20l2-30M20 20v14M28 20v14" />,
  download: <path d="M24 6v26M13 22l11 11 11-11M8 41h32" />,
  printer: <path d="M13 17V6h22v11M13 34H7V17h34v17h-6M13 27h22v15H13z" />,
  phone: (
    <>
      <rect x="13" y="4" width="22" height="40" rx="5" />
      <path d="M21 38h6" />
    </>
  ),
  video: (
    <>
      <rect x="4" y="12" width="28" height="24" rx="4" />
      <path d="M32 21l12-7v20l-12-7z" />
    </>
  ),
  person: (
    <>
      <circle cx="24" cy="15" r="8" />
      <path d="M8 42a16 14 0 0 1 32 0" />
    </>
  ),
  info: (
    <>
      <circle cx="24" cy="24" r="18" />
      <path d="M24 22v13M24 14v.5" />
    </>
  ),
};

export const ICON_NAMES = Object.keys(paths) as GlyphName[];

export function Icon({ name, size = 48, strokeWidth = 3.5 }: { name: GlyphName; size?: number; strokeWidth?: number }) {
  return (
    <svg
      className="icon"
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
