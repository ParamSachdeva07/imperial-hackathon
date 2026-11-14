/**
 * Standalone Electron launcher for the gesture service (works on Windows and macOS).
 *
 *   npm run electron -w @pointy/gestures
 *
 * Runs the hidden vision window, a mock session controller and the real system mouse,
 * and logs gestures in the terminal. Env flags:
 *   POINTY_GESTURES_SHOW=1       show the vision window (camera preview) for debugging
 *   POINTY_GESTURES_NO_MOUSE=1   don't move/click the real mouse
 *   POINTY_GESTURES_IDLE_MS=n    close the session after n ms without gestures (default 20000)
 *   POINTY_GESTURES_SELFTEST=1   synthetic hands instead of the camera; checks the pipeline and exits
 *   POINTY_GESTURES_NO_FEEDBACK=1  don't show the on-screen cursor / trail / rings
 *   POINTY_GESTURES_CAPTURABLE=1   let screenshots include the feedback overlay (it's hidden from captures by default)
 */
import { join } from "node:path";
import { app, screen, type BrowserWindow } from "electron";
import type { GestureEvent } from "../../src/events";
import { toMousePoint } from "../../src/electron/coords";
import { startGestureFeedback, type GestureFeedback } from "../../src/electron/feedback";
import { attachSystemMouse } from "../../src/electron/mouse";
import { startGestureService } from "../../src/electron/service";
import { startMockController } from "./mockController";
import { SELFTEST_DURATION_MS } from "./selftest";

const env = (name: string) => process.env[name];
const selfTest = env("POINTY_GESTURES_SELFTEST") === "1";
const log = (msg: string) => console.log(`[gestures] ${msg}`);

function loadPage(win: BrowserWindow, page: "vision" | "feedback", query = ""): Promise<void> {
  const devUrl = env("ELECTRON_RENDERER_URL");
  if (devUrl && !app.isPackaged) return win.loadURL(`${devUrl}/${page}.html${query}`);
  return win.loadFile(join(__dirname, `../renderer/${page}.html`), query ? { search: query.slice(1) } : undefined);
}

function loadVisionPage(win: BrowserWindow): Promise<void> {
  const params = new URLSearchParams();
  if (selfTest) params.set("selftest", "1");
  if (env("POINTY_GESTURES_SHOW") === "1") params.set("show", "1");
  return loadPage(win, "vision", params.size ? `?${params.toString()}` : "");
}

async function main(): Promise<void> {
  await app.whenReady();

  const service = await startGestureService({
    preloadPath: join(__dirname, "../preload/gestures.cjs"),
    loadPage: loadVisionPage,
    showWindow: env("POINTY_GESTURES_SHOW") === "1",
  });
  app.on("before-quit", () => service.dispose());

  // Subscribe right away: the camera is already running, a wake must not be missed.
  let lastStatus = "";
  service.onStatus((s) => {
    const line = s.type === "running" ? `camera running (${s.fps} fps)` : s.type === "error" ? `ERROR: ${s.message}` : s.type;
    if (line !== lastStatus) log(line);
    lastStatus = line;
  });
  const idleMs = Number(env("POINTY_GESTURES_IDLE_MS") ?? 20000);
  startMockController(service, { idleMs, log });
  const recorder = selfTest ? startSelfTestRecorder(service) : null;

  const useMouse = env("POINTY_GESTURES_NO_MOUSE") !== "1";
  if (useMouse) {
    await attachSystemMouse(service, {
      log,
      onAction: (a) => {
        if (a.type === "scroll") recorder?.scrolled(a.up);
      },
    });
  }

  let feedback: GestureFeedback | null = null;
  if (env("POINTY_GESTURES_NO_FEEDBACK") !== "1") {
    feedback = await startGestureFeedback(service, {
      preloadPath: join(__dirname, "../preload/feedback.cjs"),
      loadPage: (win) => loadPage(win, "feedback"),
      contentProtection: env("POINTY_GESTURES_CAPTURABLE") !== "1",
    });
    const fb = feedback;
    app.on("before-quit", () => fb.dispose());
  }

  log(`ready on display ${service.display.id} (${service.display.width}×${service.display.height}) — raise an open palm to wake. Ctrl+C to quit.`);
  if (recorder) await recorder.finish(useMouse, feedback);
}

/** Number of visible (non-transparent) pixels in the feedback window, or -1 if it can't be captured. */
async function paintedPixels(feedback: GestureFeedback): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const bmp = (await feedback.window.webContents.capturePage()).toBitmap();
      let n = 0;
      for (let i = 3; i < bmp.length; i += 4) if (bmp[i]! > 0) n++;
      return n;
    } catch {
      await new Promise((r) => setTimeout(r, 200)); // not painted yet: retry
    }
  }
  return -1;
}

type Service = Awaited<ReturnType<typeof startGestureService>>;

/** Records from the very start (synthetic hands begin as soon as the vision page loads). */
function startSelfTestRecorder(service: Service) {
  const started = Date.now();
  const seen: GestureEvent[] = [];
  let scrolledUp = 0;
  const probe: { afterClick: { x: number; y: number } | null } = { afterClick: null };
  const nutPromise = import("@nut-tree-fork/nut-js").catch(() => null);
  service.onAny((e) => {
    seen.push(e);
    // Read the real mouse right after the click, before anything else can move it.
    if (e.type === "click") {
      setTimeout(() => {
        void nutPromise.then((nut) =>
          nut?.mouse.getPosition().then((p) => (probe.afterClick = { x: p.x, y: p.y })),
        );
      }, 250);
    }
  });

  return {
    scrolled(up: number) {
      scrolledUp += up;
    },
    async finish(useMouse: boolean, feedback: GestureFeedback | null): Promise<void> {
      const painted: { whileDrawing: number | null; idle: number | null; wakeRing: number | null } = {
        whileDrawing: null,
        idle: null,
        wakeRing: null,
      };
      if (feedback) {
        await new Promise((r) => setTimeout(r, 300)); // let the overlay paint its first (empty) frame
        painted.idle = await paintedPixels(feedback);
        service.on("wake_progress", (e) => {
          if (painted.wakeRing === null && e.progress > 0.5) {
            painted.wakeRing = -1; // capture once
            void paintedPixels(feedback).then((n) => (painted.wakeRing = n));
          }
        });
        service.on("dwell_progress", (e) => {
          if (painted.whileDrawing === null && e.progress > 0.5) {
            painted.whileDrawing = -1; // capture once
            void paintedPixels(feedback).then((n) => (painted.whileDrawing = n));
          }
        });
      }
      await new Promise((r) => setTimeout(r, Math.max(0, SELFTEST_DURATION_MS + 1500 - (Date.now() - started))));

      const count = (type: GestureEvent["type"], phase?: string) =>
        seen.filter((e) => e.type === type && (!phase || ("phase" in e && e.phase === phase))).length;
      const wakeAt = seen.find((e) => e.type === "wake_requested")?.t ?? Infinity;
      const checks: [string, boolean][] = [
        ["wake ring progresses before the wake", seen.filter((e) => e.type === "wake_progress" && e.t <= wakeAt).length > 5],
        ["one wake", count("wake_requested") === 1],
        ["mouse moved", count("mouse", "move") > 10],
        ["one click", count("click") === 1],
        ["one point selected", count("point_selected") === 1],
        ["no region", count("region_selected") === 0],
        ["scroll start + end", count("scroll", "start") === 1 && count("scroll", "end") === 1],
      ];

      if (feedback) {
        log(`diag: feedback overlay painted pixels — idle ${painted.idle}, wake ring ${painted.wakeRing}, while drawing ${painted.whileDrawing}`);
        checks.push(["feedback overlay empty when idle", painted.idle === 0]);
        checks.push(["feedback overlay draws the cursor + ring", (painted.whileDrawing ?? 0) > 500]);
        checks.push(["feedback overlay draws the wake ring", (painted.wakeRing ?? 0) > 500]);
        checks.push(["feedback overlay stays on top", feedback.window.isAlwaysOnTop()]);
      }

      const nut = useMouse ? await nutPromise : null;
      const click = seen.find((e) => e.type === "click");
      if (nut && click) {
        // Same conversion as the mouse module: DIP → OS mouse coordinates (physical pixels on Windows).
        const expected = toMousePoint(service.display.bounds, click.x, click.y, process.platform, (p) =>
          screen.dipToScreenPoint(p),
        );
        const atEnd = await nut.mouse.getPosition();
        const d = screen.getPrimaryDisplay();
        log(
          `diag: display ${d.bounds.width}×${d.bounds.height} DIP at (${d.bounds.x}, ${d.bounds.y}), scaleFactor ${d.scaleFactor}, ` +
            `nut screen ${await nut.screen.width()}×${await nut.screen.height()}`,
        );
        const a = probe.afterClick;
        log(
          `diag: click (${click.x}, ${click.y}) DIP → expected mouse (${expected.x}, ${expected.y}); ` +
            `after click ${a ? `(${a.x}, ${a.y})` : "n/a"}; at end (${atEnd.x}, ${atEnd.y})`,
        );
        checks.push(["real mouse at the click position", !!a && Math.abs(a.x - expected.x) <= 3 && Math.abs(a.y - expected.y) <= 3]);
        log(`diag: fist dragged down → real scroll up ${scrolledUp} (OS units)`);
        checks.push(["fist drag down scrolls the page up", scrolledUp > 0]);
      }

      for (const [name, ok] of checks) log(`${ok ? "PASS" : "FAIL"}  ${name}`);
      const failed = checks.filter(([, ok]) => !ok).length;
      log(failed ? `SELFTEST FAILED (${failed})` : "SELFTEST PASSED");
      app.exit(failed ? 1 : 0);
    },
  };
}

app.on("window-all-closed", () => app.quit());
main().catch((err: unknown) => {
  console.error(err);
  app.exit(1);
});
