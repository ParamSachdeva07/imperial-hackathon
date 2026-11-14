/**
 * Deterministic size estimates for labels and explainer cards, so the main process can run the
 * LayoutEngine before anything is rendered. The renderer lays content out to exactly these sizes
 * (renderer/overlay CSS reads every constant below through tokens.ts).
 *
 * Text widths are estimated, so the estimate is deliberately a little pessimistic: the box may end
 * up a line taller than needed, but text can never overflow. The gallery `?check=1` page compares
 * these numbers with the real DOM.
 */
import type { ExplainerSpec } from "./schemas";
import type { Size } from "./render";
import { theme } from "./theme";

/** Weight 700 text is this much wider than weight 600. */
export const BOLD_FACTOR = 1.07;
/** Safety margin on every width estimate (never under-measure). */
const SAFETY = 1.04;
export const LINE_HEIGHT = 1.25;

/** Advance of one character in em, for the system UI font at weight 600 (SF Pro / Helvetica-like). */
function em(ch: string): number {
  if ("iljI.,:;!'|`".includes(ch)) return 0.32;
  if ("ftr()[]-/ ".includes(ch)) return 0.4;
  if ("mwMW@%".includes(ch)) return ch === "m" || ch === "w" ? 0.88 : 0.98;
  if (ch >= "A" && ch <= "Z") return 0.72;
  if (ch >= "0" && ch <= "9") return 0.6;
  if (ch.charCodeAt(0) > 0x2e80) return 1; // CJK and friends
  return 0.58; // lowercase default (a-z minus the narrow/wide ones above)
}

/** Estimated width in px of `text` on one line. */
export function textWidth(text: string, fontSize: number, factor = 1): number {
  let w = 0;
  for (const ch of text) w += em(ch);
  return Math.ceil(w * fontSize * factor * SAFETY);
}

export const LABEL = {
  fontSize: theme.fontMin.label,
  padX: 20,
  padY: 12,
  /** Width reserved for the tone glyph (28 px icon + 8 px gap). */
  glyph: 36,
  maxWidth: 440,
} as const;

/**
 * Estimated wrapped line count for `text` in a box `width` px wide: greedy word wrap on pixel
 * widths, hard-wrapping words that are wider than a line (matches `overflow-wrap: anywhere`).
 */
export function lineCount(text: string, fontSize: number, width: number, factor = 1): number {
  const space = textWidth(" ", fontSize, factor);
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = textWidth(word, fontSize, factor);
    const needed = used === 0 ? w : used + space + w;
    if (needed <= width) {
      used = needed;
      continue;
    }
    if (used > 0) lines += 1;
    if (w <= width) {
      used = w;
      continue;
    }
    // Hard wrap: fill lines character by character.
    used = 0;
    for (const ch of word) {
      const cw = textWidth(ch, fontSize, factor);
      if (used + cw > width && used > 0) {
        lines += 1;
        used = 0;
      }
      used += cw;
    }
  }
  return lines;
}

/** Size of a label box including padding and the 3 px white outline. */
export function measureLabel(text: string, withGlyph = false): Size {
  const glyph = withGlyph ? LABEL.glyph : 0;
  const chrome = 2 * LABEL.padX + 2 * theme.outline + glyph;
  const natural = Math.max(textWidth(text, LABEL.fontSize) + chrome, 2 * LABEL.padX + 2 * theme.outline + 28);
  const width = Math.min(LABEL.maxWidth, natural);
  // Text that fits at its natural width is one line by construction (avoids a phantom 2nd line
  // when the per-word wrap estimate disagrees with textWidth by a pixel).
  const lines = natural <= LABEL.maxWidth ? 1 : lineCount(text, LABEL.fontSize, width - chrome);
  const height = Math.ceil(lines * LABEL.fontSize * LINE_HEIGHT) + 2 * LABEL.padY + 2 * theme.outline;
  return { width, height };
}

const BODY = theme.fontMin.label;
const BODY_LH = Math.ceil(BODY * LINE_HEIGHT); // 30
const TITLE_LH = Math.ceil(theme.fontMin.cardTitle * LINE_HEIGHT); // 35

export const CARD = {
  width: theme.cardMaxWidth,
  pad: 24,
  titleSize: theme.fontMin.cardTitle,
  bodySize: BODY,
  bodyLineHeight: BODY_LH,
  titleLineHeight: TITLE_LH,
  gap: 16,
  /** Gap between stacked list rows (captions, bullets, legend). */
  rowGap: 8,
  /** Sequence icon tile edge. */
  tile: 72,
  /** Numbered circle (caption numbers, legend numbers). */
  num: 30,
  numGap: 12,
  /** Bullet glyph (✓ / ⚠) plus gap. */
  bullet: 28,
  bulletGap: 8,
} as const;

export const CARD_INNER = CARD.width - 2 * CARD.pad;
export const COMPARE_COL = (CARD_INNER - CARD.gap) / 2;
export const COMPARE_IMAGE_H = Math.round(COMPARE_COL * 0.75);
export const ANATOMY_IMAGE_H = Math.round(CARD_INNER * 0.62);
export const CONCEPT_IMAGE_H = Math.round(CARD_INNER * 0.56);

const rows = (heights: number[]) => heights.reduce((a, b) => a + b, 0) + CARD.rowGap * Math.max(0, heights.length - 1);
const textH = (text: string, width: number, size: number = BODY, lh: number = BODY_LH, cw: number = 1) =>
  lineCount(text, size, width, cw) * lh;

export const captionTextWidth = CARD_INNER - CARD.num - CARD.numGap;
export const bulletTextWidth = COMPARE_COL - CARD.bullet - CARD.bulletGap;

interface Side {
  title: string;
  points: string[];
  imagePrompt?: string | undefined;
}

export function compareSideHeight(s: Side, hasImage = Boolean(s.imagePrompt)): number {
  const head = textH(s.title, COMPARE_COL, BODY, BODY_LH, BOLD_FACTOR);
  const pts = s.points.length > 0 ? CARD.rowGap + rows(s.points.map((p) => textH(p, bulletTextWidth))) : 0;
  return (hasImage ? COMPARE_IMAGE_H + CARD.gap : 0) + head + pts;
}

/** Unscaled design size of an explainer card. Width is always cardMaxWidth. */
export function measureCard(title: string, spec: ExplainerSpec): Size {
  let body = 0;
  switch (spec.kind) {
    case "sequence":
      body = CARD.tile + CARD.gap + rows(spec.steps.map((s) => textH(s.caption, captionTextWidth)));
      break;
    case "compare":
      body = Math.max(compareSideHeight(spec.left), compareSideHeight(spec.right));
      break;
    case "anatomy":
      body = ANATOMY_IMAGE_H + CARD.gap + rows(spec.callouts.map((c) => textH(c.label, captionTextWidth)));
      break;
    case "concept":
      body =
        spec.panels.reduce((sum, p) => sum + CONCEPT_IMAGE_H + CARD.rowGap + textH(p.caption, CARD_INNER), 0) +
        CARD.gap * (spec.panels.length - 1);
      break;
  }
  const titleH = textH(title, CARD_INNER, CARD.titleSize, TITLE_LH, BOLD_FACTOR);
  return { width: CARD.width, height: CARD.pad + titleH + CARD.gap + body + CARD.pad };
}
