/** CSS custom properties generated from the shared theme + measure constants. CSS never hardcodes these. */
import type { CSSProperties } from "react";
import { ANATOMY_IMAGE_H, CARD, COMPARE_COL, COMPARE_IMAGE_H, CONCEPT_IMAGE_H, LABEL, LINE_HEIGHT } from "@pointy/shared/overlay/measure";
import { theme } from "@pointy/shared/overlay/theme";

const px = (n: number) => `${n}px`;
const ms = (n: number) => `${n}ms`;

export const themeVars: Record<string, string> = {
  "--font": theme.font.family,
  "--label-weight": String(theme.font.labelWeight),
  "--title-weight": String(theme.font.titleWeight),
  "--stroke": px(theme.stroke),
  "--outline": px(theme.outline),
  "--info": theme.colors.info,
  "--warning": theme.colors.warning,
  "--success": theme.colors.success,
  "--label-bg": theme.colors.labelBg,
  "--label-text": theme.colors.labelText,
  "--outline-color": theme.colors.outline,
  "--card-bg": theme.colors.cardBg,
  "--card-text": theme.colors.cardText,
  "--card-muted": theme.colors.cardMutedText,
  "--card-panel-bg": theme.colors.cardPanelBg,
  "--spotlight-dim": theme.spotlightDim,
  "--label-size": px(LABEL.fontSize),
  "--label-pad-x": px(LABEL.padX),
  "--label-pad-y": px(LABEL.padY),
  "--label-glyph": px(LABEL.glyph),
  "--line-height": String(LINE_HEIGHT),
  "--card-pad": px(CARD.pad),
  "--card-gap": px(CARD.gap),
  "--card-title-size": px(CARD.titleSize),
  "--card-body-size": px(CARD.bodySize),
  "--card-row-gap": px(CARD.rowGap),
  "--card-tile": px(CARD.tile),
  "--card-num": px(CARD.num),
  "--card-num-gap": px(CARD.numGap),
  "--card-bullet": px(CARD.bullet),
  "--card-bullet-gap": px(CARD.bulletGap),
  "--card-body-lh": px(CARD.bodyLineHeight),
  "--card-title-lh": px(CARD.titleLineHeight),
  "--compare-col": px(COMPARE_COL),
  "--compare-image-h": px(COMPARE_IMAGE_H),
  "--anatomy-image-h": px(ANATOMY_IMAGE_H),
  "--concept-image-h": px(CONCEPT_IMAGE_H),
  "--enter-ms": ms(theme.anim.enterMs),
  "--exit-ms": ms(theme.anim.exitMs),
  "--move-ms": ms(theme.anim.moveMs),
  "--step-glide-ms": ms(theme.anim.stepGlideMs),
  "--pulse-ms": ms(theme.anim.pulseMs),
  "--pulse-count": String(theme.anim.pulseCount),
  "--easing": theme.anim.easing,
  "--card-enter-scale": String(theme.anim.cardEnterScale),
  "--pointer-size": px(theme.pointerSize),
};

export const themeStyle = themeVars as CSSProperties;
