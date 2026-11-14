import type { HandObservation, Point3 } from "./events";
import { at } from "./util";

/** two_finger = index + middle extended and held together (V sign apart is "other"). */
export type Pose = "open_palm" | "pointing" | "two_finger" | "fist" | "other";

// MediaPipe hand landmark indices.
const WRIST = 0;
const INDEX_MCP = 5;
const PINKY_MCP = 17;
const FINGERS = {
  index: { pip: 6, tip: 8 },
  middle: { pip: 10, tip: 12 },
  ring: { pip: 14, tip: 16 },
  pinky: { pip: 18, tip: 20 },
} as const;

const RECOGNIZER_MAP: Record<string, Pose | undefined> = {
  Open_Palm: "open_palm",
  Pointing_Up: "pointing",
  Closed_Fist: "fist",
  Thumb_Up: "other",
  Thumb_Down: "other",
  Victory: "other",
  ILoveYou: "other",
  // "None" → fall back to rules
};

function d3(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function isExtended(lm: Point3[], f: { pip: number; tip: number }, ratio: number): boolean {
  return d3(at(lm, WRIST), at(lm, f.tip)) > ratio * d3(at(lm, WRIST), at(lm, f.pip));
}

/**
 * Rule-based pose from landmarks (prefers metric world landmarks).
 * `maxSpread`: index/middle fingertip gap, relative to palm width, below which
 * the two fingers count as "together".
 */
export function ruleBasedPose(hand: HandObservation, ratio: number, maxSpread = 0.5): Pose {
  const lm = hand.worldLandmarks ?? hand.landmarks;
  if (!lm || lm.length < 21) return "other";
  const index = isExtended(lm, FINGERS.index, ratio);
  const middle = isExtended(lm, FINGERS.middle, ratio);
  const ring = isExtended(lm, FINGERS.ring, ratio);
  const pinky = isExtended(lm, FINGERS.pinky, ratio);

  if (index && middle && ring && pinky) return "open_palm";
  if (index && !middle && !ring && !pinky) return "pointing";
  if (index && middle && !ring && !pinky) {
    const spread = d3(at(lm, FINGERS.index.tip), at(lm, FINGERS.middle.tip)) / d3(at(lm, INDEX_MCP), at(lm, PINKY_MCP));
    return spread <= maxSpread ? "two_finger" : "other";
  }
  if (!index && !middle && !ring && !pinky) return "fist";
  return "other";
}

/**
 * MediaPipe's canned label wins when it is confident about a class we know;
 * otherwise (e.g. "None", or pointing sideways) our rules decide.
 */
/**
 * Hysteresis for two fingers: once a hand is in two_finger, it stays there unless the middle
 * finger is clearly folded (ratio `stickyRatio` instead of `ratio`) or the fingers clearly part.
 * Glued fingers often leave the middle one slightly bent, which otherwise flips the hand to
 * "pointing" (mouse) in the middle of a circle.
 */
export interface PoseHysteresis {
  prev: Pose;
  stickyRatio: number;
  /** Max angle (degrees) between index and middle fingers to stay "together". */
  stickyMaxAngle: number;
}

const MIDDLE_MCP = 9;

/** Angle in degrees between index (MCP→tip) and middle (MCP→tip): ~0 when glued, opens in a V. */
function fingerAngle(lm: Point3[]): number {
  const a = at(lm, INDEX_MCP), b = at(lm, FINGERS.index.tip);
  const c = at(lm, MIDDLE_MCP), d = at(lm, FINGERS.middle.tip);
  const u = [b.x - a.x, b.y - a.y, b.z - a.z];
  const v = [d.x - c.x, d.y - c.y, d.z - c.z];
  const dot = u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
  const nu = Math.hypot(u[0]!, u[1]!, u[2]!);
  const nv = Math.hypot(v[0]!, v[1]!, v[2]!);
  if (nu === 0 || nv === 0) return 0;
  return (Math.acos(Math.min(1, Math.max(-1, dot / (nu * nv)))) * 180) / Math.PI;
}

function stillTwoFinger(hand: HandObservation, h: PoseHysteresis): boolean {
  const lm = hand.worldLandmarks ?? hand.landmarks;
  if (!lm || lm.length < 21) return false;
  const index = isExtended(lm, FINGERS.index, h.stickyRatio);
  const middle = isExtended(lm, FINGERS.middle, h.stickyRatio);
  const ring = isExtended(lm, FINGERS.ring, h.stickyRatio);
  const pinky = isExtended(lm, FINGERS.pinky, h.stickyRatio);
  if (!index || !middle || (ring && pinky)) return false;
  // Not the tip gap: a slightly bent middle finger drops its tip, but stays parallel to the index.
  return fingerAngle(lm) <= h.stickyMaxAngle;
}

export function classifyPose(
  hand: HandObservation,
  minScore: number,
  ratio: number,
  maxSpread = 0.5,
  hysteresis?: PoseHysteresis,
): Pose {
  if (hysteresis?.prev === "two_finger" && stillTwoFinger(hand, hysteresis)) return "two_finger";
  // MediaPipe has no "two fingers together" class (it may say Victory or None), so rules decide it first.
  const rule = ruleBasedPose(hand, ratio, maxSpread);
  if (rule === "two_finger") return rule;
  const g = hand.gesture;
  if (g && g.score >= minScore) {
    const mapped = RECOGNIZER_MAP[g.name];
    if (mapped) return mapped;
  }
  return rule;
}

/** Debounces a noisy per-frame pose into a stable one. */
export class PoseTracker {
  stable: Pose = "other";
  stableSince = 0;
  private candidate: Pose = "other";
  private candidateSince = 0;

  constructor(private stableMs: number) {}

  /** Forget the pose (used when a hand comes back after being gone). */
  reset(): void {
    this.stable = "other";
    this.candidate = "other";
    this.stableSince = 0;
    this.candidateSince = 0;
  }

  update(pose: Pose, t: number): Pose {
    if (pose !== this.candidate) {
      this.candidate = pose;
      this.candidateSince = t;
    }
    if (this.candidate !== this.stable && t - this.candidateSince >= this.stableMs) {
      this.stable = this.candidate;
      this.stableSince = this.candidateSince;
    }
    return this.stable;
  }
}
