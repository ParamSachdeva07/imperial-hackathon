# Pointy overlay — integration notes

The drawing layer from `POINTY_OVERLAY_SPEC.md`. The contract is
`packages/shared/src/overlay/schemas.ts` (ask before changing it).

## Wire it in (controller / platform teammates)

```ts
import { createOverlayControl } from "./overlay/createOverlayControl";
import { exportToolDefinitions } from "@pointy/shared/overlay";

const overlay = createOverlayControl({
  boundsProvider,   // accessibility teammate: BoundsProvider (interfaces.ts)
  captureProvider,  // capture teammate: ScreenCaptureProvider (rectDip is GLOBAL DIP)
  avoidRects,       // e.g. { getAvoidRects: () => [avatarWindow.getBounds()] }
  preloadPath: join(__dirname, "../preload/overlay.js"),
  loadPage: (win) => loadRendererPage(win, "overlay"),
  assetsDir: join(appRoot, "assets/explainers"), // pre-generated explainer images
});

// Tool registration for the voice model:
const tools = exportToolDefinitions();          // or packages/shared/generated/overlay-tools.json
const result = await overlay.control.handleTool(name, args); // → ToolResult for the model
overlay.control.onEvent((e) => forwardToModel(e));            // OverlayEvent stream
```

Controller calls: `onTurnStart(turnId)`, `onContextChange()` (focus change, scroll, window
moved), `onTargetSelected(elementId)` (action or gesture on an element), `clear("all")` on
stop/cancel.

Capture teammate: `getOverlayWindowIds()` returns the overlay windows' **CGWindowIDs** for a
ScreenCaptureKit exclusion filter; `withOverlayHidden(fn)` hides them for the duration of `fn`.

## Behaviour notes

- Max 3 visible annotations (a step set counts as one); a new highlight replaces the previous
  highlight; a new step set replaces the previous one; the oldest non-step annotation is evicted.
  Old ones fade out and emit `overlay.dismissed` with `reason: "replaced" | "evicted"`.
- Default lifetime is `next_turn` for every tool (spec §4). Multi-turn step guides use
  `expires: "on_target_selected"` (the model-facing description says so): for a guide that means
  "when completed" — it survives turns, shows all ✓ briefly when done, then ends. `manual` guides
  stay until `clear`.
- Coordinate targets (`rect`/`point`/`polygon`) always expire on `onContextChange()`.
- Element targets are re-resolved every 300 ms and on `BoundsProvider.onChange`; two misses in a
  row → fade out + `overlay.target_lost` (for steps: only when the *current* step's element is lost).
- Explainer cards appear immediately; concept/compare images and the anatomy crop arrive later
  (`explainer.image_ready` / `explainer.image_failed`). A missing anchor still shows the card
  (centred-right) with `reason: "target_not_found"`.

## Dev tools

- `npm run app` — overlay + fixture window + dev server; `npm run voice` — same plus the GPT
  Realtime test window (`OPENAI_API_KEY` in `.env`).
- `npx pointy-draw …` — CLI for every tool (`npx pointy-draw --help`).
- `npm run broker` — fal.ai image broker (`FAL_KEY` in `.env`); `npm run pregen` — pre-generate
  explainer images into `assets/explainers/`.
- `npm run e2e` — runs every CLI command against the fixture and asserts the results.
- `npm run capture:gallery -w @pointy/desktop` — screenshots of every primitive/card state.
- Env flags: see the header of `apps/desktop/src/main/index.ts`.
