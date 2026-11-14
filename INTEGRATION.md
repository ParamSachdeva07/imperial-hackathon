# Integration record (for humans and agents)

This file says what has been merged into `main` and how, and how the pieces talk to each other. It also covers how to keep re-merging the feature branches as their owners push fixes. **Read this before touching an integration.**

Last updated: 2026-11-14. Integration branches:
- `integration/overlay-anam` (stage 1, merged in PR #2);
- `integration/gestures` (stage 2).

---

## 1. Branch map

| Branch | What it is | Status |
|---|---|---|
| `main` | Integration target. Work lands via PRs. | Has stage 1 (PR #2). Receives `integration/gestures` |
| `feat/overlay-tools` | **Pointy overlay**: the Electron app `apps/desktop`, the tool contract `packages/shared`, the explainer broker `backend/explainer-broker` and the dev CLI `tools/pointy-draw`. | ✅ Merged (stage 1) |
| `feat/anam-overlay` | **Anam avatar**: the standalone Electron app in `anam-overlay/` (React and Vite) plus a FastAPI token broker on :8765. Its single commit sits on top of overlay-tools and adds only `anam-overlay/`. | ✅ Merged (stage 1) |
| `feat/gestures-integration` | `packages/gestures`: camera hand tracking that becomes events, plus an Electron gesture service. Based on overlay-tools@2d3c0b5. It touches only `packages/gestures/`, root `vitest.config.ts` (adds a `gestures` project) and `package-lock.json`. Owner: Alexandre. | ✅ Merged and wired (stage 2, §8) |
| `feat/gestures` | An older, standalone version of the gestures package with unrelated history. | ❌ Superseded by `feat/gestures-integration`; do not merge |
| (later) Jev AI / brain | The controller and model brain. | ⏳ Not started; see §7 |

## 2. What was done in stage 1

Commits on `integration/overlay-anam`, oldest first:
1. `Merge feat/overlay-tools`: `--no-ff`, no conflicts. `main` was empty.
2. `Merge feat/anam-overlay`: `--no-ff`, no conflicts. It adds only `anam-overlay/`.
3. `chore(integration)`:
   - Root `eslint.config.js` ignores `anam-overlay/**`, which has its own toolchain: TypeScript 7, `node --test`, its own lockfile.
   - `apps/desktop/electron.vite.config.ts` pins the Pointy renderer dev server to port **5180**. Anam's Vite is hardcoded to 5173 with `strictPort`, so this keeps them from colliding.
4. `feat(anam-overlay)`: adds a localhost **control server** to the Anam app. See §4.
5. `feat(overlay)`: adds the **`move_avatar` tool and auto-dodge** in Pointy. See §5.

`anam-overlay/` deliberately stays **outside** the npm workspaces (`packages/*`, `apps/*`, `tools/*`, `backend/*`), for three reasons:
- Its tests import SDK internals by relative `node_modules` path.
- Hoisting would break those imports.
- Its TypeScript major version differs from the root's.

Keep it standalone.

## 3. Runtime layout (processes and ports)

| Process | Start | Port / IPC |
|---|---|---|
| Pointy app (`apps/desktop`) | `npm run app` (root); `npm run voice` adds the realtime voice test window | Dev server **47615** (`~/.pointy/dev-server.json`); renderer dev **5180** |
| Explainer broker (fal images) | `npm run broker` | **47620** |
| Anam app (`anam-overlay`) | `cd anam-overlay && npm start` (or `npm run dev`) | Control server **47630**, falling back to an ephemeral port (`~/.pointy/anam-control.json`); Vite dev **5173** |
| Anam token broker (FastAPI) | `cd anam-overlay && backend/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765` | **8765** |

Secrets:
- Root `.env` holds `FAL_KEY` and similar.
- `anam-overlay/backend/.env` holds `ANAM_API_KEY` and `ANAM_PERSONA_ID`.
- Never put the Anam key in the root `.env`. See `anam-overlay/README.md`.

### Run both together
1. Start the Anam backend: the uvicorn command above.
2. Run `cd anam-overlay && npm install && npm run build && npm start`. The avatar dot appears top-right. Hover the corner and click to start a call; the avatar expands.
3. Run `npm install && npm run app` at the root. Pointy finds Anam automatically through `~/.pointy/anam-control.json`. Set `POINTY_AVATAR=anam` to force it.
4. Drive it:
   - `npx pointy-draw move-avatar bottom_left`
   - `npx pointy-draw highlight …` on something under the avatar; the avatar dodges.

## 4. Anam control API (added in `anam-overlay/electron/control.mts`)

Files and setup:
- `control.mts` does not import `electron`.
- `main.mts` has about 17 lines of hooks: an import, `startControlServer({ getState, moveTo })` after `createWindow()`, and `close()` on `before-quit` / `will-quit`.
- A failure to start is logged and does not break the app.

Server:
- Binds `127.0.0.1`. Port is `ANAM_CONTROL_PORT`, default 47630, or an ephemeral port if that one is taken.
- Discovery file: `ANAM_CONTROL_FILE`, default `~/.pointy/anam-control.json`, containing `{port, token, pid}`.
  - The directory is mode 0700 and the file mode 0600, written atomically.
  - It is removed on close, but only if it is still ours.

Every request:
- needs the `x-anam-control-token` header (401 without it);
- needs Host `127.0.0.1:<port>` or `localhost:<port>` (403 otherwise);
- must carry no `Origin` header (403 otherwise).

Bodies are limited to 4 KB.

| Route | Response |
|---|---|
| `GET /state` | `200 {ok:true, state:{expanded, dragging, bounds, workArea, displayId}}` · `503 {ok:false, reason:"no_window"}` |
| `POST /move` `{x,y}` (window top-left, global DIP) | `200 {ok:true, bounds}` (clamped to the work area by `placeWindow`) · `409 collapsed / dragging` · `400 invalid_input` |

The avatar moves **only while expanded** (in a call). The collapsed 56px dot always stays docked top-right, where its hover launcher lives. Collapsing still re-docks it.

## 5. `move_avatar` tool and auto-dodge (Pointy side)

**Contract** (`packages/shared/src/overlay/schemas.ts`, additive change 6):
- Input: `MoveAvatarInput = { position?: "auto"|"top_left"|"top_right"|"bottom_left"|"bottom_right" (default auto), avoid?: Target, displayId?: string, turnId?: string }`.
- New `ToolResult.reason`: `"avatar_unavailable"`. It covers no avatar running, collapsed, being dragged, and a failed move.
- Success returns `{ok:true, visible:true, resolvedBounds: <new avatar bounds>}`.
- The tool is in `MVP_TOOL_NAMES`, so it is exported to the model. The generated JSON in `packages/shared/generated/` is regenerated.

**Code:**
- `AvatarController` port: `packages/shared/src/overlay/interfaces.ts`.
- `apps/desktop/src/main/overlay/avatar/AnamAvatarClient.ts`:
  - polls `GET /state` every 500 ms, with a 1 s request timeout;
  - re-reads the discovery file when a request fails, so it survives an Anam restart;
  - implements both `AvatarController` and `AvoidRectsProvider`, so labels and cards avoid the **real** avatar while it is expanded.
- `apps/desktop/src/main/overlay/avatar/avatarPlacement.ts` is the pure corner chooser. It uses a 24 px inset. `auto` stays put if the current spot is clear, and otherwise picks the corner with the least overlap.
- `OverlayService.ts`:
  - `case "move_avatar"`;
  - **auto-dodge**: after a drawing shows, if its target inflated by 16 px overlaps the movable avatar, the avatar moves to the `auto` corner;
  - auto-dodge is fire-and-forget, serialized, and limited to one dodge per 1.5 s;
  - the tool result is never changed or delayed.
- Wiring: `apps/desktop/src/main/index.ts` always starts `AnamAvatarClient` (unless `POINTY_AVATAR=mock`), so start order doesn't matter.
  - `avoidRects` is `CompositeAvoidRects`: the real avatar's rects while Anam answers, otherwise `MockAvoidRects` (so `POINTY_AVATAR_RECT` and `none` behave as before).
  - `scripts/e2e-cli.ts` pins `POINTY_AVATAR=mock`, so a running Anam can't skew the e2e layout.
- Client robustness:
  - It re-reads the discovery file on network errors **and** 401/403, so it reconnects after an Anam restart on the same port with a new token.
  - It ignores a discovery file whose `pid` is dead.
  - It keeps the last good state for 2 s across failed polls, so rects don't flicker. Definitive answers (collapsed, `no_window`) apply immediately.
  - Start and dispose are idempotent.
- Auto-dodge:
  - It runs on `show()`, on step-guide advance (the `advance_step` tool and target selection), and when a previously unresolved target appears.
  - Each check recomputes overlap from the drawings live **at execution time**.
  - The 1.5 s limit counts only moves that actually happened. A check requested inside the window gets one trailing re-check.
  - `dispose()` cancels pending moves.
- Anam quit removes the discovery file synchronously. A start that resolves after quit is closed. The control server has 5 s request and header timeouts.
- Other surfaces:
  - the `pointy-draw move-avatar [position] [target]` CLI;
  - the realtime instructions;
  - an eval request;
  - docs in `POINTY_OVERLAY_INTEGRATION.md`, the overlay `README.md` and `POINTY_OVERLAY_SPEC.md`.

## 6. Re-syncing when a feature branch gets fixes

Owners keep pushing to their `feat/*` branches. To pull their fixes in:
```bash
git fetch origin
git switch integration/overlay-anam        # or a fresh branch off main once this has landed
git merge --no-ff origin/feat/overlay-tools
git merge --no-ff origin/feat/anam-overlay
npm install && npm run typecheck && npm run lint && npm test
(cd anam-overlay && npm install && npm run build && npm test)
```

Conflict hot spots:
- **`anam-overlay/electron/main.mts`**: only our small hook block, marked by `startControlServer`, `control`, `stopControl`. Keep it when resolving.
  - If the owner renames `placeWindow`, `expanded` or `move`, update `getState` / `moveTo` there.
  - `control.mts` and `tests/control.test.mjs` are integration-owned files; the owner's branch doesn't have them.
- **`packages/shared/src/overlay/schemas.ts` and `tools.ts`**: the contract. If overlay-tools adds tools or reasons, take both sides and rerun `npm run gen:tools`. Never hand-merge `generated/*.json`.
- **`OverlayService.ts`**: the `move_avatar` case and the auto-dodge hook after `show()`.
- **`package-lock.json`**: regenerate it with `npm install` rather than hand-merging.

Better still: ask the owners to merge `main` back into their branches once this PR lands. Then future merges are pure fast-forwards of their own work.

## 7. Known gaps / next steps

- **Gestures (stage 2 open items; see §8.6).** These still need a person to check:
  - packaged-app camera and Accessibility permissions, including `NSCameraUsageDescription`;
  - `electron-vite dev` with the gestures page;
  - the real nut-js mouse;
  - thresholds tuned for older users;
  - multi-display.
  The camera doesn't clash with Anam, because Anam only asks for audio.
- **Jev AI / brain:** not integrated. The controller should use `exportToolDefinitions()` (which now includes `move_avatar`) and `createOverlayControl({ avatar })`. It should also decide whether to keep Pointy's own `POINTY_VOICE` realtime loop or let Anam be the only voice.
- **Flaky upstream test:** `anam-overlay/tests/overlay.test.mjs:120` (`layout.width === layout.height` on the avatar circle) fails about 1 in 5 runs, off by roughly 1e-5 px mid-transition. It reproduces on the untouched `feat/anam-overlay` code, so it is not caused by this integration. Report it to the anam owner; a tolerance compare would fix it.
- **Real home dir in anam's Playwright tests:** they launch the real app, which writes, then removes, `~/.pointy/anam-control.json`. Don't run them while a real Anam session is open, or set `ANAM_CONTROL_FILE` to a temp path.
- **Constants live on both sides:** port 47630, `~/.pointy/anam-control.json` and the `ANAM_CONTROL_*` env names are defined in both `anam-overlay/electron/control.mts` and `AnamAvatarClient.ts`. Change them together.
- **Other limits:**
  - The control API can't start or end a call, or expand or collapse the avatar.
  - No packaging: both apps run unpackaged.
  - macOS only (`apps/desktop` platform layer).
- PR #1 (`feat/overlay-tools` → `main`) is superseded by the integration PR.

## 8. Stage 2: gestures (`feat/gestures-integration`)

### 8.1 What landed (branch `integration/gestures`)
1. `Merge feat/gestures-integration`: `--no-ff`, no conflicts. `packages/gestures` is a workspace package.
2. `chore(integration)`:
   - `npm install` reverted the branch's unrelated lockfile churn.
   - `apps/desktop` now depends on `@pointy/gestures`.
3. `feat(desktop)`: the gesture **service wired into the app** (§8.2).
4. `feat(dev)`: camera-free **simulation**, CLI and docs (§8.4).
5. `Merge` of Alexandre's 6 new commits (his own feedback window, wake ring, fist scroll, latency).
6. Follow-up: the in-overlay feedback layer from the first iteration (`overlay:gesture`, `GestureFeedbackBridge`, `GestureLayer`) was **removed** in favour of his window, per the agreed split (§8.3). The AI overlay is identical to `origin/main`.

Nothing under `packages/gestures/` was modified. Alexandre owns it.

### 8.2 Wiring (opt-in)
**Flags:**
- `POINTY_GESTURES=1`: starts the hidden camera window plus MediaPipe.
- `POINTY_GESTURES_SHOW=1`: shows the vision/debug window.
- `POINTY_GESTURES_MOUSE=1`: the real OS mouse/clicks via nut-js, **only while a session is open**. This needs the macOS Accessibility permission.
- `POINTY_GESTURES_IDLE_MS`: the session idle timeout (default 20000).
- Tunables passed through `startGestureService({ config })` (invalid values are logged and ignored; see `gestureConfig.ts`): `POINTY_GESTURES_ZONE=x0,y0,x1,y1` (camera area mapped to the screen; the app used to ignore it, only the package launcher honoured it), `POINTY_GESTURES_FINGER_EXTEND_RATIO`, `POINTY_GESTURES_POSE_STABLE_MS`, `POINTY_GESTURES_SCROLL_GAIN`, `POINTY_GESTURES_SCROLL_DEADZONE`, `POINTY_GESTURES_DEADBAND`.

**Which gesture needs what (the "one finger does nothing" report):**

| Gesture | What it does | Needs |
|---|---|---|
| Two fingers (index + middle) | drawing / point / region, drawn in the gestures feedback window | `npm run app:gestures` is enough |
| One finger (index) | moves the REAL OS cursor, dwell click | `npm run app:gestures:mouse` (`POINTY_GESTURES_MOUSE=1`), an open session (wake first) and macOS Accessibility for the launching terminal/Electron |
| Closed fist, dragged | real wheel scroll of the window under the pointer | same as one finger (place the pointer with one finger first) |

`npm run app:gestures` keeps the mouse OFF by default (deliberate: it never takes over the user's cursor unasked). The feedback window draws no cursor for one finger, so with the mouse off it looks dead; the app now logs `mouse=OFF ...` at startup and a one-time hint on the first one-finger/fist event. With the flag on and Accessibility missing, startup logs the permission hint (and macOS shows its prompt) because nut-js silently does nothing without it.

**Performing the poses reliably (MacBook camera):** wake with a raised open palm, steady about 1 s. One finger: curl middle, ring and pinky fully, keep the thumb tucked, point the index straight UP (not at the camera), keep the fingertip in the middle band of the image (default zone y 20-65 %, x 15-85 %; move at least 1-2 cm to clear the 8 pt deadband; hold still about 1 s to click, only after moving 40 pt). Fist: close all four fingers tightly, hold 0.2 s, then drag the whole hand several cm. Run with `POINTY_GESTURES_SHOW=1` to see the camera and the log for `mouse start` / `scroll start`; if those lines never appear it is pose classification (Alexandre), if they appear and nothing moves it is permissions.

**One-time setup:** `npm run gestures:assets` copies the MediaPipe wasm and downloads the ~8 MB model into `packages/gestures/.cache/public` (gitignored). Then `npm run app:gestures` builds and runs.

**Code:**
- `apps/desktop/src/main/gestures/startGestures.ts` calls `startGestureService(...)`. It never throws, and returns `null` when the flag is off or on failure.
- **Assets:** a privileged scheme, `pointy-gestures-assets://assets/{mediapipe-wasm,models}/…`.
  - It is registered before ready and handled on the `pointy-gestures` session partition.
  - It is read-only, GET/HEAD, and traversal- and symlink-safe (`assetResolver.ts`).
  - It works from both `file://` (the built app) and the dev server.
  - The Google model URL stays as a fallback.
- The gestures page CSP adds `'wasm-unsafe-eval'` and `blob:` workers for MediaPipe.
- **Session seam:** `DevSessionController.ts`.
  - Open palm opens the session; idle or `close()` ends it.
  - It subscribes right after `startGestureService` resolves (the service never queues events).
  - **The brain replaces this**: subscribe to `service.on("point_selected"|"region_selected"|…)` and call `service.setSessionActive`.
- `MouseGate.ts` attaches and detaches `attachSystemMouse` (move, click and wheel scroll) with the session, so all of it is session-gated; race-safe.

### 8.3 Feedback: the agreed split and his window
**Split** (recorded in `packages/gestures/GESTURES_HANDOFF.md`): gestures draw only what the user is doing with their hand (cursor, trail, rings, wake ring, selection) in **their own** click-through window; the AI overlay (`apps/desktop/src/main/overlay`) draws only what the AI shows. Neither draws the other's content. The overlay code is therefore untouched (identical to `origin/main`).

**Wiring:**
- `startGestures.ts` calls `startGestureFeedback(...)` (via `feedbackHost.ts`) after the session controller is subscribed. A feedback failure is logged and never stops gestures. It is disposed before the service.
- `src/preload/gestureFeedback.ts` imports `@pointy/gestures/electron/feedback-preload`; `src/renderer/gestureFeedback/{index.html,main.ts}` call `startFeedbackRenderer()` (strict CSP, transparent body). Registered in `electron.vite.config.ts` and `rendererPages.ts`.
- **Flag:** `contentProtection` follows `POINTY_CAPTURABLE` (default protected, so the AI never sees the drawings; `POINTY_CAPTURABLE=1` for screenshots).
- `GesturesHandle.feedback` / `.clearSelection()`: the future brain calls it when a turn ends.
- `GesturesHandle.captureHiding` (`getWindowIds()` / `withHidden(fn)`, pure `captureHiding.ts`) is the feedback window's counterpart of `getOverlayWindowIds()` / `withOverlayHidden()`; a capture path that ignores content protection should combine both (`combineCaptureHiding`). The window is also content-protected unless `POINTY_CAPTURABLE=1`. With `POINTY_HIDE_DURING_CAPTURE=1`, main/index.ts wraps the overlay's `captureProvider` (`hideFeedbackDuringCapture`) so every capture also hides all feedback windows (`feedbackCaptureHiding` registry, includes the lazily started simulation window). `POST /gesture` rejects events whose `displayId` is not the gesture display (the feedback window covers one display).

**Simulation drives his window:** `SimGestureService` (pure) implements the `GestureService` subset the feedback window and `DevSessionController` use (`onAny`, `onSession`, `setSessionActive`, `sessionActive`, `display`).
- With `POINTY_GESTURES=1` it **merges** the real service and the simulated events (one adapter, one window); session changes go to the real service. Simulated events never reach the real service, so they never move the real mouse.
- Without it, the feedback window starts **lazily** on the first `/gesture` or `/gesture/session` call (no extra window in normal dev runs or e2e).

### 8.4 Simulate without a camera (dev)
- Dev server: `POST /gesture { events, intervalMs? }` takes real `@pointy/gestures` event shapes, display-relative and validated by `src/dev/gestureSchema.ts`. `POST /gesture/session { active }`.
- CLI:
  - `npx pointy-draw gesture wake 700,450` (wake ring, then `wake_requested`)
  - `npx pointy-draw gesture session on`
  - `npx pointy-draw gesture circle --center 700,450 --radius 150`
  - `gesture dwell X,Y`, `gesture point X,Y`, `gesture lost`
  - `gesture mouse X,Y` (one finger), `gesture click X,Y [--ms]` (dwell click), `gesture scroll [--dy N | --dy -N]` (fist drag, dy>0 scrolls up). These reach the **real OS mouse** only when the app runs with `POINTY_GESTURES_MOUSE=1` AND the session is open (`SimMouseSink.ts`: the sim forwards them to `attachSystemMouse` only under both conditions; otherwise they stay in the feedback window / are dropped). They never go through the real service.
- Verified live on macOS with screenshots (`POINTY_CAPTURABLE=1`): wake ring, cursor, trail, dwell ring and region in his window; the AI overlay draws none of it.

### 8.5 Re-sync hot spots (when Alexandre pushes fixes)
- `git merge --no-ff origin/feat/gestures-integration`, then `npm install` (regenerate the lockfile, don't hand-merge it).
- If `events.ts` changes: `src/dev/gestureSchema.ts` (its compile-time check is bidirectional, so typecheck fails until the schema equals the package union), then `tools/pointy-draw/src/gesture.ts` if a new event needs a CLI generator.
- If the feedback exports change (`startGestureFeedback` options, `feedback-preload`, `feedback-renderer`, or which `GestureService` members it uses): `main/gestures/feedbackHost.ts`, `SimGestureService.ts`, `src/preload/gestureFeedback.ts`, `src/renderer/gestureFeedback/main.ts`.
- If `startGestureService` options, `attachSystemMouse` options or the vision preload/renderer exports change: `startGestures.ts`, `MouseGate.ts`, `src/preload/gestures.ts`, `src/renderer/gestures/main.ts`.
- If `copy-wasm.mjs` or `fetch-model.mjs` output paths change: `assetResolver.ts` and the root `gestures:assets` script.

### 8.6 Verified / not verified
- **Verified on macOS:**
  - `npm run electron:selftest -w @pointy/gestures` reports SELFTEST PASSED, including the real mouse click position and fist scrolling (Accessibility granted to Electron).
  - The built app with `POINTY_GESTURES=1`:
    - the wasm and model load over the custom scheme;
    - vision reaches `running` at about 30–60 fps with hands detected;
    - his feedback window starts with `contentProtection=true`.
  - Sim screenshots: wake ring, trail, region and dwell ring are drawn by **his** window at the right positions, and the AI overlay draws nothing.
  - `npm run e2e`.
- **Verified live (camera-free, macOS):** with `POINTY_GESTURES_MOUSE=1`, `gesture session on` then `gesture mouse 400,300` moved the real cursor to 400,300 and `800,500` to 800,500 (read via CGEventGetLocation); `gesture scroll --dy=-600` scrolled a TextEdit window under the pointer (line 1 to 43 at top); after `session off` `gesture mouse` did not move the cursor; without the flag, the same sim did not move it either.
- **Not verified:**
  - real-hand one-finger/fist (camera) pose rules on a MacBook (see 8.7);
  - `electron-vite dev` with the gesture pages;
  - real-camera use with `POINTY_GESTURES_MOUSE=1`;
  - packaged-app permissions (`NSCameraUsageDescription`, Accessibility);
  - multi-display (v1 maps the primary display only; `/gesture` rejects other display ids);
  - thresholds with older users.

### 8.7 Issues to raise with Alexandre (inside `packages/gestures`; not patched here)
Found by review. The fixes belong in his package, so we did not work around them:
1. **`startGestureFeedback` doesn't replay the session after the feedback page reloads.** `startFeedbackRenderer` resets its `active` flag on load, but main only sends the session state at creation and on changes. After a reload during an open session, nothing draws until the session toggles. In practice this happens only on a dev hot-reload or a renderer crash. Fix: re-send the session state on `did-finish-load`, or add a renderer `ready` handshake as the vision window has.
2. **`startGestureFeedback` leaks on a failed load.** If `loadPage` rejects (for example, the dev server is down), the window and the service/screen listeners stay alive and no disposer is returned. Fix: try/catch with cleanup.
3. **No reduced-motion support in `startFeedbackRenderer`.** Its canvas animations ignore `prefers-reduced-motion`, unlike the AI overlay. Fix: an option or a media-query check.
4. **Mouse-mode feedback is missing.** `feedbackRenderer` draws no cursor for `mouse` events (only the click ring) and nothing for `scroll`, so one-finger / fist look dead whenever the real mouse is not attached (the default). Fix: draw a small cursor dot at `mouse` x/y and a scroll glyph, independent of `attachSystemMouse`; ideally also let the host learn whether a consumer is attached.
5. **One-finger pose has no hysteresis and the recogniser label can veto the rules.** Two-finger has sticky hysteresis; pointing does not. `RECOGNIZER_MAP` sends Thumb_Up / ILoveYou / Victory / Thumb_Down to `other`, which beats the rule result, so a thumb-out point or a slightly parted second finger emits no `mouse`. The 3D wrist-to-tip ratio (1.15) also degrades when the finger points at the camera. Suggested: sticky pointing, prefer the rules over an `other` label when they say pointing/fist, an angle-based curl test.
6. **Expose a debug event** (raw pose, label, score) so a host can render a "why is nothing happening" HUD; and consider scrolling the focused/last-mouse window when the pointer was never moved.
