import { makeConfig, type FingerPose, type GestureConfig } from "./config";
import type { DisplayInfo, FrameObservation, GestureEvent, HandLabel, HandObservation } from "./events";
import { findClosedLoop, simplify, convexHull, bbox, dist, type Vec2 } from "./geometry";
import { OneEuroFilter2D } from "./oneEuro";
import { classifyPose, PoseTracker, type Pose } from "./pose";
import { at } from "./util";

const WRIST = 0;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9; // palm centre, used for the scroll grab
const MIDDLE_TIP = 12;

interface TimedPoint {
  t: number;
  x: number;
  y: number;
}

interface HandState {
  tracker: PoseTracker;
  lastSeen: number;
  /** Recent palm positions (display points, unclamped) so a drag can start from when the fist formed. */
  palmHist: TimedPoint[];
  wakeArmed: boolean;
  palmGoneSince: number | null;
  holdStart: number | null;
  holdAnchor: Vec2 | null;
}

interface PointerState {
  hand: HandLabel;
  filter: OneEuroFilter2D;
  /** Added to the mapped finger position so a mouse→draw switch starts where the mouse was. */
  offset: Vec2;
  lastRawAnchor: Vec2 | null;
  unsureSince: number | null;
  pos: Vec2;
  lastSeen: number;
  recent: TimedPoint[];
  path: TimedPoint[];
  restStart: number | null;
  restPts: Vec2[];
  armed: boolean;
  lastProgress: number;
}

interface MouseState {
  hand: HandLabel;
  filter: OneEuroFilter2D;
  pos: Vec2;
  /** Added to the mapped finger position so a draw→mouse switch starts where drawing was. */
  offset: Vec2;
  lastRawAnchor: Vec2 | null;
  lastSeen: number;
  unsureSince: number | null;
  /* dwell click */
  recent: TimedPoint[];
  restStart: number | null;
  /** Where the mouse was when it started or last clicked; it must move clickArmDist away to re-arm. */
  armAnchor: Vec2 | null;
  clickArmed: boolean;
  clickProgress: number;
}

interface EndedStroke {
  hand: HandLabel;
  kind: "draw" | "mouse";
  pos: Vec2;
  t: number;
}

interface ScrollState {
  hand: HandLabel;
  filter: OneEuroFilter2D;
  /** Last filtered palm position. */
  last: Vec2;
  /** Last unfiltered palm position, to flush the filter lag when the drag ends. */
  lastRaw: Vec2;
  acc: Vec2;
  lastSeen: number;
  /** When the grabbing hand stopped being recognised as a fist (grace period), or null. */
  unsureSince: number | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Pure, frame-driven gesture interpreter: feed it one FrameObservation per
 * camera frame, get back the GestureEvents for that frame. No DOM, no timers,
 * no MediaPipe dependency, so it runs in a worker, the renderer, or tests.
 *
 * Session gating: before the session is active, only `wake_requested` can be
 * emitted. The controller calls `setSessionActive(true)` once it accepts the
 * wake, and `setSessionActive(false)` when the session closes.
 */
export class GestureInterpreter {
  private cfg: GestureConfig;
  private display: DisplayInfo;
  private hands = new Map<HandLabel, HandState>();
  private pointer: PointerState | null = null;
  private scroll: ScrollState | null = null;
  private mouse: MouseState | null = null;
  private lastEnded: EndedStroke | null = null;
  private sessionActive = false;

  constructor(display: DisplayInfo, config: Partial<GestureConfig> = {}) {
    this.display = display;
    this.cfg = makeConfig(config);
  }

  get config(): Readonly<GestureConfig> {
    return this.cfg;
  }

  get isSessionActive(): boolean {
    return this.sessionActive;
  }

  setConfig(overrides: Partial<GestureConfig>): void {
    this.cfg = makeConfig({ ...this.cfg, ...overrides });
  }

  setDisplay(display: DisplayInfo): void {
    this.display = display;
    this.pointer = null;
    this.scroll = null;
    this.mouse = null;
  }

  /**
   * true: wake is muted; cursor, selections and scroll are enabled.
   * false: back to idle; only wake can fire. Pointer/scroll state is dropped.
   */
  setSessionActive(active: boolean): void {
    this.sessionActive = active;
    if (!active) {
      this.pointer = null;
      this.scroll = null;
      this.mouse = null;
      this.lastEnded = null;
    }
  }

  reset(): void {
    this.hands.clear();
    this.pointer = null;
    this.scroll = null;
    this.mouse = null;
    this.sessionActive = false;
  }

  process(frame: FrameObservation): GestureEvent[] {
    const { t } = frame;
    const events: GestureEvent[] = [];
    const seen = new Set<HandLabel>();
    const stablePose = new Map<HandLabel, Pose>();

    // 1. Per-hand pose + wake.
    for (const hand of frame.hands) {
      seen.add(hand.label);
      const st = this.handState(hand.label);
      // A hand returning after a real absence must not resume its old pose
      // (short tracking dropouts keep it, to avoid flicker).
      if (t - st.lastSeen >= this.cfg.lostMs) {
        st.tracker.reset();
        st.palmHist = [];
      }
      st.lastSeen = t;
      const palm = at(hand.landmarks, MIDDLE_MCP);
      const [px, py] = this.toDisplay(palm.x, palm.y, false);
      st.palmHist.push({ t, x: px, y: py });
      while (st.palmHist.length && at(st.palmHist, 0).t < t - 1000) st.palmHist.shift();
      const pose = st.tracker.update(
        classifyPose(hand, this.cfg.recognizerMinScore, this.cfg.fingerExtendRatio, this.cfg.twoFingerMaxSpread, {
          prev: st.tracker.stable,
          stickyRatio: this.cfg.twoFingerStickyRatio,
          stickyMaxAngle: this.cfg.twoFingerStickyMaxAngle,
        }),
        t,
      );
      stablePose.set(hand.label, pose);
      this.updateWake(st, hand, pose, t, events);
    }
    for (const [label, st] of this.hands) {
      if (!seen.has(label)) this.notePalmGone(st, t);
    }

    if (!this.sessionActive) return events;

    // 2–3. Drawing hand (draw pose) and system-mouse hand (mouse pose).
    //      Ends are handled before starts so that a switch between the two
    //      poses can hand the position over within the same frame.
    const drawHands = frame.hands.filter((h) => stablePose.get(h.label) === this.cfg.drawPose);
    const chosen =
      drawHands.find((h) => h.label === this.pointer?.hand) ??
      this.graceHand(this.pointer, frame.hands, stablePose, t) ??
      drawHands[0] ??
      null;
    const mouseHands = frame.hands.filter((h) => stablePose.get(h.label) === this.cfg.mousePose);
    const mouseHand =
      mouseHands.find((h) => h.label === this.mouse?.hand) ??
      this.graceHand(this.mouse, frame.hands, stablePose, t) ??
      mouseHands[0] ??
      null;
    if (this.pointer && chosen?.label === this.pointer.hand && stablePose.get(chosen.label) === this.cfg.drawPose) {
      this.pointer.unsureSince = null;
    }
    if (this.mouse && mouseHand?.label === this.mouse.hand && stablePose.get(mouseHand.label) === this.cfg.mousePose) {
      this.mouse.unsureSince = null;
    }

    if (this.pointer && (!chosen || chosen.label !== this.pointer.hand)) {
      const p = this.pointer;
      const changed = !!chosen || seen.has(p.hand);
      if (changed || t - p.lastSeen >= this.cfg.lostMs) {
        events.push({ type: "hand_lost", hand: p.hand, reason: changed ? "pose_changed" : "absent", t });
        this.lastEnded = { hand: p.hand, kind: "draw", pos: p.pos, t };
        this.pointer = null;
      }
    }
    if (this.mouse && (!mouseHand || mouseHand.label !== this.mouse.hand)) {
      const m = this.mouse;
      if (mouseHand || seen.has(m.hand) || t - m.lastSeen >= this.cfg.lostMs) {
        events.push(this.mouseEvent(m, "end", t));
        this.lastEnded = { hand: m.hand, kind: "mouse", pos: m.pos, t };
        this.mouse = null;
      }
    }

    if (chosen) {
      if (!this.pointer) {
        const offset = this.handoffOffset(chosen.label, "mouse", this.anchor(chosen, this.cfg.drawPose), t);
        this.pointer = this.newPointer(chosen.label, offset);
      }
      this.updatePointer(this.pointer, chosen, t, events);
    }
    if (mouseHand) {
      const raw = this.anchor(mouseHand, this.cfg.mousePose);
      const isNew = !this.mouse;
      if (!this.mouse) {
        const offset = this.handoffOffset(mouseHand.label, "draw", raw, t);
        this.mouse = {
          hand: mouseHand.label, filter: this.newFilter(), pos: raw, offset,
          lastRawAnchor: null, lastSeen: t, unsureSince: null,
          recent: [], restStart: null, armAnchor: null, clickArmed: false, clickProgress: 0,
        };
      }
      const m = this.mouse;
      m.lastRawAnchor = this.decayOffset(m.offset, m.lastRawAnchor, raw);
      const [sx, sy] = this.clampToDisplay([raw[0] + m.offset[0], raw[1] + m.offset[1]]);
      m.pos = m.filter.filter(sx, sy, t / 1000);
      m.lastSeen = t;
      events.push(this.mouseEvent(m, isNew ? "start" : "move", t));
      if (this.cfg.clickEnabled) this.updateDwellClick(m, t, events);
    }

    // 4. Fist = grab and drag the page.
    const fists = frame.hands.filter((h) => stablePose.get(h.label) === "fist");
    let grab = fists.find((h) => h.label === this.scroll?.hand) ?? null;
    if (this.scroll) {
      const s = this.scroll;
      if (grab) {
        s.unsureSince = null;
      } else {
        // The grabbing hand is visible but not classified as anything meaningful ("other"):
        // usually motion blur. Keep dragging for a short grace period. A real gesture
        // (open palm, pointing, two fingers) ends the drag immediately.
        const same = frame.hands.find((h) => h.label === s.hand);
        if (same && stablePose.get(same.label) === "other") {
          if (s.unsureSince === null) s.unsureSince = t;
          if (t - s.unsureSince <= this.cfg.scrollGraceMs) grab = same;
        }
      }
    }
    grab ??= fists[0] ?? null;

    if (this.scroll && (!grab || grab.label !== this.scroll.hand)) {
      const s = this.scroll;
      if (grab || seen.has(s.hand) || t - s.lastSeen >= this.cfg.lostMs) this.endScroll(t, events);
    }
    if (grab) this.updateScroll(grab, t, events);

    return events;
  }

  /* ---------------------------------------------------------------- */

  private handState(label: HandLabel): HandState {
    let st = this.hands.get(label);
    if (!st) {
      st = {
        tracker: new PoseTracker(this.cfg.poseStableMs),
        lastSeen: -Infinity,
        palmHist: [],
        wakeArmed: true,
        palmGoneSince: null,
        holdStart: null,
        holdAnchor: null,
      };
      this.hands.set(label, st);
    }
    return st;
  }

  private updateWake(st: HandState, hand: HandObservation, pose: Pose, t: number, events: GestureEvent[]): void {
    const c = this.cfg;
    const wrist = at(hand.landmarks, WRIST);
    const midTip = at(hand.landmarks, MIDDLE_TIP);
    const upright = !c.wakeRequireUpright || wrist.y - midTip.y >= c.wakeUprightMin;
    const raised = pose === "open_palm" && wrist.y <= c.wakeMaxWristY && upright;

    if (!raised) {
      st.holdStart = null;
      st.holdAnchor = null;
      this.notePalmGone(st, t);
      return;
    }

    st.palmGoneSince = null;
    // A hand that moves (scratching, waving, reaching) restarts the hold.
    if (st.holdStart === null || !st.holdAnchor || dist(st.holdAnchor, [wrist.x, wrist.y]) > c.wakeMaxMotion) {
      st.holdStart = t;
      st.holdAnchor = [wrist.x, wrist.y];
    }
    const held = t - st.holdStart;
    if (st.wakeArmed && !this.sessionActive && held >= c.wakeHoldMs) {
      st.wakeArmed = false;
      events.push({ type: "wake_requested", source: "open_palm", hand: hand.label, heldForMs: Math.round(held), t });
    }
  }

  /** Screen point a finger pose designates: index tip, or the midpoint of index + middle tips. */
  private anchor(hand: HandObservation, pose: FingerPose): Vec2 {
    const a = at(hand.landmarks, INDEX_TIP);
    if (pose === "pointing") return this.toDisplay(a.x, a.y);
    const b = at(hand.landmarks, MIDDLE_TIP);
    return this.toDisplay((a.x + b.x) / 2, (a.y + b.y) / 2);
  }

  private mouseEvent(m: MouseState, phase: "start" | "move" | "end", t: number): GestureEvent {
    return {
      type: "mouse",
      hand: m.hand,
      phase,
      x: round1(m.pos[0]),
      y: round1(m.pos[1]),
      displayId: this.display.id,
      t,
    };
  }

  private notePalmGone(st: HandState, t: number): void {
    if (st.palmGoneSince === null) st.palmGoneSince = t;
    if (t - st.palmGoneSince >= this.cfg.wakeRearmMs) st.wakeArmed = true;
  }

  private newFilter(): OneEuroFilter2D {
    const c = this.cfg;
    return new OneEuroFilter2D(c.oneEuroMinCutoff, c.oneEuroBeta, c.oneEuroDCutoff);
  }

  /**
   * If the same hand just finished a stroke of the other kind, return the offset that makes the
   * new stroke start exactly where the old one ended; otherwise no offset (absolute mapping).
   */
  private handoffOffset(hand: HandLabel, fromKind: "draw" | "mouse", raw: Vec2, t: number): Vec2 {
    const e = this.lastEnded;
    if (!e || e.hand !== hand || e.kind !== fromKind || t - e.t > this.cfg.handoffMs) return [0, 0];
    return [e.pos[0] - raw[0], e.pos[1] - raw[1]];
  }

  /**
   * While the stroke's own pose is briefly unrecognised ("other": blur, fingers drifting apart),
   * keep following the same hand for poseGraceMs. A real gesture change is not covered.
   */
  private graceHand(
    s: { hand: HandLabel; unsureSince: number | null } | null,
    hands: HandObservation[],
    stablePose: Map<HandLabel, Pose>,
    t: number,
  ): HandObservation | null {
    if (!s) return null;
    const same = hands.find((h) => h.label === s.hand);
    if (!same || stablePose.get(same.label) !== "other") return null;
    if (s.unsureSince === null) s.unsureSince = t;
    return t - s.unsureSince <= this.cfg.poseGraceMs ? same : null;
  }

  /** Shrinks a handoff offset in proportion to how far the finger moved; returns the new raw anchor. */
  private decayOffset(offset: Vec2, lastRaw: Vec2 | null, raw: Vec2): Vec2 {
    if (lastRaw && (offset[0] !== 0 || offset[1] !== 0)) {
      const k = Math.exp(-dist(raw, lastRaw) / this.cfg.handoffDecayDist);
      offset[0] *= k;
      offset[1] *= k;
      if (Math.hypot(offset[0], offset[1]) < 0.5) offset[0] = offset[1] = 0;
    }
    return raw;
  }

  private clampToDisplay([x, y]: Vec2): Vec2 {
    return [Math.min(this.display.width, Math.max(0, x)), Math.min(this.display.height, Math.max(0, y))];
  }

  private newPointer(hand: HandLabel, offset: Vec2 = [0, 0]): PointerState {
    return {
      hand,
      filter: this.newFilter(),
      offset,
      lastRawAnchor: null,
      unsureSince: null,
      pos: [0, 0],
      lastSeen: 0,
      recent: [],
      path: [],
      restStart: null,
      restPts: [],
      armed: true,
      lastProgress: 0,
    };
  }

  /** Normalized camera coords → display points (mirror + active zone), optionally clamped. */
  toDisplay(nx: number, ny: number, clamp = true): Vec2 {
    const z = this.cfg.activeZone;
    const x = this.cfg.mirror ? 1 - nx : nx;
    let u = (x - z.x0) / (z.x1 - z.x0);
    let v = (ny - z.y0) / (z.y1 - z.y0);
    if (clamp) {
      u = Math.min(1, Math.max(0, u));
      v = Math.min(1, Math.max(0, v));
    }
    return [u * this.display.width, v * this.display.height];
  }

  private updateScroll(hand: HandObservation, t: number, events: GestureEvent[]): void {
    const c = this.cfg;
    const palm = at(hand.landmarks, MIDDLE_MCP);
    // Unclamped: dragging must keep working past the edges of the active zone.
    const [sx, sy] = this.toDisplay(palm.x, palm.y, false);

    if (!this.scroll) {
      // Start from where the palm was when the fist actually formed (the pose needs
      // poseStableMs to be confirmed), so a quick drag doesn't lose its beginning.
      const st = this.handState(hand.label);
      const origin = st.palmHist.find((q) => q.t >= st.tracker.stableSince) ?? { t, x: sx, y: sy };
      const filter = new OneEuroFilter2D(c.scrollMinCutoff, c.scrollBeta, c.oneEuroDCutoff);
      const start = filter.filter(origin.x, origin.y, origin.t / 1000);
      this.scroll = {
        hand: hand.label, filter, last: start, lastRaw: [origin.x, origin.y],
        acc: [0, 0], lastSeen: t, unsureSince: null,
      };
      events.push({ type: "scroll", hand: hand.label, phase: "start", dx: 0, dy: 0, t });
      if (origin.t === t) return;
    }

    const s = this.scroll;
    s.lastRaw = [sx, sy];
    const [x, y] = s.filter.filter(sx, sy, t / 1000);
    s.acc[0] += (x - s.last[0]) * c.scrollGain;
    s.acc[1] += (y - s.last[1]) * c.scrollGain;
    s.last = [x, y];
    s.lastSeen = t;
    if (Math.hypot(s.acc[0], s.acc[1]) >= c.scrollDeadzone) {
      events.push({ type: "scroll", hand: s.hand, phase: "move", dx: round1(s.acc[0]), dy: round1(s.acc[1]), t });
      s.acc = [0, 0];
    }
  }

  /** Mouse mode: hold still clickDwellMs → one left click; must move clickArmDist away before the next. */
  private updateDwellClick(m: MouseState, t: number, events: GestureEvent[]): void {
    const c = this.cfg;
    const [x, y] = m.pos;
    const displayId = this.display.id;

    m.armAnchor ??= [x, y];
    if (!m.clickArmed && dist(m.armAnchor, [x, y]) >= c.clickArmDist) m.clickArmed = true;

    m.recent.push({ t, x, y });
    while (m.recent.length > 2 && at(m.recent, 0).t < t - c.speedWindowMs) m.recent.shift();
    const first = at(m.recent, 0);
    const dt = (t - first.t) / 1000;
    const speed = dt > 0 ? dist([first.x, first.y], [x, y]) / dt : 0;
    const resting = m.restStart !== null ? speed <= c.moveSpeed : speed < c.dwellSpeed;

    if (!resting) {
      m.restStart = null;
      if (m.clickProgress > 0) {
        events.push({ type: "click_progress", hand: m.hand, progress: 0, x: round1(x), y: round1(y), displayId, t });
      }
      m.clickProgress = 0;
      return;
    }

    if (m.restStart === null) m.restStart = t;
    if (!m.clickArmed) return;
    const progress = Math.min(1, (t - m.restStart) / c.clickDwellMs);
    m.clickProgress = progress;
    events.push({ type: "click_progress", hand: m.hand, progress, x: round1(x), y: round1(y), displayId, t });
    if (progress >= 1) {
      events.push({ type: "click", hand: m.hand, button: "left", x: round1(x), y: round1(y), displayId, t });
      m.clickArmed = false;
      m.armAnchor = [x, y];
      m.clickProgress = 0;
    }
  }

  /** Ends the drag, first flushing what the smoothing filter hadn't caught up with yet. */
  private endScroll(t: number, events: GestureEvent[]): void {
    const s = this.scroll!;
    const g = this.cfg.scrollGain;
    const dx = s.acc[0] + (s.lastRaw[0] - s.last[0]) * g;
    const dy = s.acc[1] + (s.lastRaw[1] - s.last[1]) * g;
    if (Math.hypot(dx, dy) >= 0.5) {
      events.push({ type: "scroll", hand: s.hand, phase: "move", dx: round1(dx), dy: round1(dy), t });
    }
    events.push({ type: "scroll", hand: s.hand, phase: "end", dx: 0, dy: 0, t });
    this.scroll = null;
  }

  private updatePointer(p: PointerState, hand: HandObservation, t: number, events: GestureEvent[]): void {
    const c = this.cfg;
    const displayId = this.display.id;
    const raw = this.anchor(hand, c.drawPose);
    p.lastRawAnchor = this.decayOffset(p.offset, p.lastRawAnchor, raw);
    const [sx, sy] = this.clampToDisplay([raw[0] + p.offset[0], raw[1] + p.offset[1]]);
    const [x, y] = p.filter.filter(sx, sy, t / 1000);
    p.pos = [x, y];
    p.lastSeen = t;
    events.push({ type: "cursor_moved", hand: p.hand, x: round1(x), y: round1(y), displayId, t });

    // Speed over a short window.
    p.recent.push({ t, x, y });
    while (p.recent.length > 2 && at(p.recent, 0).t < t - c.speedWindowMs) p.recent.shift();
    const first = at(p.recent, 0);
    const dt = (t - first.t) / 1000;
    const speed = dt > 0 ? dist([first.x, first.y], [x, y]) / dt : 0;

    // Path for loop detection.
    p.path.push({ t, x, y });
    while (p.path.length && at(p.path, 0).t < t - c.pathMaxMs) p.path.shift();

    // Hysteresis: once resting, stay resting until clearly moving.
    const resting = p.restStart !== null ? speed <= c.moveSpeed : speed < c.dwellSpeed;

    if (resting) {
      if (p.restStart === null) {
        p.restStart = t;
        p.restPts = [];
      }
      p.restPts.push([x, y]);
      if (!p.armed) return;

      const progress = Math.min(1, (t - p.restStart) / c.dwellMs);
      p.lastProgress = progress;
      events.push({ type: "dwell_progress", hand: p.hand, progress, x: round1(x), y: round1(y), displayId, t });
      if (progress >= 1) this.select(p, t, events);
      return;
    }

    // Moving.
    if (p.restStart !== null) {
      p.restStart = null;
      if (p.lastProgress > 0) {
        events.push({ type: "dwell_progress", hand: p.hand, progress: 0, x: round1(x), y: round1(y), displayId, t });
      }
      p.lastProgress = 0;
    }
    if (!p.armed && speed > c.moveSpeed) {
      p.armed = true;
      p.path = [{ t, x, y }];
    }
  }

  private select(p: PointerState, t: number, events: GestureEvent[]): void {
    const c = this.cfg;
    const displayId = this.display.id;
    const pts: Vec2[] = p.path.map((q) => [q.x, q.y]);
    const loop = findClosedLoop(pts, c);

    if (loop) {
      // Hand-drawn loops wobble and self-intersect; the convex hull is what the user meant to enclose.
      const poly = convexHull(simplify(loop, c.simplifyEpsilon)).map(
        ([x, y]) => [round1(x), round1(y)] as [number, number],
      );
      const b = bbox(poly);
      events.push({
        type: "region_selected",
        hand: p.hand,
        polygon: poly,
        bbox: { x: round1(b.x), y: round1(b.y), width: round1(b.width), height: round1(b.height) },
        displayId,
        t,
      });
    } else {
      const n = p.restPts.length;
      const mx = p.restPts.reduce((s, q) => s + q[0], 0) / n;
      const my = p.restPts.reduce((s, q) => s + q[1], 0) / n;
      events.push({
        type: "point_selected",
        hand: p.hand,
        x: round1(mx),
        y: round1(my),
        displayId,
        heldForMs: Math.round(t - (p.restStart ?? t)),
        t,
      });
    }

    p.armed = false;
    p.path = [];
    p.lastProgress = 0;
  }
}
