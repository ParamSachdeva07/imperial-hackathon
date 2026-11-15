/**
 * Debug view for the launcher's vision window (POINTY_GESTURES_SHOW=1):
 * camera with hand skeleton + recognized gesture, and a mini screen with the cursor,
 * trail, hold rings and selections. Not used when the window is hidden.
 */
import type { DisplayInfo, FrameObservation, GestureEvent } from "../../src/events";

const EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export function createDebugView(
  root: HTMLElement,
  side: HTMLElement,
): (obs: FrameObservation, events: GestureEvent[], d: DisplayInfo) => void {
  root.style.position = "relative";
  const cam = document.createElement("canvas");
  cam.width = 640;
  cam.height = 480;
  Object.assign(cam.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "auto" });
  root.append(cam);

  const label = document.createElement("div");
  Object.assign(label.style, { padding: "6px 10px", font: "14px system-ui", color: "#ffd54a" });
  const mini = document.createElement("canvas");
  Object.assign(mini.style, { width: "100%", display: "block", background: "#1b1d22", marginTop: "4px" });
  side.append(label, mini);

  const g = cam.getContext("2d")!;
  const m = mini.getContext("2d")!;
  let cursor: { x: number; y: number } | null = null;
  let mouse: { x: number; y: number } | null = null;
  let trail: [number, number, number][] = [];
  let ring = 0;
  let clickRing = 0;
  let selection: GestureEvent | null = null;
  let mode = "";

  return (obs, events, d) => {
    for (const e of events) {
      switch (e.type) {
        case "cursor_moved":
          cursor = { x: e.x, y: e.y };
          trail.push([e.x, e.y, e.t]);
          mode = "✌ draw / select";
          break;
        case "dwell_progress":
          ring = e.progress;
          break;
        case "point_selected":
        case "region_selected":
          selection = e;
          trail = [];
          ring = 0;
          break;
        case "hand_lost":
          cursor = null;
          ring = 0;
          break;
        case "mouse":
          mouse = e.phase === "end" ? null : { x: e.x, y: e.y };
          if (e.phase !== "end") mode = "☝ mouse";
          break;
        case "click_progress":
          clickRing = e.progress;
          break;
        case "click":
          clickRing = 0;
          break;
        case "scroll":
          mode = e.phase === "end" ? "" : "✊ scroll";
          break;
        default:
          break;
      }
    }
    trail = trail.filter(([, , t]) => t > obs.t - 10000);

    // Camera overlay: mirrored skeleton + MediaPipe's label.
    g.clearRect(0, 0, cam.width, cam.height);
    for (const hand of obs.hands) {
      const p = (i: number) => {
        const q = hand.landmarks[i]!;
        return [(1 - q.x) * cam.width, q.y * cam.height] as const;
      };
      g.strokeStyle = "#4ad3ff";
      g.lineWidth = 3;
      for (const [a, b] of EDGES) {
        g.beginPath();
        g.moveTo(...p(a));
        g.lineTo(...p(b));
        g.stroke();
      }
      g.fillStyle = "#fff";
      g.font = "18px system-ui";
      const [wx, wy] = p(0);
      g.fillText(`${hand.label} · ${hand.gesture?.name ?? "?"}`, wx - 40, wy + 24);
    }
    label.textContent = `${obs.hands.length} hand(s)  ${mode}`;

    // Mini screen.
    const w = mini.clientWidth;
    const h = Math.round((w * d.height) / d.width);
    if (mini.width !== w || mini.height !== h) {
      mini.width = w;
      mini.height = h;
    }
    const k = w / d.width;
    m.clearRect(0, 0, w, h);
    if (selection?.type === "region_selected") {
      m.fillStyle = "rgba(74, 211, 255, 0.25)";
      m.strokeStyle = "#4ad3ff";
      m.beginPath();
      selection.polygon.forEach(([x, y], i) => (i ? m.lineTo(x * k, y * k) : m.moveTo(x * k, y * k)));
      m.closePath();
      m.fill();
      m.stroke();
    } else if (selection?.type === "point_selected") {
      m.strokeStyle = "#7CFC9A";
      m.lineWidth = 3;
      m.beginPath();
      m.arc(selection.x * k, selection.y * k, 14, 0, 2 * Math.PI);
      m.stroke();
    }
    if (trail.length > 1) {
      m.strokeStyle = "rgba(255, 213, 74, 0.7)";
      m.lineWidth = 2;
      m.beginPath();
      trail.forEach(([x, y], i) => (i ? m.lineTo(x * k, y * k) : m.moveTo(x * k, y * k)));
      m.stroke();
    }
    const dot = (pt: { x: number; y: number }, color: string, progress: number, ringColor: string) => {
      m.fillStyle = color;
      m.beginPath();
      m.arc(pt.x * k, pt.y * k, 5, 0, 2 * Math.PI);
      m.fill();
      if (progress > 0) {
        m.strokeStyle = ringColor;
        m.lineWidth = 3;
        m.beginPath();
        m.arc(pt.x * k, pt.y * k, 12, -Math.PI / 2, -Math.PI / 2 + progress * 2 * Math.PI);
        m.stroke();
      }
    };
    if (cursor) dot(cursor, "#fff", ring, "#7CFC9A");
    if (mouse) dot(mouse, "#ff9f43", clickRing, "#ff9f43");
  };
}
