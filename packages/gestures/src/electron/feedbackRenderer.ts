/**
 * Drawing for the feedback overlay page: call `startFeedbackRenderer()` from its script.
 * Light and calm: a short thin trace behind the mouse finger, a plain rectangle while dragging a selection
 * (like a mouse drag: no cursor, no trail), thin hold rings,
 * selections that fade out by themselves.
 */
import type { GestureEvent } from "../events";
import type { FeedbackMessage } from "./protocol";

export interface FeedbackRendererOptions {
  /** How long a selected point/region stays visible (ms). The controller can also clear it. */
  selectionTtlMs?: number;
}

type Selection = Extract<GestureEvent, { type: "point_selected" | "region_selected" }>;

/** How long the mouse finger's trace stays (ms): short, so it reads as motion, not as a drawing. */
const TRACE_MS = 220;

const C = {
  cursor: "#ffffff",
  outline: "rgba(0, 0, 0, 0.75)",
  dwell: "#2ecc71",
  click: "#ff9f43",
  region: "#2f9bff",
  wake: "#8fd3ff",
};

export function startFeedbackRenderer(opts: FeedbackRendererOptions = {}): void {
  const api = window.pointyGestureFeedback;
  if (!api) throw new Error("window.pointyGestureFeedback is missing: load the feedback preload in this window.");
  const ttl = opts.selectionTtlMs ?? 4000;

  document.documentElement.style.background = "transparent";
  document.body.style.margin = "0";
  document.body.style.background = "transparent";
  document.body.style.overflow = "hidden";
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh" });
  document.body.append(canvas);
  const g = canvas.getContext("2d")!;

  let active = false;
  let cursor: { x: number; y: number } | null = null;
  /** The fixed corner of the rectangle being dragged out (the cursor is the opposite one). */
  let anchor: { x: number; y: number } | null = null;
  let dwell = 0;
  let mouse: { x: number; y: number } | null = null;
  /** Where the mouse finger just was: a short trace that follows the movement and fades within TRACE_MS. */
  let trace: { x: number; y: number; t: number }[] = [];
  let clickProgress = 0;
  let clickFlash: { x: number; y: number; at: number } | null = null;
  let selection: { s: Selection; at: number } | null = null;
  let wake: { x: number; y: number; progress: number } | null = null;
  let wakeFlash: { x: number; y: number; at: number } | null = null;

  const reset = () => {
    cursor = null;
    anchor = null;
    dwell = 0;
    mouse = null;
    trace = [];
    clickProgress = 0;
  };

  const apply = (e: GestureEvent, now: number) => {
    switch (e.type) {
      case "wake_progress":
        wake = e.progress > 0 ? { x: e.x, y: e.y, progress: e.progress } : null;
        break;
      case "wake_requested":
        if (wake) wakeFlash = { x: wake.x, y: wake.y, at: now };
        wake = null;
        break;
      case "cursor_moved":
        cursor = { x: e.x, y: e.y };
        anchor = e.anchor ?? null;
        break;
      case "dwell_progress":
        dwell = e.progress;
        break;
      case "point_selected":
      case "region_selected":
        selection = { s: e, at: now };
        anchor = null;
        dwell = 0;
        break;
      case "hand_lost":
        cursor = null;
        anchor = null;
        dwell = 0;
        break;
      case "mouse":
        mouse = e.phase === "end" ? null : { x: e.x, y: e.y };
        if (e.phase === "end") {
          clickProgress = 0;
          trace = [];
        } else trace.push({ x: e.x, y: e.y, t: now });
        break;
      case "click_progress":
        clickProgress = e.progress;
        break;
      case "click":
        clickProgress = 0;
        clickFlash = { x: e.x, y: e.y, at: now };
        break;
      default:
        break;
    }
  };

  api.onMessage((msg: FeedbackMessage) => {
    const now = performance.now();
    if (msg.type === "events") for (const e of msg.events) apply(e, now);
    else if (msg.type === "session") {
      active = msg.active;
      if (!active) {
        reset();
        selection = null;
      }
    } else if (msg.type === "clear") selection = null;
  });

  const ring = (x: number, y: number, r: number, progress: number, color: string) => {
    g.lineCap = "round";
    g.strokeStyle = C.outline;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(x, y, r, 0, 2 * Math.PI);
    g.stroke();
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + progress * 2 * Math.PI);
    g.stroke();
  };

  const draw = () => {
    const now = performance.now();
    const d = devicePixelRatio;
    const w = innerWidth;
    const h = innerHeight;
    if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(h * d)) {
      canvas.width = Math.round(w * d);
      canvas.height = Math.round(h * d);
    }
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);

    // Wake: big ring around the raised hand while it is held still (session not open yet),
    // then a short expanding confirmation.
    if (wake) ring(wake.x, wake.y, 56, wake.progress, C.wake);
    if (wakeFlash) {
      const age = (now - wakeFlash.at) / 600;
      if (age >= 1) wakeFlash = null;
      else {
        g.globalAlpha = 1 - age;
        ring(wakeFlash.x, wakeFlash.y, 56 + 50 * age, 1, C.wake);
        g.globalAlpha = 1;
      }
    }

    if (active) {
      // Selected point / region, fading out over the last second of its life.
      if (selection) {
        const age = now - selection.at;
        if (age > ttl) selection = null;
        else {
          g.globalAlpha = Math.min(1, (ttl - age) / 1000);
          const s = selection.s;
          if (s.type === "region_selected") {
            g.beginPath();
            s.polygon.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
            g.closePath();
            g.fillStyle = "rgba(47, 155, 255, 0.18)";
            g.fill();
            g.strokeStyle = C.outline;
            g.lineWidth = 4;
            g.stroke();
            g.strokeStyle = C.region;
            g.lineWidth = 2;
            g.stroke();
          } else {
            ring(s.x, s.y, 24, 1, C.dwell);
          }
          g.globalAlpha = 1;
        }
      }

      // Dragging a selection: just the rectangle, from where the drag began to the finger, like a mouse drag.
      const dragging = !!cursor && !!anchor && Math.max(Math.abs(cursor.x - anchor.x), Math.abs(cursor.y - anchor.y)) >= 8;
      if (cursor && anchor && dragging) {
        const x = Math.min(anchor.x, cursor.x), y = Math.min(anchor.y, cursor.y);
        const rw = Math.abs(cursor.x - anchor.x), rh = Math.abs(cursor.y - anchor.y);
        g.fillStyle = "rgba(47, 155, 255, 0.12)";
        g.fillRect(x, y, rw, rh);
        g.strokeStyle = C.region;
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, rw, rh);
      }

      // Two fingers up but not dragging yet: a small dot where the drag will start, and the hold ring.
      if (cursor && !dragging) {
        g.fillStyle = C.cursor;
        g.strokeStyle = C.outline;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(cursor.x, cursor.y, 6, 0, 2 * Math.PI);
        g.fill();
        g.stroke();
        if (dwell > 0) ring(cursor.x, cursor.y, 22, dwell, C.dwell);
      }

      // Mouse finger: a short thin trace behind the pointer, fading towards its tail.
      trace = trace.filter((p) => now - p.t < TRACE_MS);
      g.lineCap = "round";
      for (let i = 1; i < trace.length; i++) {
        const a = trace[i - 1]!, b = trace[i]!;
        const fresh = 1 - (now - b.t) / TRACE_MS;
        for (const [color, width] of [[C.outline, 3.5], [C.cursor, 1.75]] as const) {
          g.globalAlpha = fresh * (color === C.outline ? 0.5 : 1);
          g.strokeStyle = color;
          g.lineWidth = width;
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
        }
      }
      g.globalAlpha = 1;

      // Dwell-click ring around the real mouse pointer, and a click confirmation.
      if (mouse && clickProgress > 0) ring(mouse.x, mouse.y, 20, clickProgress, C.click);
      if (clickFlash) {
        const age = (now - clickFlash.at) / 500;
        if (age >= 1) clickFlash = null;
        else {
          g.globalAlpha = 1 - age;
          ring(clickFlash.x, clickFlash.y, 20 + 20 * age, 1, C.click);
          g.globalAlpha = 1;
        }
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}
