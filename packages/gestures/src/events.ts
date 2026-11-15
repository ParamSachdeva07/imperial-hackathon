/**
 * Contract between the gesture interpreter and the Electron session controller.
 *
 * Coordinates are in logical display points (Electron DIP), relative to the
 * top-left corner of the display identified by `displayId`. Converting to
 * physical pixels (Retina scaleFactor) is the platform adapter's job.
 *
 * `t` is the frame timestamp in milliseconds (performance.now() clock).
 */

/** MediaPipe handedness label. Used as a stable per-hand ID across frames. */
export type HandLabel = "Left" | "Right";

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GestureEvent =
  /** Open palm held long enough. Emitted once per raise (edge-triggered). */
  | {
      type: "wake_requested";
      source: "open_palm";
      hand: HandLabel;
      heldForMs: number;
      t: number;
    }
  /**
   * Raised open palm being held still: wake progress (0..1) for a ring around the hand.
   * Only while the session is closed. progress = 0 means the hold was broken.
   * x/y = where the palm maps on the display.
   */
  | {
      type: "wake_progress";
      hand: HandLabel;
      progress: number;
      x: number;
      y: number;
      displayId: number;
      t: number;
    }
  /** Finger cursor position, every frame while a hand is pointing. */
  | {
      type: "cursor_moved";
      hand: HandLabel;
      x: number;
      y: number;
      /** Where the current drag began: the corner opposite the cursor of the rectangle being dragged out. Absent right after a selection, until the finger moves again. */
      anchor?: { x: number; y: number };
      displayId: number;
      t: number;
    }
  /** Hold progress (0..1) for the UI ring. progress = 0 means the hold was broken. */
  | {
      type: "dwell_progress";
      hand: HandLabel;
      progress: number;
      x: number;
      y: number;
      displayId: number;
      t: number;
    }
  /** Flow 2: the finger stayed still on a point. */
  | {
      type: "point_selected";
      hand: HandLabel;
      x: number;
      y: number;
      displayId: number;
      heldForMs: number;
      t: number;
    }
  /** Flow 3: a closed loop followed by a pause. */
  | {
      type: "region_selected";
      hand: HandLabel;
      polygon: [number, number][];
      bbox: Bbox;
      displayId: number;
      t: number;
    }
  /**
   * Closed fist = "grab the page". dx/dy is how far the page should move with the hand,
   * in display points (drag semantics, like a touchscreen): dy > 0 means the hand moved
   * down, so content moves down, i.e. scroll UP by dy. Only emitted during a session.
   */
  | {
      type: "scroll";
      hand: HandLabel;
      phase: "start" | "move" | "end";
      dx: number;
      dy: number;
      t: number;
    }
  /**
   * Index + middle finger held together: drive the real system mouse.
   * x/y = where the OS cursor should be. Only emitted during a session.
   */
  | {
      type: "mouse";
      hand: HandLabel;
      phase: "start" | "move" | "end";
      x: number;
      y: number;
      displayId: number;
      t: number;
    }
  /** Mouse mode: hold progress (0..1) before a dwell click, for the ring around the mouse. 0 = hold broken. */
  | {
      type: "click_progress";
      hand: HandLabel;
      progress: number;
      x: number;
      y: number;
      displayId: number;
      t: number;
    }
  /** Mouse mode: the finger stayed still long enough → left click at (x, y), where the mouse is. */
  | {
      type: "click";
      hand: HandLabel;
      button: "left";
      x: number;
      y: number;
      displayId: number;
      t: number;
    }
  /** The pointing hand disappeared or stopped pointing. The cursor should be hidden. */
  | {
      type: "hand_lost";
      hand: HandLabel;
      reason: "absent" | "pose_changed";
      t: number;
    };

export type GestureEventType = GestureEvent["type"];

/* ---------- Input side: one camera frame, independent of MediaPipe ---------- */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface HandObservation {
  label: HandLabel;
  /** 21 normalized image landmarks (x, y in [0, 1], origin top-left of the camera frame). */
  landmarks: Point3[];
  /** 21 metric 3D landmarks, if available. Better for pose classification. */
  worldLandmarks?: Point3[];
  /** Top canned gesture from MediaPipe GestureRecognizer, if available. */
  gesture?: { name: string; score: number };
}

export interface FrameObservation {
  t: number;
  hands: HandObservation[];
}

export interface DisplayInfo {
  id: number;
  /** Logical size in DIP. */
  width: number;
  height: number;
}
