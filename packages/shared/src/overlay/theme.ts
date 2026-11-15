/**
 * Visual design tokens (spec §3). Everything visual reads from here.
 * Legible, high-contrast, calm and slow, but light on the screen: marks are thin so they never hide the UI they point at. Never flash.
 * Never rely on colour alone: every tone pairs its colour with an icon or number.
 */
import type { Tone } from "./schemas";

export const theme = {
  font: {
    family: 'system-ui, -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
    /** Weight for labels. */
    labelWeight: 600,
    titleWeight: 700,
  },
  /** Minimum font sizes in px. */
  fontMin: {
    /** Labels sit on top of the UI, so they are kept small. */
    label: 18,
    cardBody: 24,
    cardTitle: 28,
  },
  /** Stroke width (px) for rings, arrows, underlines. */
  stroke: 3,
  /** White outer outline (px) on every shape and label, so it is visible on any background. */
  outline: 1.5,
  colors: {
    info: "#2563EB",
    warning: "#F59E0B",
    success: "#16A34A",
    /** #111827 at 88% opacity. */
    labelBg: "rgba(17, 24, 39, 0.88)",
    labelBgHex: "#111827",
    labelBgOpacity: 0.88,
    labelText: "#FFFFFF",
    outline: "#FFFFFF",
    /** Explainer card background (dark). */
    cardBg: "rgba(17, 24, 39, 0.96)",
    cardText: "#FFFFFF",
    cardMutedText: "#D1D5DB",
    cardPanelBg: "#1F2937",
  },
  spotlightDim: "rgba(0, 0, 0, 0.6)",
  anim: {
    enterMs: 450,
    exitMs: 300,
    /** ease-out */
    easing: "cubic-bezier(0.0, 0.0, 0.2, 1)",
    pulseCount: 3,
    /** Duration of one pulse cycle; slow and calm. */
    pulseMs: 1400,
    /** Anchor-follow animation when a tracked element moves (spec §5.4). */
    moveMs: 150,
    /** Step guides: the ring + label glide from a finished step to the next one (calm, ease-in-out). */
    stepGlideMs: 450,
    /** Card entry starts from this scale (spec §7.1). */
    cardEnterScale: 0.96,
  },
  /** Length (px) of the pointer arrow, tail to tip. */
  pointerSize: 96,
  /** Diameter (px) of the small, faint "next step" hint on step guides (one step at a time). */
  stepHintSize: 32,
  cardMaxWidth: 520,
  edgeMargin: 24,
  /** When true: no glides or pulses, just fade in. Overridden at runtime by settings / OS preference. */
  reduceMotion: false,
} as const;

export type Theme = typeof theme;


/**
 * Icon glyph paired with each tone, so colour is never the only signal.
 * Rendered as SVG in the overlay; these names map to `IconName` / built-in glyphs.
 */
export const toneGlyph: Record<Tone, "info" | "warning" | "check"> = {
  info: "info",
  warning: "warning",
  success: "check",
};
