import { describe, expect, it } from "vitest";
import {
  GestureInterpreter,
  OneEuroFilter,
  ruleBasedPose,
  computeActiveZone,
  type FrameObservation,
  type GestureEvent,
  type HandLabel,
  type HandObservation,
  type Point3,
} from "../src/index";
import { at } from "../src/util";

const DISPLAY = { id: 1, width: 1440, height: 900 };
const FPS = 30;
const DT = 1000 / FPS;

function hand(label: HandLabel, gesture: string, tip: { x: number; y: number }, wristY = 0.6): HandObservation {
  const lm: Point3[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: wristY, z: 0 }));
  lm[8] = { x: tip.x, y: tip.y, z: 0 };
  lm[9] = { x: 0.5, y: wristY - 0.1, z: 0 };
  lm[10] = { x: 0.5, y: wristY - 0.12, z: 0 }; // middle PIP
  lm[12] = { x: 0.5, y: wristY - 0.06, z: 0 }; // middle tip folded back (real pointing hand)
  return { label, landmarks: lm, gesture: { name: gesture, score: 0.9 } };
}

/** Open palm with the wrist at (x, y). `upright` = fingers pointing up. */
function palmAt(label: HandLabel, x: number, y: number, upright = true): HandObservation {
  const lm: Point3[] = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  lm[12] = upright ? { x, y: y - 0.2, z: 0 } : { x: x + 0.2, y, z: 0 };
  return { label, landmarks: lm, gesture: { name: "Open_Palm", score: 0.9 } };
}

/** Closed fist with the palm centre at (x, y). */
function fistAt(label: HandLabel, x: number, y: number): HandObservation {
  const lm: Point3[] = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  lm[0] = { x, y: y + 0.1, z: 0 };
  return { label, landmarks: lm, gesture: { name: "Closed_Fist", score: 0.9 } };
}

/**
 * Index + middle extended, ring + pinky curled, image landmarks only
 * (MediaPipe has no label for this, so the recognizer says "None").
 * `gap` = distance between the two fingertips (normalized).
 */
function twoFingersAt(label: HandLabel, x: number, y: number, gap = 0.01): HandObservation {
  const lm: Point3[] = Array.from({ length: 21 }, () => ({ x, y: y + 0.2, z: 0 }));
  lm[0] = { x, y: y + 0.25, z: 0 }; // wrist
  lm[5] = { x: x - 0.03, y: y + 0.17, z: 0 }; // index MCP
  lm[17] = { x: x + 0.04, y: y + 0.17, z: 0 }; // pinky MCP → palm width 0.07
  lm[6] = { x: x - gap / 2, y: y + 0.12, z: 0 };
  lm[8] = { x: x - gap / 2, y, z: 0 };
  lm[10] = { x: x + gap / 2, y: y + 0.12, z: 0 };
  lm[12] = { x: x + gap / 2, y, z: 0 };
  lm[14] = { x: x + 0.02, y: y + 0.15, z: 0 };
  lm[16] = { x: x + 0.02, y: y + 0.21, z: 0 }; // curled
  lm[18] = { x: x + 0.035, y: y + 0.15, z: 0 };
  lm[20] = { x: x + 0.035, y: y + 0.21, z: 0 }; // curled
  return { label, landmarks: lm, gesture: { name: "None", score: 0.6 } };
}

/** Interpreter with the session already open (as after an accepted wake). */
function active(): GestureInterpreter {
  const it = new GestureInterpreter(DISPLAY);
  it.setSessionActive(true);
  return it;
}

/** Runs frames through the interpreter, returns all events. */
function run(interp: GestureInterpreter, frames: FrameObservation[]): GestureEvent[] {
  return frames.flatMap((f) => interp.process(f));
}

/** Builds frames from a per-frame hand generator over `durationMs`, starting at `t0`. */
function frames(t0: number, durationMs: number, gen: (i: number, n: number) => HandObservation[]): FrameObservation[] {
  const n = Math.round(durationMs / DT);
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * DT, hands: gen(i, n) }));
}

const ofType = <T extends GestureEvent["type"]>(evs: GestureEvent[], type: T) =>
  evs.filter((e): e is Extract<GestureEvent, { type: T }> => e.type === type);

describe("wake", () => {
  it("fires once per raise, and re-arms after the palm goes away", () => {
    const it = new GestureInterpreter(DISPLAY);
    const palm = () => [palmAt("Left", 0.5, 0.5)];
    let evs = run(it, frames(0, 2000, palm));
    let wakes = ofType(evs, "wake_requested");
    expect(wakes).toHaveLength(1);
    expect(at(wakes, 0).heldForMs).toBeGreaterThanOrEqual(700);
    expect(at(wakes, 0).t).toBeLessThan(1000);

    run(it, frames(2000, 700, () => [])); // hand lowered
    evs = run(it, frames(2700, 1500, palm));
    wakes = ofType(evs, "wake_requested");
    expect(wakes).toHaveLength(1);
  });

  it("ignores a palm resting low in the frame", () => {
    const it = new GestureInterpreter(DISPLAY);
    const evs = run(it, frames(0, 2000, () => [palmAt("Left", 0.5, 0.97)]));
    expect(ofType(evs, "wake_requested")).toHaveLength(0);
  });

  it("does not wake while a session is already active", () => {
    const evs = run(active(), frames(0, 2000, () => [palmAt("Left", 0.5, 0.5)]));
    expect(ofType(evs, "wake_requested")).toHaveLength(0);
  });

  it("ignores a moving open hand (scratching the head)", () => {
    const it = new GestureInterpreter(DISPLAY);
    const evs = run(
      it,
      frames(0, 4000, (i) => {
        const a = (i / 6) * 2 * Math.PI; // ~5 small circles per second
        return [palmAt("Left", 0.6 + 0.06 * Math.cos(a), 0.3 + 0.06 * Math.sin(a))];
      }),
    );
    expect(ofType(evs, "wake_requested")).toHaveLength(0);
  });

  it("ignores a sideways open hand", () => {
    const it = new GestureInterpreter(DISPLAY);
    const evs = run(it, frames(0, 2000, () => [palmAt("Left", 0.5, 0.5, false)]));
    expect(ofType(evs, "wake_requested")).toHaveLength(0);
  });
});

describe("wake progress (ring around the raised hand)", () => {
  it("fills from 0 to 1 while the palm is held still, then wake fires", () => {
    const it = new GestureInterpreter(DISPLAY);
    const evs = run(it, frames(0, 1500, () => [palmAt("Left", 0.5, 0.5)]));
    const prog = ofType(evs, "wake_progress").map((e) => e.progress);
    expect(prog.length).toBeGreaterThan(10);
    expect(prog.every((p, i) => i === 0 || p >= at(prog, i - 1))).toBe(true); // monotonic
    expect(at(prog, prog.length - 1)).toBe(1);
    const lastProg = ofType(evs, "wake_progress").pop()!;
    const wake = ofType(evs, "wake_requested")[0]!;
    expect(lastProg.t).toBeLessThanOrEqual(wake.t);
    // palm centre maps onto the display
    expect(lastProg.x).toBeGreaterThan(0);
    expect(lastProg.x).toBeLessThan(DISPLAY.width);
  });

  it("a moving hand never completes the ring and the UI is told when it breaks", () => {
    const it = new GestureInterpreter(DISPLAY);
    const evs = run(
      it,
      frames(0, 3000, (i) => {
        const a = (i / 6) * 2 * Math.PI;
        return [palmAt("Left", 0.6 + 0.06 * Math.cos(a), 0.3 + 0.06 * Math.sin(a))];
      }),
    );
    const prog = ofType(evs, "wake_progress").map((e) => e.progress);
    expect(prog.every((p) => p < 1)).toBe(true);
    expect(ofType(evs, "wake_requested")).toHaveLength(0);
  });

  it("lowering the hand mid-hold sends a single progress 0", () => {
    const it = new GestureInterpreter(DISPLAY);
    const evs = run(it, [...frames(0, 450, () => [palmAt("Left", 0.5, 0.5)]), ...frames(450, 600, () => [])]);
    const prog = ofType(evs, "wake_progress");
    expect(at(prog, prog.length - 1).progress).toBe(0);
    expect(prog.filter((e) => e.progress === 0)).toHaveLength(1);
  });

  it("no ring while a session is already open", () => {
    const evs = run(active(), frames(0, 1500, () => [palmAt("Left", 0.5, 0.5)]));
    expect(ofType(evs, "wake_progress")).toHaveLength(0);
  });
});

describe("pointing", () => {
  it("is ignored before the session is open", () => {
    const it = new GestureInterpreter(DISPLAY);
    const evs = run(it, frames(0, 2000, () => [twoFingersAt("Right", 0.5, 0.4)]));
    expect(evs).toHaveLength(0);
  });

  it("moves the cursor, then a steady hold selects a point", () => {
    const it = active();
    // Sweep right for 1 s, then hold still for 1.2 s.
    const move = frames(0, 1000, (i, n) => [twoFingersAt("Right", 0.7 - 0.3 * (i / n), 0.4)]);
    const hold = frames(1000, 1200, () => [twoFingersAt("Right", 0.4, 0.4)]);
    const evs = run(it, [...move, ...hold]);

    expect(ofType(evs, "cursor_moved").length).toBeGreaterThan(50);
    expect(ofType(evs, "region_selected")).toHaveLength(0);
    const pts = ofType(evs, "point_selected");
    expect(pts).toHaveLength(1);
    // x=0.4 mirrored → 0.6 → (0.6-0.15)/0.7·1440 ≈ 926; y=0.4 → (0.4-0.2)/0.5·900 = 360
    expect(at(pts, 0).x).toBeCloseTo(926, -1);
    expect(at(pts, 0).y).toBeCloseTo(360, -1);
    expect(at(pts, 0).displayId).toBe(1);
  });

  it("does not re-select while the finger keeps resting", () => {
    const it = active();
    const evs = run(it, frames(0, 4000, () => [twoFingersAt("Right", 0.5, 0.4)]));
    expect(ofType(evs, "point_selected")).toHaveLength(1);
  });

  it("an open-palm hand never drives the cursor (two hands)", () => {
    const it = new GestureInterpreter(DISPLAY);
    const both = () => [palmAt("Left", 0.2, 0.5), twoFingersAt("Right", 0.6, 0.4)];
    const wake = run(it, frames(0, 1500, both));
    expect(ofType(wake, "wake_requested")).toHaveLength(1);
    it.setSessionActive(true); // controller accepts the wake
    const evs = run(it, frames(1500, 1000, both));
    const cursors = ofType(evs, "cursor_moved");
    expect(cursors.length).toBeGreaterThan(0);
    expect(cursors.every((e) => e.hand === "Right")).toBe(true);
  });

  it("reports hand_lost when the pointing hand disappears", () => {
    const it = active();
    run(it, frames(0, 500, () => [twoFingersAt("Right", 0.5, 0.4)]));
    const evs = run(it, frames(500, 600, () => []));
    const lost = ofType(evs, "hand_lost");
    expect(lost).toHaveLength(1);
    expect(at(lost, 0).reason).toBe("absent");
  });
});

describe("circling", () => {
  it("a closed loop followed by a pause selects a region", () => {
    const it = active();
    const cx = 0.5, cy = 0.4, r = 0.12;
    const loop = frames(0, 2000, (i, n) => {
      const a = (2 * Math.PI * i) / (n - 1);
      return [twoFingersAt("Right", cx + r * Math.cos(a), cy + r * Math.sin(a))];
    });
    const hold = frames(2000, 1200, () => [twoFingersAt("Right", cx + r, cy)]);
    const evs = run(it, [...loop, ...hold]);

    expect(ofType(evs, "point_selected")).toHaveLength(0);
    const regions = ofType(evs, "region_selected");
    expect(regions).toHaveLength(1);
    const { bbox, polygon } = at(regions, 0);
    // radius 0.12 → ≈247 pt horizontally, 216 pt vertically → bbox ≈ 494 × 432
    expect(bbox.width).toBeGreaterThan(400);
    expect(bbox.width).toBeLessThan(560);
    expect(bbox.height).toBeGreaterThan(360);
    expect(bbox.height).toBeLessThan(480);
    expect(polygon.length).toBeGreaterThan(6);
    expect(polygon.length).toBeLessThan(60); // simplified
    // Convex hull → never self-intersecting: every turn has the same orientation.
    const turns = polygon.map((p, i) => {
      const a = at(polygon, (i + 1) % polygon.length), b = at(polygon, (i + 2) % polygon.length);
      return Math.sign((at(a, 0) - p[0]) * (b[1] - p[1]) - (a[1] - p[1]) * (at(b, 0) - p[0]));
    });
    expect(new Set(turns.filter((s) => s !== 0)).size).toBe(1);
  });

  it("a slow square drawn over 7 s still counts", () => {
    const it = active();
    const corners: [number, number][] = [[0.35, 0.25], [0.65, 0.25], [0.65, 0.55], [0.35, 0.55], [0.35, 0.25]];
    const square = frames(0, 7000, (i, n) => {
      const u = (i / (n - 1)) * 4;
      const k = Math.min(3, Math.floor(u));
      const f = u - k;
      const [ax, ay] = at(corners, k), [bx, by] = at(corners, k + 1);
      return [twoFingersAt("Right", ax + f * (bx - ax), ay + f * (by - ay))];
    });
    const hold = frames(7000, 1200, () => [twoFingersAt("Right", 0.35, 0.25)]);
    const evs = run(it, [...square, ...hold]);
    expect(ofType(evs, "region_selected")).toHaveLength(1);
  });

  it("a back-and-forth scribble is not a region", () => {
    const it = active();
    const scribble = frames(0, 2000, (i) => [
      twoFingersAt("Right", 0.4 + 0.15 * Math.abs(Math.sin((i / 15) * Math.PI)), 0.4),
    ]);
    const hold = frames(2000, 1200, () => [twoFingersAt("Right", 0.4, 0.4)]);
    const evs = run(it, [...scribble, ...hold]);
    expect(ofType(evs, "region_selected")).toHaveLength(0);
    expect(ofType(evs, "point_selected")).toHaveLength(1);
  });
});

describe("one finger → system mouse (default mousePose)", () => {
  it("moves the mouse, never draws, and ends when the hand leaves", () => {
    const it = active();
    const move = frames(0, 1000, (i, n) => [hand("Right", "Pointing_Up", { x: 0.6 - 0.2 * (i / (n - 1)), y: 0.4 })]);
    const gone = frames(1000, 500, () => []);
    const evs = run(it, [...move, ...gone]);
    const m = ofType(evs, "mouse");
    expect(at(m, 0).phase).toBe("start");
    expect(at(m, m.length - 1).phase).toBe("end");
    expect(m.filter((e) => e.phase === "move").length).toBeGreaterThan(20);
    // x 0.6→0.4 mirrored → 0.4→0.6 → (u-0.15)/0.7·1440: ≈514 → ≈926; finger moved right on screen
    const moves = m.filter((e) => e.phase === "move");
    expect(at(moves, moves.length - 1).x).toBeGreaterThan(at(moves, 0).x + 250);
    expect(ofType(evs, "cursor_moved")).toHaveLength(0);
    expect(ofType(evs, "point_selected")).toHaveLength(0);
  });

  it("two fingers spread apart (V sign) neither draw nor move the mouse", () => {
    const it = active();
    const evs = run(it, frames(0, 1000, () => [twoFingersAt("Right", 0.5, 0.4, 0.08)]));
    expect(ofType(evs, "mouse")).toHaveLength(0);
    expect(ofType(evs, "cursor_moved")).toHaveLength(0);
  });

  it("switching from one finger to two hands over from mouse to drawing", () => {
    const it = active();
    const one = frames(0, 600, () => [hand("Right", "Pointing_Up", { x: 0.5, y: 0.4 })]);
    const two = frames(600, 600, () => [twoFingersAt("Right", 0.5, 0.4)]);
    const evs = run(it, [...one, ...two]);
    const m = ofType(evs, "mouse");
    expect(at(m, 0).phase).toBe("start");
    expect(at(m, m.length - 1).phase).toBe("end");
    expect(ofType(evs, "cursor_moved").length).toBeGreaterThan(5);
  });

  it("the old mapping is one config flag away", () => {
    const it = new GestureInterpreter(DISPLAY, { drawPose: "pointing", mousePose: "two_finger" });
    it.setSessionActive(true);
    const evs = run(it, frames(0, 800, () => [hand("Right", "Pointing_Up", { x: 0.5, y: 0.4 })]));
    expect(ofType(evs, "cursor_moved").length).toBeGreaterThan(5);
    expect(ofType(evs, "mouse")).toHaveLength(0);
  });

  it("is ignored before the session is open", () => {
    const it = new GestureInterpreter(DISPLAY);
    const evs = run(it, frames(0, 1000, () => [hand("Right", "Pointing_Up", { x: 0.5, y: 0.4 })]));
    expect(evs).toHaveLength(0);
  });
});

describe("closing the fist doesn't drag the mouse away", () => {
  it("the index curling down (still read as Pointing_Up) doesn't move the mouse; scroll starts where it was", () => {
    const it = active();
    const tip = (y: number) => [hand("Right", "Pointing_Up", { x: 0.5, y })];
    const evs = run(it, [
      ...frames(0, 800, (i, n) => [hand("Right", "Pointing_Up", { x: 0.6 - 0.1 * (i / (n - 1)), y: 0.4 })]),
      ...frames(800, 400, () => tip(0.4)), // still: mouse settles
      // closing: MediaPipe still says Pointing_Up while the fingertip drops 0.15 (≈225 pt)
      ...frames(1200, 170, (i, n) => tip(0.4 + 0.15 * (i / (n - 1)))),
      ...frames(1370, 800, () => [fistAt("Right", 0.5, 0.55)]),
    ]);
    const before = ofType(evs, "mouse").filter((e) => e.t < 1200).pop()!;
    const end = ofType(evs, "mouse").find((e) => e.phase === "end")!;
    expect(Math.hypot(end.x - before.x, end.y - before.y)).toBeLessThan(3); // put back where it was
    expect(ofType(evs, "scroll")[0]!.phase).toBe("start");
  });

  it("raw-pose freeze: a hand that stops looking like one finger stops moving the mouse at once", () => {
    const it = active();
    const evs = run(it, [
      ...frames(0, 800, () => [hand("Right", "Pointing_Up", { x: 0.5, y: 0.4 })]),
      // the fist forms (classified Closed_Fist) while the hand drifts: before the pose is confirmed,
      // the mouse must not follow
      ...frames(800, 100, (i, n) => [fistAt("Right", 0.5, 0.45 + 0.1 * (i / (n - 1)))]),
    ]);
    const moves = ofType(evs, "mouse").filter((e) => e.t >= 800 && e.phase === "move");
    expect(moves).toHaveLength(0);
  });
});

describe("handoff between mouse and drawing", () => {
  // Realistic switch: the index tip stays put, the middle finger joins it,
  // so the two-finger midpoint is ~0.015 (≈31 pt) away from the index tip.
  const tipX = 0.5, tipY = 0.4, gap = 0.03;
  const oneFinger = () => [hand("Right", "Pointing_Up", { x: tipX, y: tipY })];
  const twoFingers = () => [twoFingersAt("Right", tipX + gap / 2, tipY, gap)];

  it("mouse → draw: the drawing cursor starts exactly where the mouse was", () => {
    const it = active();
    const evs = run(it, [...frames(0, 600, oneFinger), ...frames(600, 600, twoFingers)]);
    const mouseEnd = ofType(evs, "mouse").find((e) => e.phase === "end")!;
    const firstCursor = at(ofType(evs, "cursor_moved"), 0);
    expect(Math.hypot(firstCursor.x - mouseEnd.x, firstCursor.y - mouseEnd.y)).toBeLessThan(1);
  });

  it("draw → mouse: the mouse starts exactly where the drawing cursor was", () => {
    const it = active();
    const evs = run(it, [...frames(0, 600, twoFingers), ...frames(600, 600, oneFinger)]);
    const cursors = ofType(evs, "cursor_moved");
    const lastCursor = at(cursors, cursors.length - 1);
    const mouseStart = at(ofType(evs, "mouse"), 0);
    expect(mouseStart.phase).toBe("start");
    expect(Math.hypot(mouseStart.x - lastCursor.x, mouseStart.y - lastCursor.y)).toBeLessThan(1);
  });

  it("after a pause longer than handoffMs, mapping is absolute again", () => {
    const it = active();
    const evs = run(it, [...frames(0, 600, oneFinger), ...frames(600, 2000, () => []), ...frames(2600, 600, twoFingers)]);
    const mouseEnd = ofType(evs, "mouse").find((e) => e.phase === "end")!;
    const firstCursor = at(ofType(evs, "cursor_moved"), 0);
    // midpoint is 0.015 left of the tip in the mirrored image → ≈31 pt away
    expect(Math.abs(firstCursor.x - mouseEnd.x)).toBeGreaterThan(20);
    // and the returning two-finger hand never moved the mouse
    expect(ofType(evs, "mouse").filter((e) => e.t > 2600)).toHaveLength(0);
  });

  it("a slow switch through an in-between pose (0.8 s) still hands over", () => {
    const it = active();
    const inBetween = () => [twoFingersAt("Right", tipX + 0.04, tipY, 0.08)]; // V sign = "other"
    const evs = run(it, [...frames(0, 600, oneFinger), ...frames(600, 800, inBetween), ...frames(1400, 600, twoFingers)]);
    const mouseEnd = ofType(evs, "mouse").find((e) => e.phase === "end")!;
    const firstCursor = at(ofType(evs, "cursor_moved"), 0);
    expect(Math.hypot(firstCursor.x - mouseEnd.x, firstCursor.y - mouseEnd.y)).toBeLessThan(1);
  });
});

describe("dwell click (mouse mode)", () => {
  const finger = (x: number, y = 0.4) => [hand("Right", "Pointing_Up", { x, y })];
  const sweep = (t0: number, from: number, to: number, ms = 800) =>
    frames(t0, ms, (i, n) => finger(from + (to - from) * (i / (n - 1))));

  it("move, then hold still ~1 s → exactly one left click where the mouse is", () => {
    const it = active();
    const evs = run(it, [...sweep(0, 0.4, 0.6), ...frames(800, 1500, () => finger(0.6))]);
    const clicks = ofType(evs, "click");
    expect(clicks).toHaveLength(1);
    const lastMouse = ofType(evs, "mouse").filter((e) => e.t <= at(clicks, 0).t).pop()!;
    expect(Math.hypot(at(clicks, 0).x - lastMouse.x, at(clicks, 0).y - lastMouse.y)).toBeLessThan(1);
    const prog = ofType(evs, "click_progress").map((e) => e.progress);
    expect(at(prog, prog.length - 1)).toBe(1);
    expect(at(clicks, 0).t).toBeGreaterThan(1500); // ≥ clickDwellMs after the hand stopped
  });

  it("keeping still longer does not click again", () => {
    const it = active();
    const evs = run(it, [...sweep(0, 0.4, 0.6), ...frames(800, 5000, () => finger(0.6))]);
    expect(ofType(evs, "click")).toHaveLength(1);
  });

  it("moving away and holding again gives a second click", () => {
    const it = active();
    const evs = run(it, [
      ...sweep(0, 0.4, 0.6),
      ...frames(800, 1500, () => finger(0.6)),
      ...sweep(2300, 0.6, 0.45),
      ...frames(3100, 1500, () => finger(0.45)),
    ]);
    expect(ofType(evs, "click")).toHaveLength(2);
  });

  it("raising a still finger never clicks (it must move first)", () => {
    const it = active();
    const evs = run(it, frames(0, 4000, () => finger(0.5)));
    expect(ofType(evs, "mouse").length).toBeGreaterThan(50);
    expect(ofType(evs, "click")).toHaveLength(0);
  });

  it("hand tremor after a click does not re-arm it", () => {
    const it = active();
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32 - 0.5);
    const evs = run(it, [
      ...sweep(0, 0.4, 0.6),
      ...frames(800, 6000, () => finger(0.6 + 0.004 * rand(), 0.4 + 0.004 * rand())), // ≈ ±4 pt jitter
    ]);
    expect(ofType(evs, "click")).toHaveLength(1);
  });

  it("can be turned off", () => {
    const it = new GestureInterpreter(DISPLAY, { clickEnabled: false });
    it.setSessionActive(true);
    const evs = run(it, [...sweep(0, 0.4, 0.6), ...frames(800, 1500, () => finger(0.6))]);
    expect(ofType(evs, "click")).toHaveLength(0);
    expect(ofType(evs, "click_progress")).toHaveLength(0);
  });

  it("drawing mode still selects instead of clicking", () => {
    const it = active();
    const evs = run(it, [
      ...frames(0, 800, (i, n) => [twoFingersAt("Right", 0.4 + 0.2 * (i / (n - 1)), 0.4)]),
      ...frames(800, 1500, () => [twoFingersAt("Right", 0.6, 0.4)]),
    ]);
    expect(ofType(evs, "click")).toHaveLength(0);
    expect(ofType(evs, "point_selected")).toHaveLength(1);
  });
});

describe("two-finger hysteresis", () => {
  /** Glued fingers with the middle one slightly bent (ratio ≈ 1.1): MediaPipe says Pointing_Up. */
  const bentMiddle = (x: number, y = 0.4): HandObservation => {
    const h = twoFingersAt("Right", x, y);
    h.landmarks[12] = { x: x + 0.005, y: y + 0.107, z: 0 };
    h.gesture = { name: "Pointing_Up", score: 0.9 };
    return h;
  };

  it("a slightly bent middle finger does not flip a drawing hand to the mouse", () => {
    const it = active();
    const evs = run(it, [
      ...frames(0, 500, (i, n) => [twoFingersAt("Right", 0.4 + 0.05 * (i / (n - 1)), 0.4)]),
      ...frames(500, 1500, (i, n) => [bentMiddle(0.45 + 0.1 * (i / (n - 1)))]),
    ]);
    expect(ofType(evs, "mouse")).toHaveLength(0);
    expect(ofType(evs, "hand_lost")).toHaveLength(0);
    expect(ofType(evs, "cursor_moved").length).toBeGreaterThan(50);
  });

  it("the same bent hand from scratch is one finger (mouse)", () => {
    const it = active();
    const evs = run(it, frames(0, 1000, (i, n) => [bentMiddle(0.45 + 0.1 * (i / (n - 1)))]));
    expect(ofType(evs, "mouse").length).toBeGreaterThan(5);
    expect(ofType(evs, "cursor_moved")).toHaveLength(0);
  });

  it("clearly folding the middle finger still switches to the mouse", () => {
    const it = active();
    const evs = run(it, [
      ...frames(0, 500, () => [twoFingersAt("Right", 0.45, 0.4)]),
      ...frames(500, 800, () => [hand("Right", "Pointing_Up", { x: 0.45, y: 0.4 })]),
    ]);
    expect(ofType(evs, "mouse").length).toBeGreaterThan(5);
  });
});

describe("tracking robustness", () => {
  it("drawing survives a brief loss of the two-finger pose (fingers drift apart)", () => {
    const it = active();
    const evs = run(
      it,
      frames(0, 1500, (i, n) => {
        const x = 0.4 + 0.2 * (i / (n - 1));
        const t = i * DT;
        const spread = t >= 600 && t < 850 ? 0.08 : 0.01; // 250 ms of V sign = "other"
        return [twoFingersAt("Right", x, 0.4, spread)];
      }),
    );
    expect(ofType(evs, "hand_lost")).toHaveLength(0); // one continuous stroke
    const cur = ofType(evs, "cursor_moved");
    // the cursor holds still while the pose is unsure (no jumps), then keeps following the hand
    expect(cur.filter((e) => e.t > 600 && e.t < 850)).toHaveLength(0);
    expect(cur.filter((e) => e.t >= 1000).length).toBeGreaterThan(10);
  });

  it("the mouse survives a brief misclassification of the index finger", () => {
    const it = active();
    const evs = run(
      it,
      frames(0, 1500, (i, n) => {
        const t = i * DT;
        const h = hand("Right", "Pointing_Up", { x: 0.4 + 0.2 * (i / (n - 1)), y: 0.4 });
        if (t >= 600 && t < 850) h.gesture = { name: "Victory", score: 0.9 }; // → "other"
        return [h];
      }),
    );
    const m = ofType(evs, "mouse");
    expect(m.filter((e) => e.phase === "start")).toHaveLength(1);
    expect(m.filter((e) => e.phase === "end")).toHaveLength(0);
  });

  it("a handoff offset fades out as the hand moves, so the cursor returns under the finger", () => {
    const it = active();
    const tipX = 0.5, tipY = 0.4, gap = 0.03;
    // mouse, then switch to drawing (handoff offset ≈ 31 pt), then sweep the hand around
    const evs = run(it, [
      ...frames(0, 600, () => [hand("Right", "Pointing_Up", { x: tipX, y: tipY })]),
      ...frames(600, 600, () => [twoFingersAt("Right", tipX + gap / 2, tipY, gap)]),
      ...frames(1200, 3000, (i, n) => {
        const a = (4 * Math.PI * i) / (n - 1);
        return [twoFingersAt("Right", tipX + gap / 2 + 0.15 * Math.sin(a), tipY, gap)];
      }),
      ...frames(4200, 800, () => [twoFingersAt("Right", tipX + gap / 2, tipY, gap)]),
    ]);
    const cursors = ofType(evs, "cursor_moved");
    const last = at(cursors, cursors.length - 1);
    const absolute = it.toDisplay(tipX + gap / 2, tipY);
    expect(Math.abs(last.x - absolute[0])).toBeLessThan(4);
  });
});

describe("scroll", () => {
  it("a closed fist drags the page, then ends when the hand opens", () => {
    const it = active();
    const drag = frames(0, 1000, (i, n) => [fistAt("Right", 0.5, 0.3 + 0.2 * (i / (n - 1)))]);
    const settle = frames(1000, 300, () => [fistAt("Right", 0.5, 0.5)]);
    const open = frames(1300, 500, () => [palmAt("Right", 0.5, 0.5)]);
    const evs = run(it, [...drag, ...settle, ...open]);
    const sc = ofType(evs, "scroll");
    expect(at(sc, 0).phase).toBe("start");
    expect(at(sc, sc.length - 1).phase).toBe("end");
    const dy = sc.filter((e) => e.phase === "move").reduce((s, e) => s + e.dy, 0);
    // 0.2 of the frame over a 0.5-high zone on a 900-pt display = 360 pt, hand moved down → dy > 0
    expect(dy).toBeGreaterThan(300);
    expect(dy).toBeLessThan(380);
    expect(ofType(evs, "cursor_moved")).toHaveLength(0);
  });

  it("survives a fist that MediaPipe briefly stops recognising mid-drag", () => {
    const it = active();
    // 1 s drag; between 400 and 650 ms the classifier says "Victory" (→ "other") — common with motion blur.
    const drag = frames(0, 1000, (i, n) => {
      const y = 0.3 + 0.2 * (i / (n - 1));
      const t = i * DT;
      const h = fistAt("Right", 0.5, y);
      if (t >= 400 && t < 650) h.gesture = { name: "Victory", score: 0.9 };
      return [h];
    });
    const evs = run(it, [...drag, ...frames(1000, 300, () => [fistAt("Right", 0.5, 0.5)])]);
    const sc = ofType(evs, "scroll");
    expect(sc.filter((e) => e.phase === "start")).toHaveLength(1);
    expect(sc.filter((e) => e.phase === "end")).toHaveLength(0);
    const dy = sc.filter((e) => e.phase === "move").reduce((sum, e) => sum + e.dy, 0);
    expect(dy).toBeGreaterThan(280);
  });

  it("opening the hand right after a fast drag keeps the whole movement", () => {
    const it = active();
    const drag = frames(0, 500, (i, n) => [fistAt("Right", 0.5, 0.3 + 0.2 * (i / (n - 1)))]);
    const open = frames(500, 500, () => [palmAt("Right", 0.5, 0.5)]);
    const sc = ofType(run(it, [...drag, ...open]), "scroll");
    const dy = sc.reduce((sum, e) => sum + e.dy, 0);
    // hand travelled 0.2 / 0.5 × 900 = 360 pt (minus what moved before the fist was confirmed)
    expect(dy).toBeGreaterThan(310);
    expect(dy).toBeLessThanOrEqual(361);
    expect(at(sc, sc.length - 1).phase).toBe("end");
  });

  it("switching to pointing ends the drag immediately (no grace for real gestures)", () => {
    const it = active();
    const evs = run(it, [
      ...frames(0, 500, () => [fistAt("Right", 0.5, 0.4)]),
      ...frames(500, 300, () => [hand("Right", "Pointing_Up", { x: 0.5, y: 0.4 })]),
    ]);
    const end = ofType(evs, "scroll").find((e) => e.phase === "end");
    expect(end).toBeDefined();
    expect(end!.t).toBeLessThan(700);
  });

  it("does nothing before the session is open", () => {
    const it = new GestureInterpreter(DISPLAY);
    const evs = run(it, frames(0, 1000, (i, n) => [fistAt("Right", 0.5, 0.3 + 0.2 * (i / n))]));
    expect(ofType(evs, "scroll")).toHaveLength(0);
  });
});

describe("building blocks", () => {
  it("rule-based pose recognises pointing and open palm from world landmarks", () => {
    const base = (): Point3[] => Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
    const setFinger = (lm: Point3[], pip: number, tip: number, dx: number, extended: boolean) => {
      lm[pip] = { x: dx, y: -0.05, z: 0 };
      lm[tip] = extended ? { x: dx, y: -0.1, z: 0 } : { x: dx, y: -0.03, z: 0 };
    };
    const pointing = base();
    setFinger(pointing, 6, 8, 0, true);
    setFinger(pointing, 10, 12, 0.01, false);
    setFinger(pointing, 14, 16, 0.02, false);
    setFinger(pointing, 18, 20, 0.03, false);
    const palm = base();
    ([[6, 8], [10, 12], [14, 16], [18, 20]] as const).forEach(([p, t], k) => setFinger(palm, p, t, k * 0.01, true));

    const mk = (w: Point3[]): HandObservation => ({ label: "Right", landmarks: w, worldLandmarks: w });
    expect(ruleBasedPose(mk(pointing), 1.15)).toBe("pointing");
    expect(ruleBasedPose(mk(palm), 1.15)).toBe("open_palm");
  });

  it("One Euro filter strongly reduces tremor on a still finger", () => {
    const f = new OneEuroFilter(1.0, 0.01, 1.0);
    let seed = 42;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32 - 0.5);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const x = 500 + 20 * rand();
      raw.push(x);
      out.push(f.filter(x, i / 30));
    }
    const std = (a: number[]) => {
      const m = a.reduce((s, v) => s + v, 0) / a.length;
      return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
    };
    // At 30 fps with minCutoff = 1 Hz, white noise is cut by ~3x at best.
    expect(std(out.slice(30))).toBeLessThan(std(raw.slice(30)) / 2.5);
  });

  it("calibration builds a zone from four corners", () => {
    const z = computeActiveZone(
      [{ x: 0.8, y: 0.15 }, { x: 0.2, y: 0.15 }, { x: 0.8, y: 0.7 }, { x: 0.2, y: 0.7 }],
      true,
      0,
    );
    expect(z.x0).toBeCloseTo(0.2);
    expect(z.x1).toBeCloseTo(0.8);
    expect(z.y0).toBeCloseTo(0.15);
    expect(z.y1).toBeCloseTo(0.7);
  });
});
