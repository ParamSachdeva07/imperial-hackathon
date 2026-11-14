/**
 * Deterministic size estimates for labels and explainer cards, so the main process can run the
 * LayoutEngine before anything is rendered. The renderer lays content out to exactly these sizes.
 *
 * Owned by the renderer track: keep these in sync with the CSS in renderer/overlay.
 */
import type { ExplainerSpec } from "./schemas";
import type { Size } from "./render";
import { theme } from "./theme";

/** Average glyph advance for the system UI font at weight 600, as a fraction of font size. */
export const AVG_CHAR_WIDTH = 0.56;
export const LINE_HEIGHT = 1.25;

export const LABEL = {
  fontSize: theme.fontMin.label,
  padX: 20,
  padY: 12,
  /** Width reserved for the tone glyph (icon + gap). */
  glyph: 36,
  maxWidth: 440,
} as const;

/** Estimated wrapped line count for `text` in a box `width` px wide. */
export function lineCount(text: string, fontSize: number, width: number): number {
  const charsPerLine = Math.max(1, Math.floor(width / (fontSize * AVG_CHAR_WIDTH)));
  const words = text.split(/\s+/).filter(Boolean);
  let lines = 1;
  let used = 0; // chars used on the current line
  for (const word of words) {
    const needed = used === 0 ? word.length : used + 1 + word.length;
    if (needed <= charsPerLine) {
      used = needed;
      continue;
    }
    // Start a new line (unless this is the first word), then hard-wrap words longer than a line.
    if (used > 0) lines += 1;
    lines += Math.floor((word.length - 1) / charsPerLine);
    used = ((word.length - 1) % charsPerLine) + 1;
  }
  return lines;
}

export function textWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * AVG_CHAR_WIDTH);
}

/** Size of a label box including padding and the 3 px white outline. */
export function measureLabel(text: string, withGlyph = false): Size {
  const glyph = withGlyph ? LABEL.glyph : 0;
  const chrome = 2 * LABEL.padX + 2 * theme.outline + glyph;
  const natural = textWidth(text, LABEL.fontSize) + chrome;
  const width = Math.min(LABEL.maxWidth, natural);
  const lines = lineCount(text, LABEL.fontSize, width - chrome);
  const height = Math.ceil(lines * LABEL.fontSize * LINE_HEIGHT) + 2 * LABEL.padY + 2 * theme.outline;
  return { width, height };
}

export const CARD = {
  width: theme.cardMaxWidth,
  pad: 24,
  titleSize: theme.fontMin.cardTitle,
  bodySize: theme.fontMin.label,
  gap: 16,
} as const;

function titleHeight(title: string): number {
  const inner = CARD.width - 2 * CARD.pad;
  return Math.ceil(lineCount(title, CARD.titleSize, inner) * CARD.titleSize * LINE_HEIGHT);
}

function bodyLines(text: string, width: number): number {
  return lineCount(text, CARD.bodySize, width);
}

const lh = (lines: number) => Math.ceil(lines * CARD.bodySize * LINE_HEIGHT);

/** Unscaled design size of an explainer card. Width is always cardMaxWidth. */
export function measureCard(title: string, spec: ExplainerSpec): Size {
  const inner = CARD.width - 2 * CARD.pad;
  let body = 0;
  switch (spec.kind) {
    case "sequence": {
      // Row of icons + arrows, then numbered captions listed underneath (readable at 24 px).
      const iconRow = 96;
      const captions = spec.steps.reduce((sum, s) => sum + lh(bodyLines(s.caption, inner - 44)) + 8, 0);
      body = iconRow + CARD.gap + captions;
      break;
    }
    case "compare": {
      const col = (inner - CARD.gap) / 2;
      const side = (s: { title: string; points: string[]; imagePrompt?: string | undefined }) =>
        (s.imagePrompt ? Math.round(col * 0.75) + CARD.gap : 0) +
        lh(bodyLines(s.title, col)) +
        8 +
        s.points.reduce((sum, p) => sum + lh(bodyLines(p, col - 36)) + 8, 0);
      body = Math.max(side(spec.left), side(spec.right));
      break;
    }
    case "anatomy": {
      const image = Math.round(inner * 0.62);
      const legend = spec.callouts.reduce((sum, c) => sum + lh(bodyLines(c.label, inner - 52)) + 8, 0);
      body = image + CARD.gap + legend;
      break;
    }
    case "concept": {
      const panels = spec.panels.reduce(
        (sum, p) => sum + Math.round(inner * 0.56) + 8 + lh(bodyLines(p.caption, inner)) + CARD.gap,
        0,
      );
      body = panels - CARD.gap;
      break;
    }
  }
  return { width: CARD.width, height: CARD.pad + titleHeight(title) + CARD.gap + body + CARD.pad };
}
