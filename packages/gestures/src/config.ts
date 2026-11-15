/**
 * Every threshold lives here. These are starting values to tune with real
 * users (especially older adults: slower, shakier movements).
 */
export interface ActiveZone {
  /** Rectangle of the (mirrored) camera frame mapped to the full display, normalized. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The two finger poses that can be assigned to drawing/selection and to the system mouse. */
export type FingerPose = "pointing" | "two_finger";

export interface GestureConfig {
  /** Pose that draws, selects points and circles regions (cursor_moved, point_selected, region_selected). */
  drawPose: FingerPose;
  /** Pose that drives the real system mouse ("mouse" events). Must differ from drawPose. */
  mousePose: FingerPose;

  /** Mirror the camera horizontally (selfie view). */
  mirror: boolean;
  activeZone: ActiveZone;

  /* Pose classification */
  /** Minimum MediaPipe gesture score to trust its label over our rules. */
  recognizerMinScore: number;
  /** Finger counted as extended if |wrist→tip| > ratio · |wrist→pip|. */
  fingerExtendRatio: number;
  /** A pose must persist this long before it counts (anti-flicker). */
  poseStableMs: number;
  /** Index/middle tip gap ÷ palm width below which two fingers count as "together". */
  twoFingerMaxSpread: number;
  /** Once in two-finger mode, the middle finger only counts as folded below this ratio (hysteresis). */
  twoFingerStickyRatio: number;
  /** …and the fingers only count as apart above this angle (degrees) between them. */
  twoFingerStickyMaxAngle: number;

  /* Wake (flow 1) */
  wakeHoldMs: number;
  /** After a wake, the palm must be gone this long before another wake can fire. */
  wakeRearmMs: number;
  /** The wrist must be above this normalized image y (0 = top) to count as "raised". */
  wakeMaxWristY: number;
  /** Require fingers pointing up (middle fingertip above the wrist by this normalized margin). */
  wakeRequireUpright: boolean;
  wakeUprightMin: number;
  /** The hold restarts if the wrist drifts more than this (normalized) — rejects head-scratching. */
  wakeMaxMotion: number;

  /* Cursor smoothing (One Euro filter, in display points and seconds) */
  oneEuroMinCutoff: number;
  oneEuroBeta: number;
  oneEuroDCutoff: number;
  /**
   * Cursor "string" (DIP): the mouse and the drawing cursor only move once the filtered finger is
   * more than this far from them, then follow it. Removes the residual tremor at rest (precise aim,
   * steady dwell) so the filter itself can be lighter (less lag). 0 = off.
   */
  cursorDeadband: number;

  /* Hold / selection (flows 2 and 3) */
  /** Window used to measure cursor speed. */
  speedWindowMs: number;
  /** Below this speed (pt/s) the finger counts as still. */
  dwellSpeed: number;
  /** Above this speed the finger counts as moving again (hysteresis). */
  moveSpeed: number;
  /** Hold duration that confirms a selection. */
  dwellMs: number;
  /**
   * A drag whose longer side is at least this many points selects the rectangle between where the
   * drag began and where the hold happens; anything smaller selects the held point.
   */
  rectMinSize: number;

  /** Pointing hand absent this long → hand_lost. */
  lostMs: number;
  /**
   * Switching between the draw and mouse poses within this delay continues from the
   * previous position (no jump) instead of re-mapping the finger absolutely.
   */
  handoffMs: number;
  /** A handoff offset shrinks by a factor e for every this-many points the finger moves (no visible slide when still). */
  handoffDecayDist: number;
  /** Keep the cursor / mouse going while its pose is briefly unrecognised (blur, fingers drifting). */
  poseGraceMs: number;
  /**
   * When mouse mode ends (fist, other gesture, hand gone), put the mouse back where it was this
   * long before the hand was last seen in mouse pose: the frames just before were following the
   * index finger as it curled or dropped.
   */
  mouseRewindMs: number;

  /* Dwell click (mouse mode) */
  clickEnabled: boolean;
  /** Hold still this long in mouse mode to click. */
  clickDwellMs: number;
  /** The mouse must move this far (points) from the start / last click before it can click again. */
  clickArmDist: number;

  /* Scroll (closed fist drag) */
  /** Page movement per display point of hand movement. */
  scrollGain: number;
  /** Accumulate movement until it exceeds this many points, to ignore tremor. */
  scrollDeadzone: number;
  /** Keep dragging while the fist is briefly unrecognised (motion blur) for up to this long. */
  scrollGraceMs: number;
  /** Lighter smoothing than the cursor: dragging needs responsiveness more than precision. */
  scrollMinCutoff: number;
  scrollBeta: number;
}

export const DEFAULT_CONFIG: GestureConfig = {
  drawPose: "two_finger",
  mousePose: "pointing",

  mirror: true,
  // Top edge at 20 % of the image: reaching the top of the screen (browser tabs) mustn't
  // require raising the hand above the head, where tracking is lost. Bottom edge at 65 %: the
  // taskbar is reached before the wrist leaves the frame.
  activeZone: { x0: 0.15, y0: 0.2, x1: 0.85, y1: 0.65 },

  recognizerMinScore: 0.6,
  fingerExtendRatio: 1.15,
  poseStableMs: 120,
  twoFingerMaxSpread: 0.5,
  twoFingerStickyRatio: 1.0,
  twoFingerStickyMaxAngle: 12,

  wakeHoldMs: 700,
  wakeRearmMs: 500,
  wakeMaxWristY: 0.9,
  wakeRequireUpright: true,
  wakeUprightMin: 0.08,
  wakeMaxMotion: 0.04,

  // Simulated against the previous 1.0 / 0.01 / 1.0 without deadband: a bit less lag, ~3-5x less
  // jitter at rest, dwell more reliable when tracking is noisy, no bias once still.
  oneEuroMinCutoff: 1.0,
  oneEuroBeta: 0.02,
  oneEuroDCutoff: 2.0,
  cursorDeadband: 8,

  speedWindowMs: 120,
  dwellSpeed: 60,
  moveSpeed: 160,
  dwellMs: 800,
  rectMinSize: 40,

  lostMs: 300,
  handoffMs: 1500,
  handoffDecayDist: 250,
  poseGraceMs: 300,
  mouseRewindMs: 250,

  clickEnabled: true,
  clickDwellMs: 1000,
  clickArmDist: 40,

  scrollGain: 1.0,
  scrollDeadzone: 3,
  scrollGraceMs: 400,
  scrollMinCutoff: 3.0,
  scrollBeta: 0.02,
};

export function makeConfig(overrides: Partial<GestureConfig> = {}): GestureConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    activeZone: { ...DEFAULT_CONFIG.activeZone, ...overrides.activeZone },
  };
}
