import type { HandObservation, Point3 } from "./events";

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
  return d3(lm[WRIST], lm[f.tip]) > ratio * d3(lm[WRIST], lm[f.pip]);
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
    const spread = d3(lm[FINGERS.index.tip], lm[FINGERS.middle.tip]) / d3(lm[INDEX_MCP], lm[PINKY_MCP]);
    return spread <= maxSpread ? "two_finger" : "other";
  }
  if (!index && !middle && !ring && !pinky) return "fist";
  return "other";
}

/**
 * MediaPipe's canned label wins when it is confident about a class we know;
 * otherwise (e.g. "None", or pointing sideways) our rules decide.
 */
export function classifyPose(hand: HandObservation, minScore: number, ratio: number, maxSpread = 0.5): Pose {
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
