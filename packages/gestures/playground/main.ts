import { GestureInterpreter, computeActiveZone, type GestureConfig, type GestureEvent } from "../src/index";
import { HandDetector } from "../src/detector";

const LOCAL_MODEL = "/models/gesture_recognizer.task";
const REMOTE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const cam = $<HTMLCanvasElement>("cam");
const screenCanvas = $<HTMLCanvasElement>("screen");
const statusEl = $("status");
const logEl = $("log");
const hintEl = $("hint");
const camCtx = cam.getContext("2d")!;
const scr = screenCanvas.getContext("2d")!;

/* ---------- state for drawing ---------- */
let awake = false;
let cursor: { x: number; y: number } | null = null;
let dwell = 0;
let trail: [number, number, number][] = []; // x, y, t
const TRAIL_MS = 10000;
let page = { x: 0, y: 0 }; // fake document offset, moved by fist-drag
let grabbing = false;
let mouseDot: { x: number; y: number } | null = null; // where the system mouse is being sent

/* ---------- optional bridge to the real system mouse (scripts/mouse-bridge.mjs) ---------- */
let bridge: WebSocket | null = null;
function connectBridge() {
  const ws = new WebSocket("ws://127.0.0.1:8765");
  ws.onopen = () => {
    bridge = ws;
    $("bridge").textContent = "Mouse bridge: connected — one finger moves your real mouse";
    $("bridge").classList.add("on");
  };
  ws.onclose = () => {
    bridge = null;
    $("bridge").innerHTML = "Mouse bridge: off (run <code>npm run mouse-bridge</code>)";
    $("bridge").classList.remove("on");
    setTimeout(connectBridge, 2000);
  };
  ws.onerror = () => ws.close();
}
connectBridge();
let selection: Extract<GestureEvent, { type: "point_selected" | "region_selected" }> | null = null;
let lastRawTip: { x: number; y: number } | null = null;
let calibration: { x: number; y: number }[] | null = null;

/*
 * Like the real overlay, the interpreter works in WHOLE-SCREEN coordinates
 * (CSS px of the monitor), so the drawing cursor and the real mouse agree.
 * The canvas is just a window onto part of that screen.
 */
function resizeScreen() {
  screenCanvas.width = screenCanvas.clientWidth * devicePixelRatio;
  screenCanvas.height = screenCanvas.clientHeight * devicePixelRatio;
  interp.setDisplay({ id: 0, width: window.screen.width, height: window.screen.height });
}

/*
 * Screen → page alignment.
 * Screen and page coordinates are both CSS px in Chrome, so the mapping is a pure
 * offset (no scale). It is estimated from the window geometry until the real mouse
 * (moved by the bridge) moves slowly over the page: each mousemove then gives a pair
 * (screen position we sent, clientX/Y Chrome reports). The median offset of ~20
 * still samples is LOCKED, and only re-measured if the window moves or resizes.
 */
const LOCK_SAMPLES = 20;
let locked: { dx: number; dy: number } | null = null;
let lockedFor = "";
let lastSent: { x: number; y: number; t: number } | null = null;
let prevSent: { x: number; y: number } | null = null;
const samples: { dx: number; dy: number }[] = [];

const windowKey = () => `${window.screenX},${window.screenY},${window.innerWidth},${window.innerHeight}`;
const median = (a: number[]) => {
  const b = [...a].sort((p, q) => p - q);
  return b[Math.floor(b.length / 2)];
};

window.addEventListener("mousemove", (ev) => {
  if (locked && lockedFor === windowKey()) return;
  if (locked) {
    locked = null; // window moved or resized → measure again
    samples.length = 0;
  }
  if (!bridge || !lastSent || !prevSent || performance.now() - lastSent.t > 150) return;
  // Only trust samples taken while the mouse is (almost) still: no lag ambiguity.
  if (Math.hypot(lastSent.x - prevSent.x, lastSent.y - prevSent.y) > 3) return;
  samples.push({ dx: ev.clientX - lastSent.x, dy: ev.clientY - lastSent.y });
  if (samples.length >= LOCK_SAMPLES) {
    locked = { dx: median(samples.map((p) => p.dx)), dy: median(samples.map((p) => p.dy)) };
    lockedFor = windowKey();
  }
});

/** Screen px → canvas CSS px transform: canvas = screen + offset. */
function screenToCanvas(): { ax: number; bx: number; ay: number; by: number; how: string } {
  const r = screenCanvas.getBoundingClientRect();
  if (locked && lockedFor === windowKey()) {
    return { ax: 1, bx: locked.dx - r.left, ay: 1, by: locked.dy - r.top, how: "measured ✓ (locked)" };
  }
  const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const top = Math.max(0, window.outerHeight - window.innerHeight - border);
  const progress = samples.length ? ` — measuring ${samples.length}/${LOCK_SAMPLES}` : "";
  return {
    ax: 1, bx: -(window.screenX + border + r.left),
    ay: 1, by: -(window.screenY + top + r.top),
    how: `estimated${progress} — move the real mouse SLOWLY over this area to measure`,
  };
}

const interp = new GestureInterpreter({ id: 0, width: 1, height: 1 });
window.addEventListener("resize", resizeScreen);
resizeScreen();

/* ---------- threshold panel ---------- */
const TUNABLE: (keyof GestureConfig)[] = [
  "wakeHoldMs", "dwellMs", "dwellSpeed", "moveSpeed", "oneEuroMinCutoff", "oneEuroBeta",
  "minLoopLength", "minLoopArea", "minCompactness", "closeFrac", "poseStableMs", "fingerExtendRatio",
  "wakeMaxMotion", "wakeUprightMin", "scrollGain", "scrollDeadzone", "scrollGraceMs", "scrollMinCutoff", "twoFingerMaxSpread",
  "poseGraceMs", "handoffDecayDist",
];
for (const key of TUNABLE) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.value = String(interp.config[key]);
  input.onchange = () => interp.setConfig({ [key]: Number(input.value) } as Partial<GestureConfig>);
  label.append(key, input);
  $("params").append(label);
}

/* ---------- buttons ---------- */
$("endSession").onclick = () => {
  awake = false;
  interp.setSessionActive(false);
  cursor = null;
  dwell = 0;
  trail = [];
  grabbing = false;
  mouseDot = null;
  statusEl.textContent = "Idle — raise an open palm to wake";
  statusEl.classList.remove("awake");
};
$("clear").onclick = () => (selection = null);
$("calibrate").onclick = () => {
  // Selections only exist inside a session, so calibration opens one.
  awake = true;
  interp.setSessionActive(true);
  statusEl.textContent = "Calibrating…";
  statusEl.classList.add("awake");
  calibration = [];
  hintEl.textContent = "Point at the TOP-LEFT corner and hold still";
};
const CORNERS = ["TOP-LEFT", "TOP-RIGHT", "BOTTOM-RIGHT", "BOTTOM-LEFT"];

/* ---------- event handling (stands in for the session controller) ---------- */
function log(e: GestureEvent) {
  if (e.type === "cursor_moved" || e.type === "dwell_progress") return;
  if ((e.type === "scroll" || e.type === "mouse") && e.phase === "move") return;
  const line = `${(e.t / 1000).toFixed(2)}s ${JSON.stringify(e)}`;
  logEl.textContent = (line + "\n" + logEl.textContent).slice(0, 8000);
}

function handle(e: GestureEvent) {
  log(e);
  switch (e.type) {
    case "wake_requested":
      awake = true;
      interp.setSessionActive(true); // the controller accepts and latches the session
      statusEl.textContent = `Session active (woken by ${e.hand} hand)`;
      statusEl.classList.add("awake");
      break;
    case "cursor_moved":
      cursor = { x: e.x, y: e.y };
      trail.push([e.x, e.y, e.t]);
      while (trail.length && trail[0][2] < e.t - TRAIL_MS) trail.shift();
      break;
    case "mouse":
      if (e.phase === "end") {
        mouseDot = null;
        break;
      }
      mouseDot = { x: e.x, y: e.y };
      // Normalized to the display, so the bridge can scale to the real screen.
      // Normalized to the whole screen, so the bridge can scale to the real screen size.
      prevSent = lastSent ? { x: lastSent.x, y: lastSent.y } : null;
      lastSent = { x: e.x, y: e.y, t: performance.now() };
      bridge?.send(JSON.stringify({ u: e.x / window.screen.width, v: e.y / window.screen.height }));
      break;
    case "scroll":
      grabbing = e.phase !== "end";
      page.x += e.dx;
      page.y += e.dy;
      break;
    case "dwell_progress":
      dwell = e.progress;
      break;
    case "point_selected":
      if (calibration && lastRawTip) {
        calibration.push(lastRawTip);
        if (calibration.length < 4) {
          hintEl.textContent = `Point at the ${CORNERS[calibration.length]} corner and hold still`;
        } else {
          try {
            const zone = computeActiveZone(calibration, interp.config.mirror);
            interp.setConfig({ activeZone: zone });
            hintEl.textContent = "Calibrated ✓";
          } catch (err) {
            hintEl.textContent = String((err as Error).message);
          }
          calibration = null;
          setTimeout(() => (hintEl.textContent = ""), 1500);
        }
        break;
      }
      selection = e;
      dwell = 0;
      trail = [];
      break;
    case "region_selected":
      if (calibration) break;
      selection = e;
      dwell = 0;
      trail = [];
      break;
    case "hand_lost":
      cursor = null;
      dwell = 0;
      trail = [];
      break;
  }
}

/* ---------- drawing ---------- */
const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

function drawCamera(hands: { landmarks: { x: number; y: number }[]; label: string; gesture?: { name: string } }[]) {
  const { width: w, height: h } = cam;
  const mirror = interp.config.mirror;
  camCtx.save();
  if (mirror) {
    camCtx.translate(w, 0);
    camCtx.scale(-1, 1);
  }
  camCtx.drawImage(video, 0, 0, w, h);
  camCtx.restore();

  const mx = (x: number) => (mirror ? 1 - x : x) * w;
  // The active zone (camera area mapped to the whole screen) is a tuning aid, hidden by default:
  // users must not think hands only work inside it (wake works anywhere in the frame).
  if ($<HTMLInputElement>("showZone").checked || calibration) {
    const z = interp.config.activeZone;
    camCtx.strokeStyle = "#ffd54a";
    camCtx.setLineDash([6, 4]);
    camCtx.strokeRect(z.x0 * w, z.y0 * h, (z.x1 - z.x0) * w, (z.y1 - z.y0) * h);
    camCtx.setLineDash([]);
  }

  for (const hand of hands) {
    const lm = hand.landmarks;
    camCtx.strokeStyle = "#4ad3ff";
    camCtx.lineWidth = 2;
    for (const [a, b] of HAND_EDGES) {
      camCtx.beginPath();
      camCtx.moveTo(mx(lm[a].x), lm[a].y * h);
      camCtx.lineTo(mx(lm[b].x), lm[b].y * h);
      camCtx.stroke();
    }
    camCtx.fillStyle = "#fff";
    camCtx.font = "14px system-ui";
    camCtx.fillText(`${hand.label} · ${hand.gesture?.name ?? "?"}`, mx(lm[0].x) - 30, lm[0].y * h + 20);
  }
}

function drawPage() {
  // A fake document so fist-drag scrolling is visible.
  const w = screenCanvas.clientWidth;
  const h = screenCanvas.clientHeight;
  const lineH = 48;
  scr.save();
  scr.font = "18px system-ui";
  const first = Math.floor(-page.y / lineH) - 1;
  for (let i = first; i < first + h / lineH + 3; i++) {
    const y = page.y + i * lineH;
    scr.fillStyle = i % 10 === 0 ? "rgba(74, 211, 255, 0.10)" : "rgba(255, 255, 255, 0.03)";
    scr.fillRect(page.x % w + 60, y, w - 120, lineH - 8);
    scr.fillStyle = "rgba(255, 255, 255, 0.35)";
    scr.fillText(i % 10 === 0 ? `— Section ${i / 10} —` : `Line ${i}`, page.x % w + 80, y + 28);
  }
  scr.restore();
}

function drawScreen() {
  const d = devicePixelRatio;
  scr.setTransform(d, 0, 0, d, 0, 0);
  scr.clearRect(0, 0, screenCanvas.clientWidth, screenCanvas.clientHeight);
  drawPage();
  if (grabbing) {
    scr.fillStyle = "#ffd54a";
    scr.font = "bold 20px system-ui";
    scr.fillText("✊ dragging the page", 20, 36);
  }
  if (mouseDot) {
    scr.fillStyle = "#ffd54a";
    scr.font = "bold 20px system-ui";
    scr.fillText("🖱 mouse mode (1 finger)", 20, 64);
  }

  // Everything below is in screen coordinates → map into canvas coordinates.
  const m = screenToCanvas();
  scr.fillStyle = "rgba(255,255,255,0.5)";
  scr.font = "13px system-ui";
  scr.fillText(`alignment: ${m.how}`, 20, screenCanvas.clientHeight - 16);
  scr.transform(m.ax, 0, 0, m.ay, m.bx, m.by);

  if (selection?.type === "region_selected") {
    scr.fillStyle = "rgba(74, 211, 255, 0.2)";
    scr.strokeStyle = "#4ad3ff";
    scr.lineWidth = 2;
    scr.beginPath();
    selection.polygon.forEach(([x, y], i) => (i ? scr.lineTo(x, y) : scr.moveTo(x, y)));
    scr.closePath();
    scr.fill();
    scr.stroke();
    const b = selection.bbox;
    scr.setLineDash([4, 4]);
    scr.strokeRect(b.x, b.y, b.width, b.height);
    scr.setLineDash([]);
  } else if (selection?.type === "point_selected") {
    scr.strokeStyle = "#7CFC9A";
    scr.lineWidth = 3;
    scr.beginPath();
    scr.arc(selection.x, selection.y, 28, 0, 2 * Math.PI);
    scr.stroke();
  }

  if (trail.length > 1) {
    scr.strokeStyle = "rgba(255, 213, 74, 0.6)";
    scr.lineWidth = 3;
    scr.beginPath();
    trail.forEach(([x, y], i) => (i ? scr.lineTo(x, y) : scr.moveTo(x, y)));
    scr.stroke();
  }

  if (mouseDot && !bridge) {
    // Simulated system mouse, only when the bridge isn't moving the real one.
    const { x, y } = mouseDot;
    scr.fillStyle = "#ffffff";
    scr.strokeStyle = "#000000";
    scr.lineWidth = 2;
    scr.beginPath();
    scr.moveTo(x, y);
    scr.lineTo(x, y + 26);
    scr.lineTo(x + 7, y + 19);
    scr.lineTo(x + 13, y + 31);
    scr.lineTo(x + 18, y + 29);
    scr.lineTo(x + 12, y + 17);
    scr.lineTo(x + 21, y + 17);
    scr.closePath();
    scr.fill();
    scr.stroke();
  }

  if (cursor) {
    scr.fillStyle = awake ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.4)";
    scr.beginPath();
    scr.arc(cursor.x, cursor.y, 10, 0, 2 * Math.PI);
    scr.fill();
    if (dwell > 0) {
      scr.strokeStyle = "#7CFC9A";
      scr.lineWidth = 5;
      scr.beginPath();
      scr.arc(cursor.x, cursor.y, 24, -Math.PI / 2, -Math.PI / 2 + dwell * 2 * Math.PI);
      scr.stroke();
    }
  }
}

/* ---------- main loop ---------- */
async function main() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  video.srcObject = stream;
  await video.play();

  const modelPath = (await fetch(LOCAL_MODEL, { method: "HEAD" }).then((r) => r.ok).catch(() => false))
    ? LOCAL_MODEL
    : REMOTE_MODEL;
  const detector = await HandDetector.create({ wasmPath: "/mediapipe-wasm", modelPath });
  statusEl.textContent = "Idle — raise an open palm to wake";

  let lastT = -1;
  let frames = 0;
  let fpsT = performance.now();
  const loop = () => {
    const t = performance.now();
    if (video.readyState >= 2 && t > lastT) {
      lastT = t;
      const obs = detector.detect(video, t);
      const pointing = obs.hands.find((h) => h.gesture?.name !== "Open_Palm");
      lastRawTip = pointing ? { x: pointing.landmarks[8].x, y: pointing.landmarks[8].y } : null;
      interp.process(obs).forEach(handle);
      drawCamera(obs.hands);
      drawScreen();
      frames++;
      if (t - fpsT > 1000) {
        document.title = `Pointy · ${frames} fps`;
        $("fps").textContent = `${frames} fps · ${obs.hands.length} hand(s) · ${obs.hands
          .map((h) => `${h.label}:${h.gesture?.name ?? "?"}`)
          .join(" ")}`;
        frames = 0;
        fpsT = t;
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
}

main().catch((err) => {
  statusEl.textContent = `Error: ${(err as Error).message}`;
  console.error(err);
});
