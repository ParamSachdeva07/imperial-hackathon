/**
 * Pointer choreography as data. Each stop is (time, where, press scale). Keyframes are generated
 * from this so the whole demo is one CSS animation per element (no JS timers).
 * Positions are symbolic and resolved through CSS variables set per pointer.
 */
import type { PointerItem } from "@pointy/shared/overlay/render";
import { theme } from "@pointy/shared/overlay/theme";

export type Motion = PointerItem["motion"];
export type Place = "entry" | "tap" | "dragEnd" | "rest";
type Ease = "out" | "inout";

export interface Stop {
  t: number;
  at: Place;
  /** 1 = idle, <1 = pressed. */
  scale: number;
  /** Easing of the segment that ARRIVES at this stop. */
  ease: Ease;
}

const PRESSED = 0.82;
const REST_GLIDE_MS = 700;

class Builder {
  stops: Stop[] = [{ t: 0, at: "entry", scale: 1, ease: "out" }];
  private t = 0;
  private at: Place = "entry";
  private scale = 1;

  go(at: Place, scale: number, ms: number, ease: Ease = "inout"): this {
    this.t += ms;
    this.at = at;
    this.scale = scale;
    this.stops.push({ t: this.t, at, scale, ease });
    return this;
  }

  stay(ms: number): this {
    return this.go(this.at, this.scale, ms);
  }

  /** A press and release on the tap point. */
  press(downMs: number, upMs: number): this {
    return this.go("tap", PRESSED, downMs).go("tap", 1, upMs);
  }
}

export function timelineFor(motion: Motion): Stop[] {
  const b = new Builder().go("tap", 1, theme.anim.enterMs, "out");
  if (motion === "tap") {
    b.stay(400);
    for (let i = 0; i < 2; i++) b.press(350, 350).stay(500);
  } else if (motion === "double_tap") {
    b.stay(400);
    for (let i = 0; i < 2; i++) b.press(110, 110).stay(90).press(110, 110).stay(700);
  } else {
    for (let loop = 0; loop < 2; loop++) {
      b.stay(300).go("tap", PRESSED, 300).go("dragEnd", PRESSED, 900).go("dragEnd", 1, 300).stay(400);
      if (loop === 0) b.go("tap", 1, 600);
    }
  }
  return b.go("rest", 1, REST_GLIDE_MS, "out").stops;
}

export const totalMs = (motion: Motion): number => timelineFor(motion).at(-1)?.t ?? 0;

const EASE: Record<Ease, string> = { out: "cubic-bezier(0, 0, 0.2, 1)", inout: "cubic-bezier(0.4, 0, 0.2, 1)" };
const pct = (t: number, total: number) => `${Math.round((t / total) * 10000) / 100}%`;

/** CSS for the keyframe sets of one motion: position, press scale and opacity. */
export function keyframesCss(motion: Motion): string {
  const stops = timelineFor(motion);
  const total = stops.at(-1)?.t ?? 1;
  const easeAfter = (i: number) => EASE[stops[i + 1]?.ease ?? "inout"];
  const pos = stops
    .map(
      (s, i) =>
        `${pct(s.t, total)}{transform:translate(var(--p-${s.at}-x),var(--p-${s.at}-y)) rotate(var(--p-angle));animation-timing-function:${easeAfter(i)}}`,
    )
    .join("");
  const press = stops.map((s, i) => `${pct(s.t, total)}{transform:scale(${s.scale});animation-timing-function:${easeAfter(i)}}`).join("");
  const fade = `0%{opacity:0}${pct(Math.min(250, total), total)}{opacity:1}100%{opacity:1}`;
  return `@keyframes ptr-pos-${motion}{${pos}}@keyframes ptr-press-${motion}{${press}}@keyframes ptr-fade-${motion}{${fade}}`;
}

export const allKeyframesCss = (): string => (["tap", "double_tap", "drag_to"] as const).map(keyframesCss).join("\n");
