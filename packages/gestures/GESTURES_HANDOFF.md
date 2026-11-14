# Pointy: Gesture Layer — Handoff for the Integrating Agent

**Owner:** Alexandre (computer vision / gestures). **Package:** `@pointy/gestures` (`packages/gestures/`).
**Branch:** `feat/gestures-integration`, built on top of `feat/overlay-tools`.
**Status:** done and tested as a module and as an Electron service; **not yet wired into `apps/desktop`**. That is the next step (section 6).

Read this before touching hand tracking, gestures, the camera, or real mouse actions. `README.md` in this package has the user-facing details. This file explains what exists, the contracts, and how to integrate it.

---

## 0. Scope

**This package owns:**
- Camera capture, MediaPipe hand tracking (`@mediapipe/tasks-vision` GestureRecognizer, 2 hands)
- Gesture interpretation: wake, finger cursor, dwell selection, circle → region, mouse mode + dwell click, fist scroll
- An Electron gesture service (hidden vision window + IPC to main)
- **On-screen feedback for the user's own gestures**: wake ring around the raised hand, drawing cursor, trail, hold rings, selected point/region (transparent click-through overlay window)
- Optional real mouse moves/clicks (nut-js)

**This package does NOT own** (other teammates' parts, consumed through events):
- The session controller (turn context, permissions, cancellation), voice / GPT Realtime / LiveKit / Anam, Jev, agent-desktop
- The **AI annotation overlay** (Chris, `apps/desktop/src/main/overlay`): arrows, highlights, step badges, explainer cards drawn by the AI. Agreed split: **gestures draw only what the user is doing with their hand** (cursor, trail, rings, selection), and **the AI overlay draws what the AI shows**. They are two separate click-through windows; neither should draw the other's content.

Plan mapping (Notion plan "Pointy (TBD)"): this covers the **MediaPipe worker** and **Gesture interpreter** components, and build step **3 "Local gestures and coordinates"**.

---

## 1. Gestures (current behaviour)

| User gesture | Events | Notes |
|---|---|---|
| Open palm, raised, fingers up, held **still** 0.7 s | `wake_progress` 0→1 (ring around the hand), then `wake_requested` | Only while the session is **closed**. Edge-triggered (once per raise), re-arms when the palm goes away. A moving hand (scratching, waving) does not wake. Works anywhere in the camera frame. |
| **One finger** (index) | `mouse` start/move/end | Drives the **real system mouse** (if the controller attaches it). |
| One finger, still ~1 s | `click_progress` 0→1, then `click` | **Dwell left click** where the mouse is. Needs ≥40 pt of movement before it can click again. Raising a still finger never clicks. |
| **Two fingers held together** (index + middle) | `cursor_moved`, `dwell_progress`, then `point_selected` or `region_selected` | Drawing/selection cursor. Still ~0.8 s → point. Closed loop then still → region (convex hull polygon + bbox). |
| Closed **fist**, moved | `scroll` start/move/end with `dx`, `dy` | Drag semantics (hand down ⇒ content down ⇒ scroll up). With `attachSystemMouse`, becomes real wheel scrolling of the window under the mouse pointer. |
| Two fingers spread (V) | nothing | Intentionally unused. |
| Drawing hand disappears or changes pose | `hand_lost` | `reason: "absent" \| "pose_changed"`. **Only** emitted for the drawing (two-finger) cursor: it means "the stroke ended without a selection". |

**Session gating:** before `setSessionActive(true)`, only `wake_requested` can be emitted. Cursor, mouse, click, selections and scroll exist only inside a session. Any hand can act once the session is open (one-handed users).

Robustness already handled: One Euro smoothing (tremor), pose debouncing, grace periods when MediaPipe briefly loses a pose (blur), hysteresis so glued fingers with a slightly bent middle finger stay in two-finger mode, position handoff when switching mouse ↔ drawing (no jump), unclamped fist drag that keeps the movement made before the fist was confirmed.

---

## 2. Event contract (`src/events.ts`). Do not change fields without asking Alexandre.

Coordinates are **logical display points (Electron DIP)**, relative to the top-left of the display `displayId` (Electron display id). v1 maps to the **primary display**. `t` = frame time in ms (`performance.now()` of the vision window).

```ts
{ type: "wake_requested", source: "open_palm", hand, heldForMs, t }
{ type: "wake_progress",  hand, progress /*0..1, 0 = hold broken*/, x, y, displayId, t }   // session closed only; x/y = palm on the display
{ type: "cursor_moved",   hand, x, y, displayId, t }
{ type: "dwell_progress", hand, progress /*0..1, 0 = hold broken*/, x, y, displayId, t }
{ type: "point_selected", hand, x, y, displayId, heldForMs, t }
{ type: "region_selected", hand, polygon: [x, y][], bbox: { x, y, width, height }, displayId, t }
{ type: "mouse",          hand, phase: "start" | "move" | "end", x, y, displayId, t }
{ type: "click_progress", hand, progress, x, y, displayId, t }
{ type: "click",          hand, button: "left", x, y, displayId, t }
{ type: "scroll",         hand, phase: "start" | "move" | "end", dx, dy, t }
{ type: "hand_lost",      hand, reason: "absent" | "pose_changed", t }
```

`hand` is MediaPipe's handedness label (`"Left" | "Right"`), used only as a per-hand id.

Suggested mapping to the plan's `TurnContext`: `point_selected` → optional point; `region_selected` → polygon + bbox (crop the screenshot with the bbox). Freeze the selection for the turn, as the plan requires.

---

## 3. Electron API (main process)

```ts
import { startGestureService } from "@pointy/gestures/electron";
import { attachSystemMouse } from "@pointy/gestures/electron/mouse";

const gestures = await startGestureService({
  preloadPath,                 // built from @pointy/gestures/electron/preload (sandboxed preload)
  loadPage: (win) => ...,      // load a page whose script calls startVisionRenderer() (section 6)
  config?: Partial<GestureConfig>,
  showWindow?: boolean,        // debug only
});

gestures.on("wake_requested", (e) => { /* controller: start session, voice, avatar… */ gestures.setSessionActive(true); });
gestures.on("point_selected", (e) => ...);
gestures.on("region_selected", (e) => ...);
gestures.onAny((e) => ...);
gestures.onStatus((s) => ...);         // { type: "starting" | "running" (fps, hands) | "error" (message) }
gestures.setSessionActive(false);      // on stop button / inactivity timeout / closing
gestures.setConfig({ clickDwellMs: 1200 });
gestures.display;                      // { id, width, height, bounds } of the mapped display
gestures.dispose();

const detachMouse = await attachSystemMouse(gestures);  // OPT-IN: "mouse"/"click"/"scroll" events move, click and wheel-scroll the real OS mouse
                                                       // options: { click?: false, scroll?: false, scrollPxPerNotch?: 100, onAction? }

import { startGestureFeedback } from "@pointy/gestures/electron/feedback";
const feedback = await startGestureFeedback(gestures, {
  preloadPath,                 // built from @pointy/gestures/electron/feedback-preload
  loadPage: (win) => ...,      // a page whose script calls startFeedbackRenderer() from @pointy/gestures/electron/feedback-renderer
  contentProtection?: boolean, // default true: excluded from screen captures (the AI never sees it)
});
feedback.clearSelection();     // when the controller ends the turn (selections otherwise fade after 4 s)
```

Feedback window flags mirror the AI overlay's mac platform adapter: transparent, frameless, `focusable: false`, `type: "panel"` on macOS, `setAlwaysOnTop(true, "screen-saver")`, `setIgnoreMouseEvents(true)`, `setContentProtection(true)`, `showInactive()`. It covers the mapped (primary) display and clears itself when the session closes.

What the service already does: hidden `BrowserWindow` with `backgroundThrottling: false`; camera permission granted **only** to that window via its own session partition (`pointy-gestures`), so the app's default session is untouched; macOS camera prompt (`askForMediaAccess`); IPC with sender check + runtime validation of every event; display-change tracking; reload once if the vision page crashes.

**Decision for the controller owner:** the plan says desktop actions start only when the person asks by voice. `mouse`, `click` and `scroll` are **direct manipulation**. `attachSystemMouse` is opt-in for exactly this reason. Decide whether to attach it, attach it only while the session is open, or gate clicks behind confirmation. Scroll units are converted per platform (Windows wheel delta, macOS pixels, Linux notches).

---

## 4. Files

| Path | Role |
|---|---|
| `src/events.ts` | Event contract (above) + `FrameObservation` input type |
| `src/config.ts` | All thresholds (`DEFAULT_CONFIG`), tunable at runtime |
| `src/interpreter.ts` | `GestureInterpreter`: pure, frame-driven, no DOM/MediaPipe. All gesture logic |
| `src/pose.ts` | Pose classification (MediaPipe label + landmark rules), debouncing, two-finger hysteresis |
| `src/geometry.ts`, `src/oneEuro.ts`, `src/calibration.ts`, `src/util.ts` | Loop detection, smoothing, calibration, checked indexing |
| `src/detector.ts` | MediaPipe GestureRecognizer wrapper → `FrameObservation` |
| `src/electron/service.ts` | Main-process service (section 3) |
| `src/electron/preload.ts`, `api.ts` | Sandboxed preload exposing `window.pointyGestures` |
| `src/electron/renderer.ts` | `startVisionRenderer({ wasmPath, modelPath, ... })`: camera → detector → interpreter → IPC. Timer-driven loop (hidden windows don't paint) |
| `src/electron/feedback.ts`, `feedbackPreload.ts`, `feedbackRenderer.ts` | On-screen feedback overlay: main window, preload, drawing |
| `src/electron/mouse.ts`, `coords.ts` | Opt-in real mouse, dwell clicks and wheel scrolling (nut-js); DIP → physical pixels on Windows; per-platform scroll units |
| `src/electron/protocol.ts` | IPC channel names, commands, validation |
| `electron/dev/*` | Standalone launcher (mock controller, debug view, self-test). Dev only, not for the app |
| `playground/` | Browser test page (Vite). Dev only |
| `scripts/` | `copy-wasm.mjs` (MediaPipe wasm → `.cache/public`), `fetch-model.mjs`, `mouse-bridge.mjs` (playground only), `run-selftest.mjs` |

---

## 5. Verification (all green on this branch)

```bash
npm install                                     # at the repo root
npx vitest run --project gestures               # 55 gesture tests (also part of `npm test`)
npm run typecheck && npm run lint               # whole repo
npm run electron:selftest -w @pointy/gestures   # real Electron, hidden window, synthetic hands → interpreter → IPC → mock controller → real mouse, click and scroll + feedback overlay (checks the wake ring and cursor paint); exits 0/1
npm run electron -w @pointy/gestures            # standalone launcher with the real camera (Windows + macOS)
POINTY_GESTURES_SHOW=1 npm run electron -w @pointy/gestures   # + debug window (camera, skeleton, gesture label, mini screen)
```

Verified on Alexandre's Windows laptop (200 % display scaling): wake, mouse, dwell click at the exact position, two-finger point **and region** selection with the window hidden, fist scroll, ~27–30 fps. The on-screen feedback overlay passes the self-test (empty when idle, cursor + ring painted while drawing) but has **not yet been checked by eye on Windows or macOS**. **Not yet verified on macOS** (the app's first platform).

---

## 6. Integrating into `apps/desktop` (next step, not done)

Follow the existing conventions (`electron.vite.config.ts`, `rendererPages.ts`, `src/preload/*`):

1. **electron.vite.config.ts**
   - `main.build.externalizeDeps.exclude`: add `"@pointy/gestures"` (workspace TS source must be bundled, like `@pointy/shared`).
   - Keep `@nut-tree-fork/nut-js` **external** (native addon): `rollupOptions.external: [/^@nut-tree-fork\//]`.
   - `preload` inputs: add `gestures: resolve(__dirname, "src/preload/gestures.ts")` containing just `import "@pointy/gestures/electron/preload";`, and `gestureFeedback: resolve(__dirname, "src/preload/gestureFeedback.ts")` containing `import "@pointy/gestures/electron/feedback-preload";` (keep `isolatedEntries: true`: sandboxed preloads can't load shared chunks).
   - `renderer` inputs: add `gestures: resolve(__dirname, "src/renderer/gestures/index.html")` and `gestureFeedback: resolve(__dirname, "src/renderer/gestureFeedback/index.html")` (script: `startFeedbackRenderer()`).
2. **Renderer page** `src/renderer/gestures/index.html` + script:
   ```ts
   import { startVisionRenderer } from "@pointy/gestures/electron/renderer";
   void startVisionRenderer({ wasmPath: "<url of mediapipe-wasm>", modelPath: "<url of gesture_recognizer.task>", previewParent: document.body });
   ```
   Keep `previewParent` set: the `<video>` must stay in the DOM even when the window is hidden (a detached video in a hidden window degraded tracking in testing).
3. **Assets:** serve MediaPipe's wasm folder (`node_modules/@mediapipe/tasks-vision/wasm`, see `scripts/copy-wasm.mjs`) and `gesture_recognizer.task` (`npm run fetch-model -w @pointy/gestures`) with the page. **(verify)** In packaged builds pages load from `file://`, where `fetch` of the wasm/model may fail. A custom protocol or serving them from main may be needed.
4. **rendererPages.ts:** add `"gestures"` and `"gestureFeedback"` to `RendererPage`.
5. **main/index.ts** (one call, plus the controller wiring):
   ```ts
   const gestures = await startGestureService({
     preloadPath: join(PRELOAD_DIR, "gestures.js"),
     loadPage: (win) => loadRendererPage(win, "gestures"),
   });
   const feedback = await startGestureFeedback(gestures, {
     preloadPath: join(PRELOAD_DIR, "gestureFeedback.js"),
     loadPage: (win) => loadRendererPage(win, "gestureFeedback"),
     contentProtection,          // same flag as the AI overlay (POINTY_CAPTURABLE)
   });
   app.on("before-quit", () => { feedback.dispose(); gestures.dispose(); });
   ```
   Subscribe the controller right after `startGestureService` resolves (the camera is already running), before other slow startup work, so an early wake isn't missed.
6. **macOS packaging:** `NSCameraUsageDescription` in Info.plist. Accessibility permission is needed for nut-js mouse control. Test permissions from the **packaged** app.

Do not reimplement gesture logic in `apps/desktop`: subscribe to events. If behaviour needs tuning, use `setConfig()` or change `DEFAULT_CONFIG`.

---

## 7. Known limitations / open items

- **macOS untested** (developed and tested on Windows). Chris's overlay currently throws on non-macOS, so the full app only runs on Mac. The standalone launcher runs on both.
- Single display (primary) in v1. `displayId` is in every event, so multi-display can be added without changing the contract.
- The camera area mapped to the screen (`activeZone`, default x 15–85 %, y 20–70 % of the image) assumes a laptop webcam above the screen; other setups may need calibration (`computeActiveZone`, playground flow) or `POINTY_GESTURES_ZONE` in the launcher. An onboarding calibration step would help in the app.
- Latency/precision: each camera frame is processed as soon as it arrives (4 ms polling), the cursor uses a One Euro filter plus an 8 DIP deadband with slow easing (`cursorDeadband`), and the launcher logs fps, processing time per frame and the real camera mode. `startVisionRenderer` takes `cameraFps` (default 30) and `numHands` (default 2) to trade latency/CPU.
- Thresholds are tuned for one young user. Expect to raise `dwellMs`, `clickDwellMs` and `wakeHoldMs` after testing with older adults.
- Circle detection could be made more forgiving (`closeFrac`, `minLoopLength`) at the cost of more accidental regions.
- No "end session" gesture: closing is the controller's job (stop button / inactivity timeout).
- Model and wasm are loaded at runtime (see 6.3). The model falls back to Google's URL if the local file is missing (dev only).
