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
| Open palm, raised, fingers up, held **still** `wakeHoldMs` (700 ms) | `wake_requested` | Fires **once per raise**, only when no session is active. A moving hand (scratching, waving) restarts the hold. Re-arms after the palm has been gone `wakeRearmMs`. |
| **Two fingers together** (index + middle) — `drawPose` | `cursor_moved` every frame | Index tip mapped from the active zone of the mirrored camera image to the display, smoothed with a One Euro filter (tremor). An open palm never drives the cursor, so one hand can wake while the other points. |
| Draw pose, fingers still for `dwellMs` (800 ms) | `dwell_progress` (0→1), then `point_selected` | Selects once, then re-arms when the finger moves again. |
| Closed loop drawn with the draw pose, then still for `dwellMs` | `region_selected` | Polygon (simplified) and bbox. Rejects back-and-forth scribbles with a compactness test (4πA/P²). |
| Pointing hand gone (`lostMs`) or pose changed | `hand_lost` | UI hides the cursor. |
| **One finger** (index) — `mousePose` | `mouse` (`start` / `move` / `end`, `x`, `y`) | Drives the **real system mouse**: the controller moves the OS cursor to (x, y). No drawing, no selection. In the playground, `npm run mouse-bridge` does the moving (browsers can't). |
| One finger, still for `clickDwellMs` (1 s) | `click_progress` (0→1), then `click` (`button: "left"`, `x`, `y`) | **Dwell click** where the mouse is. Arms only after the mouse has moved `clickArmDist` (40 pt) since it appeared or last clicked, so raising a still finger or resting the hand never clicks, and one hold = one click. `clickEnabled: false` turns it off. |
| Two fingers spread (V sign) | nothing | Deliberately unused, to avoid accidental triggers. |

The finger mapping is configurable: `new GestureInterpreter(display, { drawPose: "pointing", mousePose: "two_finger" })` restores one finger = draw, two fingers = mouse.
| Closed fist, moved | `scroll` (`start` / `move` / `end`, `dx`, `dy`) | "Grab the page": drag semantics like a touchscreen (hand down ⇒ content down ⇒ scroll up). Counts from the moment the fist formed, survives brief misclassification (`scrollGraceMs`), lighter smoothing than the cursor, and flushes the remaining movement on release, so the page moves exactly as far as the hand. |

**Session gating.** Before the session is open, only `wake_requested` is emitted. The controller calls `interp.setSessionActive(true)` when it accepts a wake, and `setSessionActive(false)` when the session closes (stop button, timeout). Cursor, selections and scroll only exist inside a session. Any hand can point once the session is open, including the one that woke it (useful for one-handed users).

Point vs region is decided **when the hold completes**: if the path since the last selection contains a closed loop ending at the hold position, it is a region; otherwise it is a point.

## Event contract (`src/events.ts`)

Coordinates are **logical display points (Electron DIP)** relative to the display's top-left corner, plus `displayId`. Conversion to physical pixels (Retina `scaleFactor`) belongs in the platform adapter.

```ts
{ type: "wake_requested", source: "open_palm", hand: "Left", heldForMs: 712, t }
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

## Using it in Electron

```ts
// vision renderer (hidden BrowserWindow)
import { GestureInterpreter } from "@pointy/gestures";
import { HandDetector } from "@pointy/gestures/detector";

const detector = await HandDetector.create({ wasmPath: "./mediapipe-wasm", modelPath: "./models/gesture_recognizer.task" });
const interp = new GestureInterpreter({ id: display.id, width: display.bounds.width, height: display.bounds.height });
// per frame:
const events = interp.process(detector.detect(video, performance.now()));
for (const e of events) window.pointy.sendGesture(e); // preload: ipcRenderer.send("gesture", e)
```

Electron gotchas:

- **The main process has no camera.** Run detection in a renderer, e.g. a hidden `BrowserWindow`, and forward events through a `contextBridge` preload to `ipcMain`.
- **Hidden windows get throttled by Chromium.** Use `webPreferences: { backgroundThrottling: false }` on that window, or detection drops to ~1 fps.
- **Web Workers can't call `getUserMedia`.** If detection moves to a worker, capture in the renderer and transfer `ImageBitmap`/`VideoFrame`s. `GestureInterpreter` is pure, so it can live anywhere.
- **macOS camera permission**: add `NSCameraUsageDescription` to the app's Info.plist and test from the **packaged** app.
- **Bundle the wasm and model** (`scripts/copy-wasm.mjs`, `npm run fetch-model`) so nothing depends on a CDN or venue Wi-Fi.
- Call `interp.setDisplay(...)` when the active display changes.

## Moving the real mouse

`npm run mouse-bridge` (second terminal) starts `scripts/mouse-bridge.mjs`: a WebSocket server on `127.0.0.1:8765` that only accepts the dev page's origin and moves the OS cursor with `@nut-tree-fork/nut-js`. The playground connects automatically and sends normalized positions.

The bridge also performs `click` events (`mouse.leftClick()` at the given position); clicks are queued and never dropped, moves keep only the latest.

In Electron, skip the bridge: on a `mouse` event the main process converts (x, y) DIP + `displayId` to the screen position and calls `mouse.setPosition` (nut-js) or the agent-desktop equivalent. macOS needs the Accessibility permission for this.

## Calibration

`computeActiveZone(samples, mirror)` builds the active zone from raw fingertip positions recorded while the user points at the 4 screen corners (the playground's "Calibrate" button does this with holds). Without calibration, the default zone is the central 70 % × 60 % of the camera frame.

## Tuning

All thresholds live in `src/config.ts` (`DEFAULT_CONFIG`) and can be changed live with `interp.setConfig({...})`. The defaults are first guesses. Tune them with real users. For older adults, expect to raise `dwellMs` and `wakeHoldMs` and lower `oneEuroMinCutoff` (more smoothing).

## Files

```
src/events.ts       event + observation types (the contract)
src/config.ts       thresholds
src/interpreter.ts  GestureInterpreter: pose → wake / cursor / hold / loop
src/pose.ts         open palm / pointing classification (MediaPipe label, then landmark rules) + debouncing
src/oneEuro.ts      One Euro filter
src/geometry.ts     loop detection, shoelace area, RDP simplification, bbox
src/calibration.ts  active zone from 4 corners
src/detector.ts     MediaPipe GestureRecognizer wrapper → FrameObservation
playground/         webcam test page (Vite)
test/               vitest suite on synthetic trajectories
```
