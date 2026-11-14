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
 */
import { join } from "node:path";
import { app, screen, type BrowserWindow } from "electron";
import type { GestureEvent } from "../../src/events";
import { toMousePoint } from "../../src/electron/coords";
import { attachSystemMouse } from "../../src/electron/mouse";
import { startGestureService } from "../../src/electron/service";
import { startMockController } from "./mockController";
import { SELFTEST_DURATION_MS } from "./selftest";

const env = (name: string) => process.env[name];
const selfTest = env("POINTY_GESTURES_SELFTEST") === "1";
const log = (msg: string) => console.log(`[gestures] ${msg}`);

function loadVisionPage(win: BrowserWindow): Promise<void> {
  const params = new URLSearchParams();
  if (selfTest) params.set("selftest", "1");
  if (env("POINTY_GESTURES_SHOW") === "1") params.set("show", "1");
  const query = params.size ? `?${params.toString()}` : "";
  const devUrl = env("ELECTRON_RENDERER_URL");
  if (devUrl && !app.isPackaged) return win.loadURL(`${devUrl}/vision.html${query}`);
  return win.loadFile(join(__dirname, "../renderer/vision.html"), query ? { search: query.slice(1) } : undefined);
}

async function main(): Promise<void> {
  await app.whenReady();

  const service = await startGestureService({
    preloadPath: join(__dirname, "../preload/gestures.cjs"),
    loadPage: loadVisionPage,
    showWindow: env("POINTY_GESTURES_SHOW") === "1",
  });
  app.on("before-quit", () => service.dispose());

  let lastStatus = "";
  service.onStatus((s) => {
    const line = s.type === "running" ? `camera running (${s.fps} fps)` : s.type === "error" ? `ERROR: ${s.message}` : s.type;
    if (line !== lastStatus) log(line);
    lastStatus = line;
  });

  const useMouse = env("POINTY_GESTURES_NO_MOUSE") !== "1";
  if (useMouse) await attachSystemMouse(service, { log });

  const idleMs = Number(env("POINTY_GESTURES_IDLE_MS") ?? 20000);
  startMockController(service, { idleMs, log });
  log(`ready on display ${service.display.id} (${service.display.width}×${service.display.height}) — raise an open palm to wake. Ctrl+C to quit.`);

  if (selfTest) await runSelfTest(service, useMouse);
}

async function runSelfTest(
  service: Awaited<ReturnType<typeof startGestureService>>,
  useMouse: boolean,
): Promise<void> {
  const seen: GestureEvent[] = [];
  const probe: { afterClick: { x: number; y: number } | null } = { afterClick: null };
  const nut = useMouse ? await import("@nut-tree-fork/nut-js") : null;
  service.onAny((e) => {
    seen.push(e);
    // Read the real mouse right after the click, before anything else can move it.
    if (e.type === "click" && nut) {
      setTimeout(() => {
        void nut.mouse.getPosition().then((p) => (probe.afterClick = { x: p.x, y: p.y }));
      }, 250);
    }
  });
  await new Promise((r) => setTimeout(r, SELFTEST_DURATION_MS + 1500));

  const count = (type: GestureEvent["type"], phase?: string) =>
    seen.filter((e) => e.type === type && (!phase || ("phase" in e && e.phase === phase))).length;
  const checks: [string, boolean][] = [
    ["one wake", count("wake_requested") === 1],
    ["mouse moved", count("mouse", "move") > 10],
    ["one click", count("click") === 1],
    ["one point selected", count("point_selected") === 1],
    ["no region", count("region_selected") === 0],
    ["scroll start + end", count("scroll", "start") === 1 && count("scroll", "end") === 1],
  ];

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
    log(
      `diag: click (${click.x}, ${click.y}) DIP → expected mouse (${expected.x}, ${expected.y}); ` +
        `after click ${probe.afterClick ? `(${probe.afterClick.x}, ${probe.afterClick.y})` : "n/a"}; at end (${atEnd.x}, ${atEnd.y})`,
    );
    const a = probe.afterClick;
    const ok = !!a && Math.abs(a.x - expected.x) <= 3 && Math.abs(a.y - expected.y) <= 3;
    checks.push(["real mouse at the click position", ok]);
  }

  for (const [name, ok] of checks) log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  log(failed ? `SELFTEST FAILED (${failed})` : "SELFTEST PASSED");
  app.exit(failed ? 1 : 0);
}

app.on("window-all-closed", () => app.quit());
main().catch((err: unknown) => {
  console.error(err);
  app.exit(1);
});
