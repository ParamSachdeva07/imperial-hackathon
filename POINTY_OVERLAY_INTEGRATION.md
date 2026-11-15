# Integrating the Pointy overlay

This guide is for **the person or AI agent wiring the overlay into the rest of Pointy**: the session
controller, the voice/agent model, the accessibility snapshot, screen capture, and the gesture module.
Read it top to bottom before writing code. Every signature and behaviour here was checked against
the code on `feat/overlay-tools` (PR #1), and the TypeScript blocks compile against it. Lines
marked *pseudo-code* stand in for your own model client.

> **What the overlay is.** A drawing layer. The AI calls tools (`point_at`, `highlight`,
> `show_steps`, `advance_step`, `show_explainer`, `clear`, plus `move_avatar` to shift the voice
> avatar out of the way) and the overlay draws pointers, rings,
> step-by-step guides and explainer cards **over the real macOS desktop**. It uses transparent,
> click-through windows, one per display. It never clicks or types. It only draws, follows the
> elements it points at, and reports back.

---

## 1. Ground rules

| Do | Don't |
| --- | --- |
| Put the controller, the accessibility `BoundsProvider` and the capture provider in **`apps/desktop/src/main/`**, next to `overlay/`. They import `./overlay`. | Import `apps/desktop/src/main/overlay` from another package. It is app code, not a package. |
| Import only from `./overlay` (its `index.ts`) and `@pointy/shared/overlay`. | Reach into `OverlayService`, `LayoutEngine` or other internals. Everything you need is on `OverlayControl`. |
| Treat `packages/shared/src/overlay/schemas.ts` as **the team contract**. | Change `schemas.ts` without asking its owner (ChrisW271). Additive changes only, listed in its header. |
| Create **one** overlay per app, in the Electron **main** process, after `app.whenReady()`, behind `app.requestSingleInstanceLock()`. | Create it in a renderer, or twice. Two overlays stack windows and fight. |
| Use **element targets** (`{ kind: "element", elementId }`) whenever an element id exists. | Send raw coordinates for things that have an accessibility element. Coordinates don't follow windows. |
| Pass the model's arguments through unchanged. The overlay validates them. | Pre-validate or "fix" model arguments. A bad call returns `invalid_input`; let the model see it. |
| Keep API keys in the gitignored root `.env`. The repo is **public**. | Commit keys, put them in `.env.example`, or send them to a renderer. |

Platform: **macOS only** for now (`platform/` has a thin adapter; Windows isn't implemented).

## 2. Read these first, in this order

1. `packages/shared/src/overlay/schemas.ts`: tool inputs, `ToolResult`, `OverlayEvent` (zod).
2. `packages/shared/src/overlay/interfaces.ts`: `BoundsProvider`, `ScreenCaptureProvider`,
   `AvoidRectsProvider`, `OverlayControl`.
3. `apps/desktop/src/main/overlay/index.ts`: the public exports.
4. `apps/desktop/src/main/overlay/createOverlayControl.ts`: the one factory, with all its options.
5. `packages/shared/src/overlay/tools.ts`: model-facing tool descriptions + `exportToolDefinitions()`.
6. **A working reference integration** (dev-only, GPT Realtime):
   - `apps/desktop/src/main/index.ts` + `src/dev/devHarness.ts` compose the overlay with mocks.
   - `src/dev/realtime/voiceWindow.ts`, `realtimeSession.ts` and `src/renderer/voice/realtimeEvents.ts`
     show the main↔renderer bridge, tool registration, the tool-call loop, turn starts and
     per-turn element lists.

## 3. Architecture in one picture

```
 accessibility snapshot ──► BoundsProvider (+ element list for the prompt) ─┐
 screen capture ──────────► ScreenCaptureProvider ──────────────────────────┤
 avatar window bounds ────► AvoidRectsProvider ─────────────────────────────┤
                                                                            ▼
 voice/agent model ──tool calls──► OverlayControl.handleTool ──► overlay windows (1 per display)
        ▲                          onTurnStart / onContextChange / onTargetSelected
        └──── ToolResult + OverlayEvents ◄── OverlayControl.onEvent
 gestures / AX click observer ─► session controller ─► onTargetSelected / polygon targets / clear
```

The **session controller** (your code, in the main process) owns the model session, decides when a
turn starts, and translates OS signals (clicks, focus changes, gestures) into the three lifecycle
calls.

## 4. Coordinates and ids: the #1 source of bugs

- **All overlay coordinates are global DIP (points)**, with the origin at the top-left of the
  **primary** display. This is Electron's `screen` coordinate space. On macOS it is also the space
  of AX `AXPosition`/`AXSize` and `CGWindow` bounds, so accessibility frames pass through unchanged.
  Convert to physical pixels only when cropping screenshots (× `scaleFactor`).
- **`displayId` is a string**: Electron's numeric display id, converted with `String(display.id)`.
- **Coordinate targets** (`rect`, `point`, `polygon`) carry a `displayId`, but their numbers are
  still **global**. The `displayId` must name an existing display (else `display_not_found`).
- **Gesture events (`@pointy/gestures`) are display-relative** (origin = that display's top-left)
  and have a **numeric** `displayId`. Convert them before building a target or hit-testing (§10).
- **Element ids must be stable.** The same on-screen element must keep the same id across
  accessibility snapshots. The overlay re-resolves ids every 300 ms. If ids change on each
  snapshot, every drawing is lost after two misses (`overlay.target_lost`).

## 5. Wiring it in, step by step

### 5.1 Where your code lives, and the build

- **Controller, providers, model client glue:** `apps/desktop/src/main/…`. The desktop build
  (`apps/desktop/electron.vite.config.ts`) already bundles `@pointy/shared`, which ships as
  TypeScript source (its `exports` point at `.ts` files).
- **Another workspace package that only needs the types or schemas** (for example a backend):
  add `"@pointy/shared": "*"` to its `package.json`, run `npm install` at the repo root, and use
  `moduleResolution: "Bundler"` (as `tsconfig.base.json` does). Run it through a bundler or `tsx`;
  plain `node` can't load `.ts`.
- **Overlay page and preload:** the overlay expects `preload/overlay.js` and
  `renderer/overlay/index.html` **next to the main bundle's directory** (`out/main`,
  `out/preload`, `out/renderer`; electron-vite's layout). Under `electron-vite dev` it loads the
  page from `ELECTRON_RENDERER_URL`. If you build into a different layout, copy the `overlay`
  preload and renderer entries from the config (keep `isolatedEntries: true` for the sandboxed
  preload), or pass explicit paths:
  `createOverlayControl({ dev: { renderer: { preloadPath, loadPage } } })`. That is the only
  override, despite the `dev` name.

### 5.2 Implement `BoundsProvider` (accessibility teammate)

```ts
interface BoundsProvider {
  getBounds(elementId: string): Promise<ElementBounds | null>; // { rect: Rect (global DIP), displayId: string }
  onChange(cb: () => void): () => void;                         // fire when the snapshot changes
}
```

Requirements:
- `getBounds` is called **often**: every 300 ms for each element a drawing depends on, and on every
  `onChange`. Answer from your latest snapshot. Never walk the AX tree per call.
- Return `null` when the element is gone or hidden. Return its **current** frame when it moves:
  the overlay follows it. A scrolled-off element should return `null` or a frame off every display.
- Fire `onChange` whenever a new snapshot is taken, so drawings move without waiting for the poll.
- **Display changes:** the overlay rebuilds its own windows and re-lays out drawings when displays
  are added, removed or rearranged, so you don't need to call anything. Your cached frames and
  `displayId`s go stale, though. On `screen` `display-added` / `display-removed` /
  `display-metrics-changed`, take a fresh snapshot and fire `onChange`.

The same snapshot also produces the element list the model sees (§5.3), so every listed id
resolves. A minimal provider that does both (compiles against the real interfaces):

```ts
import { screen } from "electron";
import type { BoundsProvider, ElementBounds } from "./overlay";
import type { Rect } from "@pointy/shared/overlay";

/** One actionable element from your accessibility snapshot. frame = global points (AX gives exactly this). */
interface AxElement { id: string; role: string; label: string; window: string; frame: Rect }

class AxBoundsProvider implements BoundsProvider {
  private elements: AxElement[] = [];
  private byId = new Map<string, ElementBounds>();
  private listeners = new Set<() => void>();

  /** Call with every new snapshot (and after display changes). */
  setSnapshot(elements: AxElement[]): void {
    this.elements = elements;
    this.byId = new Map(
      elements.map((e) => [e.id, { rect: e.frame, displayId: String(screen.getDisplayMatching(e.frame).id) }]),
    );
    for (const cb of this.listeners) cb();
  }
  async getBounds(elementId: string): Promise<ElementBounds | null> {
    return this.byId.get(elementId) ?? null;
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  /** For the model's prompt (§5.3) and for gesture hit-testing (§10). */
  list(): readonly AxElement[] {
    return this.elements;
  }
}
```

`apps/desktop/src/main/overlay/mocks/MockBoundsProvider.ts` is a fuller example.

### 5.3 Tell the model which elements exist

The model can only point at ids it knows. `BoundsProvider` has no list method, because listing is
your snapshot service's job. Give the model the **visible, actionable** elements with **role and
label**; an id alone doesn't tell it which one is "Send". Cap the list at about 150 elements,
frontmost window first:

```ts
function elementList(els: readonly AxElement[]): string {
  return els
    .slice(0, 150)
    .map((e) => `- ${e.id} | ${e.role} "${e.label}" | ${e.window} | (${Math.round(e.frame.x)},${Math.round(e.frame.y)} ${Math.round(e.frame.width)}×${Math.round(e.frame.height)})`)
    .join("\n");
}
```

Refresh it **every user turn**, because windows move and open between turns. With GPT Realtime,
send a `session.update` with new instructions on `input_audio_buffer.speech_started`. With
request/response models, see §6.

### 5.4 Implement `ScreenCaptureProvider` (capture teammate)

> For gesture selections the app uses `DesktopCapturerProvider` (throws instead of returning a placeholder, checks
> Screen Recording permission); see `INTEGRATION.md` §9. `MockScreenCaptureProvider` remains the anatomy-crop mock.

```ts
captureRegion(displayId: string, rectDip: Rect /* GLOBAL DIP */): Promise<Buffer /* PNG, physical px */>
```

Used only for `anatomy` explainer cards (a cropped screenshot with callouts). Convert `rectDip` to
that display's local pixels: `(rect.x - display.bounds.x) * scaleFactor`, and the same for y.
Needs the **Screen Recording** permission. `mocks/MockScreenCaptureProvider.ts` is a
`desktopCapturer` reference.

The crop must **not** contain the overlay. The windows use content protection, which is not yet
verified on real hardware, so also exclude them by id in your ScreenCaptureKit filter. Call
`control.getOverlayWindowIds()` (macOS `CGWindowID`s) **at every capture**; never cache it,
because the overlay recreates its windows when displays change. If crops still show the overlay,
pass `dev: { hideDuringCapture: true }`, which hides the overlay briefly around each anatomy crop.

### 5.5 Create the overlay

```ts
import { join } from "node:path";
import { app } from "electron";
import { createOverlayControl, exportToolDefinitions, readManifestPrompts } from "./overlay";

if (!app.requestSingleInstanceLock()) app.quit(); // one Pointy → one overlay
await app.whenReady();
const assetsDir = join(appRoot, "assets", "explainers"); // pre-generated pictures (optional, §9)
const overlay = createOverlayControl({
  boundsProvider,                                         // §5.2
  captureProvider,                                        // §5.4
  avoidRects: {                                           // keep cards and labels off the avatar
    getAvoidRects: () => (avatarWindow.isDestroyed() || !avatarWindow.isVisible() ? [] : [avatarWindow.getBounds()]),
  },
  assetsDir,
  // brokerUrl: "http://127.0.0.1:47620",                 // must match EXPLAINER_BROKER_PORT (§9)
  // screen: yourScreenSource,                            // share display info (optional)
});
app.on("before-quit", () => overlay.dispose());
const { control } = overlay; // OverlayControl: the only object the controller talks to
```

`getAvoidRects()` is called on every layout, so return **current** bounds. Use it for the avatar,
the caption bar, and anything of yours that cards and labels must not cover.

**The real Anam avatar.** The Anam voice avatar (`anam-overlay/`) is a separate Electron process with
a local control API (discovery file `~/.pointy/anam-control.json`, or `ANAM_CONTROL_FILE`). Pointy
ships a client for it, `AnamAvatarClient` (`overlay/avatar/AnamAvatarClient.ts`), which polls the
avatar's bounds every 500 ms. It is both the `AvoidRectsProvider` (it reports bounds only while the
avatar is expanded, i.e. during a call) and an `AvatarController`:

```ts
const anam = new AnamAvatarClient(); // anam.start() to poll, anam.dispose() on quit
const overlay = createOverlayControl({ boundsProvider, captureProvider, avoidRects: anam, avatar: anam, assetsDir });
```

With `avatar` set, the `move_avatar` tool works and the overlay **auto-dodges**: when a highlight,
pointer, step or card is shown and the avatar is on (or within 16 DIP of) what it points at, the
avatar is moved to the clearest corner. This runs in the background (it never delays or changes the
tool result) and at most once per 1.5 s. The avatar is only movable while expanded and not being
dragged; collapsed, it is a small dot that is left alone. The dev app turns this on with
`POINTY_AVATAR=anam` (or automatically when the discovery file exists). Without an `avatar`,
`move_avatar` returns `avatar_unavailable`.

### 5.6 Give the tools to the model

```ts
const tools = exportToolDefinitions({ pregeneratedImagePrompts: await readManifestPrompts(assetsDir) });
```

This returns `{ type: "function", name, description, parameters }[]`, the **OpenAI Realtime /
Responses** shape. A static copy lives in `packages/shared/generated/overlay-tools.json`
(`npm run gen:tools`). Schemas are normalised for function calling: `anyOf`, never `oneOf`, and
no controller-only fields such as `turnId`. The descriptions already teach usage: step-guide
lifetime, compare sides, element targets. Don't repeat them in your prompt.

| Provider | Convert each definition to |
| --- | --- |
| OpenAI Realtime / Responses | as is |
| OpenAI Chat Completions | `{ type: "function", function: { name, description, parameters } }` |
| Anthropic Claude | `{ name, description, input_schema: parameters }` |
| Gemini | `functionDeclarations: [{ name, description, parameters }]` |

Defaults: MVP tools only. `includeStretch` / `includeControllerTools` add tools that are **not
implemented yet** and return `invalid_input`, so leave both off. `pregeneratedImagePrompts` lists
pictures that are ready instantly; the model is told to reuse those prompts verbatim.

### 5.7 Route tool calls

```ts
import type { ToolResult } from "./overlay";

/** OpenAI gives arguments as a JSON string; Claude (tool_use.input) and Gemini (args) give an object. */
async function runTool(name: string, args: string | object): Promise<ToolResult> {
  let input: unknown;
  try {
    input = typeof args === "string" ? JSON.parse(args) : args;
  } catch {
    return { ok: false, visible: false, reason: "invalid_input" }; // the model sent broken JSON
  }
  return control.handleTool(name, input); // never throws for bad input
}

// One model response → its calls, awaited ONE AT A TIME in the model's order:
for (const call of calls) outputs.push({ id: call.id, output: JSON.stringify(await runTool(call.name, call.args)) });
```

- **Sequential, not `Promise.all`.** The 3-drawing cap and the replace-previous rules depend on
  order.
- `handleTool` **never throws** for bad input; unknown tools and invalid arguments come back as
  `invalid_input`. It resolves when the drawing is placed, usually within milliseconds. Explainer
  pictures arrive later as events.
- **Every call id gets an output**, including `cancelled` ones (the user started a new turn while
  the call was resolving). Send it, but don't treat it as an error or speak about it.
- After all outputs, ask for **one** follow-up response: Realtime `response.create`, or the next
  request for Claude and other request/response models. See `realtimeEvents.ts`.
- Calls you make yourself (not the model) should say so:
  `control.handleTool("clear", { overlayId: "all" }, { caller: "controller" })`. `caller` is
  reported as `by` on `overlay.dismissed`. Use `"user"` for a dismiss the user triggered.
- **Model client in a renderer** (WebRTC Realtime, as in the reference): the overlay stays in main.
  Bridge with `ipcMain.handle` for `tool(name, args)` → `control.handleTool`, `turn(id)` →
  `control.onTurnStart`, and `instructions()` → the current prompt. Check the sender on every
  handler. Mint an **ephemeral** client secret in main, so the API key never reaches the renderer.
  `voiceWindow.ts` + `realtimeSession.ts` do exactly this.

**What the model gets back (`ToolResult`):**

| `ok` / `visible` | `reason` | Meaning, and what the model should do |
| --- | --- | --- |
| true / true | none | Drawn. `overlayId` names it (for `clear` / `advance_step`). `resolvedBounds` is the target. |
| true / false | `target_not_found` / `target_offscreen` / `display_not_found` | Couldn't see the target. Nothing drawn. Say so; don't retry blindly. |
| true / true | same reasons, on `show_explainer` | Card shown centred-right because its anchor wasn't found. |
| true / false | none, on `advance_step` | The guide moved on, but the next step's control isn't on screen yet (it may appear once the previous step is done). The guide stays and waits 2 s, then fades with `overlay.target_lost` if the control never appears. |
| false / false | `invalid_input` | Arguments didn't validate. |
| false / false | `unknown_overlay` | `clear` / `advance_step` with an id that doesn't exist (anymore). |
| false / false | `cancelled` | Overtaken before it drew (clear all, new turn, context change). |
| true / true | none, on `move_avatar` | The avatar was moved (or was already clear). `resolvedBounds` is its new bounds. |
| false / false | `avatar_unavailable` | `move_avatar` with no movable avatar: no call in progress (collapsed), being dragged, or Anam isn't running. Not an error to retry. |

### 5.8 The three lifecycle calls (the controller's job)

| Call | When | Effect |
| --- | --- | --- |
| `onTurnStart(turnId)` | Once per **user** turn: speech started, or a typed message was submitted. Call it **before** the model's tool calls for that turn. A barge-in (the user talks over Pointy) is a new turn. | Drawings with the default lifetime (`next_turn`) from earlier turns fade. Calls still resolving from earlier turns return `cancelled`. |
| `onContextChange()` | The focused app or window changed, a window moved, the page scrolled, or a space or full-screen switch. Debounce scroll (~250 ms). Don't call it on mouse moves. | `context_change` drawings fade, and so does **every drawing that uses a coordinate target** (`rect`/`point`/`polygon`, including an anatomy region or callout given as coordinates). Drawings on element targets survive; they follow their element. |
| `onTargetSelected(elementId)` | The user clicked or activated that element: an AX click observer, or a gesture dwell-click (§10). | Emits `overlay.target_selected` for drawings on it. Drawings with `expires: "on_target_selected"` end. **Step guides advance** when it is the current step's element. |

> ⚠️ Calling `onTurnStart` **after** the model's tool calls wipes the drawings the model just made.
> Calling it on every model response, or several times per user turn (a noisy VAD), also wipes
> them. Debounce speech-start if your VAD fires on noise.

- `turnId` is an opaque label: any unique string. Don't inject it into tool arguments.
- Stop / cancel / "the user wants Pointy gone":
  `handleTool("clear", { overlayId: "all" }, { caller: "controller" })`.

### 5.9 Feed events back to the model

```ts
control.onEvent((e) => { /* OverlayEvent */ });
```

| Event | Meaning | Forward to the model? |
| --- | --- | --- |
| `overlay.shown` | Painted on screen. | No (log it). |
| `overlay.target_lost` | The element a drawing depends on disappeared; the drawing faded. | **Yes**, and prompt a response if the model is idle. |
| `overlay.target_selected` | The user clicked a drawn target. | Optional ("great, now…"). |
| `overlay.dismissed` (`by`, `reason`: replaced / evicted / cleared) | Removed. | Only if `by: "user"`. |
| `overlay.expired` | Lifetime ended. | No. |
| `steps.advanced` (`index`) | The guide moved on (a click, or `advance_step`). | **Yes**, unless the model's own `advance_step` caused it this turn. |
| `steps.completed` | The guide finished. | **Yes**, and prompt a response if the model is idle ("well done"). |
| `explainer.image_ready` / `explainer.image_failed` (`panel`) | A picture arrived, or fell back to its icon. | No. The card handles it. |

Recipe: **queue** forwarded events as short notes (`[screen] The user finished guide st_3.`).
**Flush** the queue as one message before the next model request. If the model is idle and the
queue holds `steps.completed`, `steps.advanced` or `target_lost`, flush it and ask for a response
right away. Never flush in the middle of a tool-call round. With GPT Realtime, a flush is:

```json
{ "type": "conversation.item.create",
  "item": { "type": "message", "role": "system", "content": [{ "type": "input_text", "text": "[screen] The user finished guide st_3." }] } }
```

followed by `{ "type": "response.create" }` only when you want Pointy to speak. For Claude, see §6.

### 5.10 Your own screenshots (vision input for the model)

> Gesture selections already have a ready-made capture path (hiding included): `INTEGRATION.md` §9, seam
> `SelectionStore` in `apps/desktop/src/main/capture/`.

Exclude the overlay so the model never sees its own drawings:
- **Preferred:** `control.getOverlayWindowIds()` **at each capture**, excluded in your
  ScreenCaptureKit `SCContentFilter`.
- **Fallback:** `await control.withOverlayHidden(() => takeScreenshot())`. It fades the overlay
  out and back in (~120 ms each way), so use it sparingly.

## 6. Realtime vs request/response models (Claude and others)

The reference harness is GPT Realtime (speech in, speech out, events over a data channel). With a
request/response model such as **Claude** (Messages API):

- **Turn start:** call `onTurnStart(turnId)` when the user's message is committed (transcript
  final or text submitted), **before** sending the request. Within one user turn, the tool loop
  makes several requests; don't call it again for those.
- **Element list:** put it in the **user message**, for example a text block before the user's
  words, not in the system prompt, so prompt caching of the fixed system prompt keeps working.
- **Tool calls:** run the response's `tool_use` blocks one at a time (§5.7). Return **all**
  `tool_result` blocks in **one** user message directly after the assistant turn (`tool_use_id`,
  `content`: the `JSON.stringify`'d `ToolResult`), then make one follow-up request.
- **Overlay events:** append the queued notes as a text block **after** the `tool_result` blocks
  in that user message, or in front of the next user message. Never between tool results.

## 7. Prompting the model

- Rebuild the element list (§5.3) and the display list every user turn.
- Use `buildInstructions()` in `src/dev/realtime/realtimeSession.ts` as a template for the
  **element list, display list, `visible: false` handling and `clear` rules**. Drop its last
  sentence ("This is a developer test session…") in production.
- Tool usage rules (step-guide lifetime, compare sides, spotlight vs ring, element targets) are
  already in the exported tool descriptions; don't repeat them.
- Rules that worked in live tests: prefer element targets and use only listed ids; spotlight for
  "where is…"; `tone: "warning"` for anything risky; say so on `visible: false`; `clear` with
  `"all"` on "got it", "okay" or a topic change; a picture card only when a picture explains
  better than words.

`npm run eval:voice` runs typed requests through the real model and draws them live. Use it to check
prompt changes.

## 8. Behaviour you can rely on

- **At most 3 drawings** are visible; a step guide counts as one. A new `highlight` replaces the
  previous highlight, and a new `show_steps` replaces the previous guide. Past 3, the **oldest
  drawing that isn't a step guide** is evicted. A guide only goes through a new guide, `clear`,
  its lifetime, or `target_lost`. Leavers fade and emit `overlay.dismissed` with a `reason`.
- **Lifetimes** (`expires`): `next_turn` (default), `on_target_selected`, `context_change`,
  `manual` (until `clear`), or `{ ms }` (500 to 120 000). On a step guide, `on_target_selected`
  means **until completed**. Coordinate targets also end on `onContextChange()`.
- **Following:** element targets track their element (300 ms poll + `onChange`). A drawing fades
  with `target_lost` if its element is missing twice in a row. For a guide, only the **current**
  step's element counts. A later step's element may appear once earlier steps are done; it gets
  2 s after the guide reaches it.
- **Step guides:** one step at a time. A ring and "Step i of n · label" sit on the current
  control, with a faint hint on the next one. The ring glides on as steps are done, then shows
  "✓ All done" and fades.
- **Explainer cards** appear at once. Pictures and anatomy crops arrive later. Cards keep text at
  full size where they can: they first try smaller pictures, then a free corner with a connector,
  and only then shrink.
- Labels and cards are placed off the controls they and the other drawings point at. An older
  label is moved when a new drawing targets what it covers. They keep their side when targets move
  a little. Overlay windows are click-through, never take focus, and sit on all spaces, including
  full-screen apps.
- Reduce-motion (macOS setting) turns movement into fades.

## 9. Explainer pictures (optional)

- `assetsDir` with `manifest.json` holds pre-generated pictures. These are instant and work offline.
- Passing `assetsDir` also enables the **fal.ai broker** for new prompts. It is a localhost Node
  service: run `npm run broker`, with `FAL_KEY` in `.env`. Its port is `EXPLAINER_BROKER_PORT`
  (default 47620); if you change it, pass a matching `brokerUrl`.
- If the broker is down or slower than 8 s, the panel shows its large fallback icon. Nothing breaks.
- `npm run pregen` adds pictures to the manifest ahead of a demo.
- Without `assetsDir` (and without `imageSource`), concept and compare panels show large icons.

## 10. Gestures (`@pointy/gestures`, branch `feat/gestures`)

**Setup.** Merge `feat/gestures` first, so `packages/gestures` is a workspace package, and follow
its README. Detection needs the camera, so it runs in a **renderer** (a hidden window with
`backgroundThrottling: false`). That renderer forwards each `GestureEvent` over IPC to the
main-process controller, which owns the `GestureInterpreter`'s session state
(`setSessionActive`). Construct the interpreter with Electron's display:
`new GestureInterpreter({ id: display.id, width: display.bounds.width, height: display.bounds.height })`.
Its events' `displayId` is then Electron's `display.id`.

Gesture coordinates are **display-relative** with a **numeric** `displayId`. Convert first, and
hit-test only in global DIP:

```ts
import { screen } from "electron";
import type { Target } from "@pointy/shared/overlay";

/** Display-relative gesture point → global DIP; null if the display is gone (drop the event). */
function toGlobal(displayId: number, x: number, y: number): { x: number; y: number } | null {
  const d = screen.getAllDisplays().find((dd) => dd.id === displayId);
  return d ? { x: d.bounds.x + x, y: d.bounds.y + y } : null;
}

function regionTarget(e: { polygon: [number, number][]; displayId: number }): Target | null {
  const points = e.polygon.map(([x, y]) => toGlobal(e.displayId, x, y));
  if (points.some((p) => p === null)) return null;
  return { kind: "polygon", displayId: String(e.displayId), points: points as { x: number; y: number }[] };
}

/** The element under a global point: latest snapshot, smallest containing element (frontmost window first in the list). */
function hitTest(els: readonly AxElement[], p: { x: number; y: number }): AxElement | null {
  const hits = els.filter((e) => p.x >= e.frame.x && p.x < e.frame.x + e.frame.width && p.y >= e.frame.y && p.y < e.frame.y + e.frame.height);
  return hits.sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)[0] ?? null;
}
```

| Gesture event | Controller action |
| --- | --- |
| `wake_requested` | Open the session; `interp.setSessionActive(true)`. |
| `point_selected` | Hit-test, then give the model context only ("the user is pointing at `<id>` (Send button)"). **Never** call `onTargetSelected` here; pointing isn't doing. |
| `region_selected` | Give the model the circled region (`regionTarget(e)`). It can call `show_explainer` with `spec.kind: "anatomy"` and that region. |
| `click` (dwell click) | Hit-test **before** dispatching the OS click (the UI may change after it), dispatch the click, then `onTargetSelected(id)`. This advances step guides. |
| `scroll` (`phase: "end"`) | `onContextChange()`. |
| `wake_progress`, `cursor_moved`, `mouse`, `dwell_progress`, `click_progress`, `hand_lost` | Nothing for the AI overlay: the gestures package draws them in its own feedback window (see below). |
| Session closed (stop/timeout) | `interp.setSessionActive(false)` **and** `handleTool("clear", { overlayId: "all" }, { caller: "controller" })`. |

### Gesture feedback is not the AI overlay's job

Agreed split (`packages/gestures/GESTURES_HANDOFF.md`): **gestures draw only what the user is doing with their
hand** (cursor, trail, hold rings, wake ring, selected point/region) in their own click-through window
(`startGestureFeedback`); **the AI overlay draws only what the AI shows**. Neither draws the other's content, and
the overlay API has no gesture feedback entry points. The desktop app starts that window next to the gesture
service (`apps/desktop/src/main/gestures/startGestures.ts`). `GesturesHandle.clearSelection()` removes the shown
selection when the controller ends a turn.

**Selections as AI input:** the app also captures each gesture selection as two JPEGs (full display marked +
focus close-up). The brain reads them from `SelectionStore` (`latest()` / `consume()` / `onSnapshot`), contract
`@pointy/shared/context/selection`; see `INTEGRATION.md` §9.

Dev env flags (see the header of `apps/desktop/src/main/index.ts`): `POINTY_GESTURES=1` starts the camera
layer (`npm run gestures:assets` once, then `npm run app:gestures`), `POINTY_GESTURES_SHOW=1` shows the
vision window, `POINTY_GESTURES_MOUSE=1` lets gestures drive the real OS mouse (move, click, scroll) while the
session is open, `POINTY_GESTURES_IDLE_MS` sets the session idle timeout, `POINTY_CAPTURABLE=1` makes the
feedback window (and the overlay) visible to screenshots. No camera needed to test the visuals:
`npx pointy-draw gesture wake 700,450`, `gesture session on`, then `gesture circle --center 700,450 --radius 150`,
`gesture dwell 500,300`, `gesture point x,y`, `gesture lost`.

## 11. Testing your integration without a model

- `npm run app` starts the overlay with a fake mail app, mocks and a localhost dev server.
  `npm run voice` adds a GPT Realtime test window (`OPENAI_API_KEY` in `.env`).
- `npx pointy-draw` drives every tool from the terminal (run with no arguments for usage). For
  example, `npx pointy-draw highlight --element fixture.send --label "Send"`. The lifecycle calls
  are commands too: `turn TURN_ID` (`onTurnStart`), `context` (`onContextChange`) and
  `select ELEMENT_ID` (`onTargetSelected`). `events` and `state` show what happened.
- `npm run e2e` runs every CLI command against the fake mail app. `npm run capture:gallery -w
  @pointy/desktop` takes screenshots of every visual state.
- To check your real providers, swap them into `apps/desktop/src/main/index.ts` (the dev
  composition), then use `pointy-draw` against real element ids.

**Integration checklist**
- [ ] A drawing on a real app's button follows it when the window is dragged.
- [ ] `onTurnStart` runs once per user turn, before the model's tool calls (drawings survive their own turn).
- [ ] The model's prompt lists the current elements with role and label, refreshed each turn.
- [ ] Several tool calls in one response run in order, and every call id gets an output.
- [ ] Clicking the current step's control advances the guide (`steps.advanced` reaches the model).
- [ ] Closing the target window gives `overlay.target_lost` within about a second.
- [ ] Your screenshots don't contain the overlay (check both the ScreenCaptureKit filter and an anatomy crop).
- [ ] With two displays: drawings land on the right display, and gesture regions convert to global DIP.
- [ ] Stop button → `clear all` with `caller: "controller"`; nothing is left on screen.
- [ ] `overlay.dispose()` on quit; a second launch doesn't create a second overlay.

## 12. Where to ask / what's not done

- Contract owner: ChrisW271 (`schemas.ts`, the overlay). Spec: `POINTY_OVERLAY_SPEC.md`.
- Not built yet: stretch tools (`magnify`, `preview_action`, `replay_last`), `cue` (speech-synced
  reveal), and Windows.
- Needs checking on a real Mac with permissions: capture exclusion of the overlay, Retina plus
  external display alignment, and full-screen apps.
