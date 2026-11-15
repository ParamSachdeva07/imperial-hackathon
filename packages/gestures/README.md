# @pointy/gestures

Local hand-gesture layer for Pointy: webcam → MediaPipe → **gesture interpreter** → events for the session controller.
This package is the "MediaPipe worker" and "Gesture interpreter" boxes of the plan (build step 3).

```
camera frame ──► HandDetector (MediaPipe GestureRecognizer, 2 hands)
                    │ FrameObservation (landmarks, handedness, canned gesture)
                    ▼
              GestureInterpreter (pure TS, no DOM, no MediaPipe)
                    │ GestureEvent[]
                    ▼
              Electron IPC ──► session controller (main process)
```

## Quick start

From the repo root (this package is an npm workspace, like `@pointy/shared`):

```bash
npm install                                   # once, at the root
npm run fetch-model -w @pointy/gestures       # optional: bundle gesture_recognizer.task locally
npm run dev -w @pointy/gestures               # playground at http://localhost:5173 (allow the camera)
npm run mouse-bridge -w @pointy/gestures      # optional, 2nd terminal: lets the playground move/click the real mouse
npx vitest run --project gestures             # gesture tests (also part of `npm test`)
```

The playground shows the camera with landmarks, a simulated page with the cursor, hold rings, strokes and selections drawn over the whole window, an event log, a calibration flow, and live threshold inputs. Tick "Show active zone" to see the camera area mapped to the screen.

## Gestures

| Gesture | Event | Notes |
|---|---|---|
| Open palm, raised, fingers up, held **still** `wakeHoldMs` (700 ms) | `wake_progress` (0→1, ring around the hand), then `wake_requested` | Fires **once per raise**, only when no session is active. A moving hand (scratching, waving) restarts the hold. Re-arms after the palm has been gone `wakeRearmMs`. |
| **Two fingers together** (index + middle) — `drawPose` | `cursor_moved` every frame | Index tip mapped from the active zone of the mirrored camera image to the display, smoothed with a One Euro filter (tremor). An open palm never drives the cursor, so one hand can wake while the other points. |
| Draw pose, fingers still for `dwellMs` (800 ms) | `dwell_progress` (0→1), then `point_selected` | Selects once, then re-arms when the finger moves again. |
| Drag with the draw pose, then still for `dwellMs` | `region_selected` | The rectangle between where the drag began and where the hold happens (four-corner polygon and bbox). `cursor_moved.anchor` carries the start corner so the rectangle can be drawn live. |
| Pointing hand gone (`lostMs`) or pose changed | `hand_lost` | UI hides the cursor. |
| **One finger** (index) — `mousePose` | `mouse` (`start` / `move` / `end`, `x`, `y`) | Drives the **real system mouse**: the controller moves the OS cursor to (x, y). No drawing, no selection. In the playground, `npm run mouse-bridge` does the moving (browsers can't). |
| One finger, still for `clickDwellMs` (1 s) | `click_progress` (0→1), then `click` (`button: "left"`, `x`, `y`) | **Dwell click** where the mouse is. Arms only after the mouse has moved `clickArmDist` (40 pt) since it appeared or last clicked, so raising a still finger or resting the hand never clicks, and one hold = one click. `clickEnabled: false` turns it off. |
| Two fingers spread (V sign) | nothing | Deliberately unused, to avoid accidental triggers. |

The finger mapping is configurable: `new GestureInterpreter(display, { drawPose: "pointing", mousePose: "two_finger" })` restores one finger = draw, two fingers = mouse.
| Closed fist, moved | `scroll` (`start` / `move` / `end`, `dx`, `dy`) | "Grab the page": drag semantics like a touchscreen (hand down ⇒ content down ⇒ scroll up). Counts from the moment the fist formed, survives brief misclassification (`scrollGraceMs`), lighter smoothing than the cursor, and flushes the remaining movement on release, so the page moves exactly as far as the hand. |

**Session gating.** Before the session is open, only `wake_requested` is emitted. The controller calls `interp.setSessionActive(true)` when it accepts a wake, and `setSessionActive(false)` when the session closes (stop button, timeout). Cursor, selections and scroll only exist inside a session. Any hand can point once the session is open, including the one that woke it (useful for one-handed users).

Point vs region is decided **when the hold completes**: if the hold is at least `rectMinSize` away (along either axis) from where the drag began, it is a region; otherwise it is a point. A drag begins where the two fingers went up, or where the finger moved off again after a selection.

## Event contract (`src/events.ts`)

Coordinates are **logical display points (Electron DIP)** relative to the display's top-left corner, plus `displayId`. Conversion to physical pixels (Retina `scaleFactor`) belongs in the platform adapter.

```ts
{ type: "wake_requested", source: "open_palm", hand: "Left", heldForMs: 712, t }
{ type: "wake_progress",  hand: "Left", progress: 0.6, x, y, displayId, t }   // session closed only
{ type: "cursor_moved",   hand: "Right", x: 812.4, y: 390.1, displayId: 1, t }
{ type: "dwell_progress", hand: "Right", progress: 0.6, x, y, displayId, t }
{ type: "point_selected", hand: "Right", x, y, displayId, heldForMs: 800, t }
{ type: "region_selected", hand: "Right", polygon: [[x, y], …], bbox: { x, y, width, height }, displayId, t }
{ type: "hand_lost",      hand: "Right", reason: "absent" | "pose_changed", t }
{ type: "scroll",         hand: "Right", phase: "start" | "move" | "end", dx: 0, dy: 12.5, t }
{ type: "mouse",          hand: "Right", phase: "start" | "move" | "end", x, y, displayId, t }
{ type: "click_progress", hand: "Right", progress: 0.4, x, y, displayId, t }
{ type: "click",          hand: "Right", button: "left", x, y, displayId, t }
```

`hand` is MediaPipe's handedness label, used as a per-hand ID. MediaPipe assumes a mirrored (selfie) image, so with a raw webcam frame "Left" may be the user's right hand. It is only used as an ID.

## Using it in Electron (`@pointy/gestures/electron`)

The gesture layer runs in a **hidden window** (camera + MediaPipe + interpreter) and reports to the main process over IPC. Everything lives in this package (`src/electron/`), so plugging it into `apps/desktop` is a few lines:

```ts
// main process
import { startGestureService } from "@pointy/gestures/electron";
import { attachSystemMouse } from "@pointy/gestures/electron/mouse";

const gestures = await startGestureService({
  preloadPath: join(PRELOAD_DIR, "gestures.js"),        // built from src/electron/preload.ts
  loadPage: (win) => loadRendererPage(win, "gestures"),  // a page whose script calls startVisionRenderer()
});
gestures.on("wake_requested", () => gestures.setSessionActive(true));   // then start voice, avatar…
gestures.on("point_selected", (e) => /* TurnContext point */ e);
gestures.on("region_selected", (e) => /* TurnContext polygon + bbox */ e);
await attachSystemMouse(gestures);   // opt-in: "mouse"/"click" events move and click the real mouse
// on session close (stop button, timeout): gestures.setSessionActive(false)
```

| File | Role |
|---|---|
| `src/electron/service.ts` | main: hidden window, camera permission (own session partition), IPC with sender check, display tracking, `on()/onAny()/setSessionActive()/setConfig()` |
| `src/electron/preload.ts` | sandboxed preload exposing `window.pointyGestures` (bundle with `externalizeDeps: false`) |
| `src/electron/renderer.ts` | page logic: `startVisionRenderer({ wasmPath, modelPath })`. Timer-driven loop (hidden windows don't paint, so no requestAnimationFrame) |
| `src/electron/mouse.ts` | opt-in real mouse, dwell clicks and fist-drag wheel scrolling via nut-js; DIP → physical pixels on Windows |
| `src/electron/protocol.ts` | IPC channels, commands, runtime validation of events from the renderer |

**On-screen feedback** (`@pointy/gestures/electron/feedback`): a transparent, click-through, always-on-top window over the display that draws the user's own gestures: the wake ring around the raised hand, the drawing cursor, its trail, the hold rings (selection and dwell click) and the selected point/region (fades after 4 s). It is excluded from screen captures, so the AI's screenshots never include it. It is separate from the AI annotation overlay in `apps/desktop`.

```ts
const feedback = await startGestureFeedback(gestures, {
  preloadPath: join(PRELOAD_DIR, "gestureFeedback.js"),     // from @pointy/gestures/electron/feedback-preload
  loadPage: (win) => loadRendererPage(win, "gestureFeedback"), // page script: startFeedbackRenderer()
});
feedback.clearSelection(); // e.g. when the turn ends
```

**Standalone launcher** (`electron/dev/`, works on Windows and macOS): hidden vision window, the on-screen feedback, a mock session controller (opens on wake, closes after 20 s without gestures) and the real mouse, with gestures logged in the terminal.

```bash
npm run electron -w @pointy/gestures                         # use it with your camera
POINTY_GESTURES_SHOW=1 npm run electron -w @pointy/gestures  # debug window: camera + skeleton + gesture label, mini screen with cursor/trail/rings/selections
npm run electron:selftest -w @pointy/gestures                # synthetic hands, checks the whole pipeline, exits 0/1
```

Other flags: `POINTY_GESTURES_NO_MOUSE=1`, `POINTY_GESTURES_NO_FEEDBACK=1`, `POINTY_GESTURES_CAPTURABLE=1` (let your own screenshots include the feedback overlay), `POINTY_GESTURES_ZONE=x0,y0,x1,y1` (camera area mapped to the screen), `POINTY_GESTURES_CAMERA_FPS=60` (ask the camera for 60 fps: less latency if it supports it; the log shows what it actually delivers), `POINTY_GESTURES_HANDS=1` (track one hand only: cheaper), `POINTY_GESTURES_IDLE_MS=…`. In PowerShell, set them with `$env:POINTY_GESTURES_SHOW=1` before the command.

Notes:
- Bundle `nut-js` as external (`rollupOptions.external`): it ships a native addon.
- macOS: the packaged app needs `NSCameraUsageDescription`, and Accessibility permission to move/click the mouse.
- For packaged builds, ship the wasm and `gesture_recognizer.task` with the page (they're served from `.cache/public` in dev).

## Moving the real mouse

`npm run mouse-bridge` (second terminal) starts `scripts/mouse-bridge.mjs`: a WebSocket server on `127.0.0.1:8765` that only accepts the dev page's origin and moves the OS cursor with `@nut-tree-fork/nut-js`. The playground connects automatically and sends normalized positions.

The bridge also performs `click` events (`mouse.leftClick()` at the given position); clicks are queued and never dropped, moves keep only the latest.

In Electron, skip the bridge: on a `mouse` event the main process converts (x, y) DIP + `displayId` to the screen position and calls `mouse.setPosition` (nut-js) or the agent-desktop equivalent. macOS needs the Accessibility permission for this.

## Calibration

`computeActiveZone(samples, mirror)` builds the active zone from raw fingertip positions recorded while the user points at the 4 screen corners (the playground's "Calibrate" button does this with holds). Without calibration, the default zone is x 15–85 %, y 20–65 % of the camera frame (the top edge is lowered so the top of the screen, e.g. browser tabs, is reachable at face height). In the Electron launcher, override it with `POINTY_GESTURES_ZONE=x0,y0,x1,y1`.

## Tuning

All thresholds live in `src/config.ts` (`DEFAULT_CONFIG`) and can be changed live with `interp.setConfig({...})`. The defaults are first guesses. Tune them with real users. For older adults, expect to raise `dwellMs` and `wakeHoldMs` and lower `oneEuroMinCutoff` (more smoothing).

## Files

```
src/events.ts       event + observation types (the contract)
src/config.ts       thresholds
src/interpreter.ts  GestureInterpreter: pose → wake / cursor / hold / drag rectangle
src/pose.ts         open palm / pointing classification (MediaPipe label, then landmark rules) + debouncing
src/oneEuro.ts      One Euro filter
src/geometry.ts     distance, bbox
src/calibration.ts  active zone from 4 corners
src/detector.ts     MediaPipe GestureRecognizer wrapper → FrameObservation
playground/         webcam test page (Vite)
test/               vitest suite on synthetic trajectories
```
