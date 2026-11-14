/**
 * Synthetic hands for `POINTY_GESTURES_SELFTEST=1`: exercises the whole Electron pipeline
 * (hidden window → interpreter → IPC → controller → system mouse) without a camera.
 * Script: open palm (wake) → one finger moves then holds (click) → two fingers move then hold
 * (point) → fist drags (scroll) → hand leaves.
 */
import type { FrameObservation, HandObservation, Point3 } from "../../src/events";
import type { FrameSource } from "../../src/electron/renderer";

const blank = (x: number, y: number): Point3[] => Array.from({ length: 21 }, () => ({ x, y, z: 0 }));

/** Open palm; `upright = false` = fingers sideways (doesn't count as a raised hand). */
function palm(x: number, y: number, upright = true): HandObservation {
  const lm = blank(x, y);
  lm[12] = upright ? { x, y: y - 0.2, z: 0 } : { x: x + 0.2, y, z: 0 };
  return { label: "Right", landmarks: lm, gesture: { name: "Open_Palm", score: 0.9 } };
}

function oneFinger(x: number, y: number): HandObservation {
  const lm = blank(0.5, y + 0.2);
  lm[8] = { x, y, z: 0 };
  lm[9] = { x: 0.5, y: y + 0.1, z: 0 };
  lm[10] = { x: 0.5, y: y + 0.08, z: 0 };
  lm[12] = { x: 0.5, y: y + 0.14, z: 0 }; // middle finger folded
  return { label: "Right", landmarks: lm, gesture: { name: "Pointing_Up", score: 0.9 } };
}

function twoFingers(x: number, y: number): HandObservation {
  const lm = blank(x, y + 0.2);
  lm[0] = { x, y: y + 0.25, z: 0 };
  lm[5] = { x: x - 0.03, y: y + 0.17, z: 0 };
  lm[17] = { x: x + 0.04, y: y + 0.17, z: 0 };
  lm[6] = { x: x - 0.005, y: y + 0.12, z: 0 };
  lm[8] = { x: x - 0.005, y, z: 0 };
  lm[10] = { x: x + 0.005, y: y + 0.12, z: 0 };
  lm[12] = { x: x + 0.005, y, z: 0 };
  lm[14] = { x: x + 0.02, y: y + 0.15, z: 0 };
  lm[16] = { x: x + 0.02, y: y + 0.21, z: 0 };
  lm[18] = { x: x + 0.035, y: y + 0.15, z: 0 };
  lm[20] = { x: x + 0.035, y: y + 0.21, z: 0 };
  return { label: "Right", landmarks: lm, gesture: { name: "None", score: 0.6 } };
}

function fist(x: number, y: number): HandObservation {
  const lm = blank(x, y);
  lm[0] = { x, y: y + 0.1, z: 0 };
  return { label: "Right", landmarks: lm, gesture: { name: "Closed_Fist", score: 0.9 } };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, Math.max(0, k));

/** Script step: [duration ms, hands at progress k (0..1)]. */
const SCRIPT: [number, (k: number) => HandObservation[]][] = [
  [1500, () => []], // let the launcher finish starting (mouse, feedback window)
  [1300, () => [palm(0.5, 0.5)]], // wake
  [400, () => []],
  [900, (k) => [oneFinger(lerp(0.6, 0.4, k), 0.4)]], // mouse moves
  [1500, () => [oneFinger(0.4, 0.4)]], // hold → click
  [400, () => []],
  [900, (k) => [twoFingers(lerp(0.6, 0.45, k), 0.35)]], // draw cursor moves
  [1300, () => [twoFingers(0.45, 0.35)]], // hold → point selected
  [400, () => []],
  [700, (k) => [fist(0.5, lerp(0.3, 0.5, k))]], // scroll
  [600, () => [palm(0.5, 0.5, false)]], // hand opens where the fist was (ends drag, no wake)
  [800, () => []],
];

export const SELFTEST_DURATION_MS = SCRIPT.reduce((s, [d]) => s + d, 0);

export function selfTestSource(): FrameSource {
  let start = -1;
  return (t): FrameObservation | null => {
    if (start < 0) start = t;
    let elapsed = t - start;
    for (const [dur, hands] of SCRIPT) {
      if (elapsed < dur) return { t, hands: hands(elapsed / dur) };
      elapsed -= dur;
    }
    return { t, hands: [] };
  };
}
