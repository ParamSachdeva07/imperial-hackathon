/**
 * Drawing for the feedback overlay page: call `startFeedbackRenderer()` from its script.
 * Big, high-contrast, calm (older users): a large cursor, a thick trail, wide hold rings,
 * selections that fade out by themselves.
 */
import type { GestureEvent } from "../events";
import type { FeedbackMessage } from "./protocol";

export interface FeedbackRendererOptions {
  /** How long a selected point/region stays visible (ms). The controller can also clear it. */
  selectionTtlMs?: number;
  /** How long the trail stays (ms). */
  trailMs?: number;
}

type Selection = Extract<GestureEvent, { type: "point_selected" | "region_selected" }>;

const C = {
  cursor: "#ffffff",
  outline: "rgba(0, 0, 0, 0.75)",
  trail: "#ffd54a",
  dwell: "#2ecc71",
  click: "#ff9f43",
  region: "#2f9bff",
};

export function startFeedbackRenderer(opts: FeedbackRendererOptions = {}): void {
  const api = window.pointyGestureFeedback;
  if (!api) throw new Error("window.pointyGestureFeedback is missing: load the feedback preload in this window.");
  const ttl = opts.selectionTtlMs ?? 4000;
  const trailMs = opts.trailMs ?? 10000;

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
  let trail: { x: number; y: number; t: number }[] = [];
  let dwell = 0;
  let mouse: { x: number; y: number } | null = null;
  let clickProgress = 0;
  let clickFlash: { x: number; y: number; at: number } | null = null;
  let selection: { s: Selection; at: number } | null = null;

  const reset = () => {
    cursor = null;
    trail = [];
    dwell = 0;
    mouse = null;
    clickProgress = 0;
  };

  const apply = (e: GestureEvent, now: number) => {
    switch (e.type) {
      case "cursor_moved":
        cursor = { x: e.x, y: e.y };
        trail.push({ x: e.x, y: e.y, t: now });
        break;
      case "dwell_progress":
        dwell = e.progress;
        break;
      case "point_selected":
      case "region_selected":
        selection = { s: e, at: now };
        trail = [];
        dwell = 0;
        break;
      case "hand_lost":
        cursor = null;
        trail = [];
        dwell = 0;
        break;
      case "mouse":
        mouse = e.phase === "end" ? null : { x: e.x, y: e.y };
        if (e.phase === "end") clickProgress = 0;
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
    g.lineWidth = 12;
    g.beginPath();
    g.arc(x, y, r, 0, 2 * Math.PI);
    g.stroke();
    g.strokeStyle = color;
    g.lineWidth = 8;
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
            g.lineWidth = 9;
            g.stroke();
            g.strokeStyle = C.region;
            g.lineWidth = 5;
            g.stroke();
          } else {
            ring(s.x, s.y, 40, 1, C.dwell);
          }
          g.globalAlpha = 1;
        }
      }

      // Trail of the drawing cursor.
      trail = trail.filter((p) => now - p.t < trailMs);
      if (trail.length > 1) {
        g.lineJoin = "round";
        g.lineCap = "round";
        for (const [color, width] of [[C.outline, 10], [C.trail, 6]] as const) {
          g.strokeStyle = color;
          g.lineWidth = width;
          g.beginPath();
          trail.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          g.stroke();
        }
      }

      // Drawing cursor + selection hold ring.
      if (cursor) {
        g.fillStyle = C.cursor;
        g.strokeStyle = C.outline;
        g.lineWidth = 4;
        g.beginPath();
        g.arc(cursor.x, cursor.y, 14, 0, 2 * Math.PI);
        g.fill();
        g.stroke();
        if (dwell > 0) ring(cursor.x, cursor.y, 34, dwell, C.dwell);
      }

      // Dwell-click ring around the real mouse pointer, and a click confirmation.
      if (mouse && clickProgress > 0) ring(mouse.x, mouse.y, 30, clickProgress, C.click);
      if (clickFlash) {
        const age = (now - clickFlash.at) / 500;
        if (age >= 1) clickFlash = null;
        else {
          g.globalAlpha = 1 - age;
          ring(clickFlash.x, clickFlash.y, 30 + 30 * age, 1, C.click);
          g.globalAlpha = 1;
        }
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}
