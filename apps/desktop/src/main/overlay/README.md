# Pointy overlay

The drawing layer: pointers, highlights, step guides and explainer
cards drawn over the real desktop. The team contract is `packages/shared/src/overlay/schemas.ts`
(ask before changing it); the interfaces you implement or call are in `interfaces.ts` next to it.

## Wire it in

```ts
import { createOverlayControl, exportToolDefinitions } from "./overlay";

const overlay = createOverlayControl({
  boundsProvider,                 // you: where elements are         (BoundsProvider)
  captureProvider,                // you: screen crops for anatomy    (ScreenCaptureProvider, rect in GLOBAL DIP)
  avoidRects: { getAvoidRects: () => [avatarWindow.getBounds()] },   // optional
});

realtime.registerTools(exportToolDefinitions());   // or packages/shared/generated/overlay-tools.json
realtime.onToolCall((name, args) => overlay.control.handleTool(name, args));  // → ToolResult for the model
overlay.control.onEvent((event) => realtime.tell(event));                    // OverlayEvent stream
// on quit: overlay.dispose()
```

The build already places the overlay page and preload where `createOverlayControl` expects them.

## Calls the controller makes

| When | Call |
| --- | --- |
| a new user turn begins | `onTurnStart(turnId)` |
| focus changed, scrolled, window moved | `onContextChange()` |
| the user clicked / gestured at an element | `onTargetSelected(elementId)` |
| stop / cancel | `handleTool("clear", { overlayId: "all" }, { caller: "controller" })` |
| before taking your own screenshot | `getOverlayWindowIds()` → exclude them in your ScreenCaptureKit filter, or wrap the capture in `withOverlayHidden(fn)` |

## What `ToolResult` tells the model

| `ok` / `visible` | `reason` | Meaning |
| --- | --- | --- |
| true / true | — | Drawn. `overlayId` identifies it; `resolvedBounds` is its target. |
| true / false | `target_not_found`, `target_offscreen`, `display_not_found` | Couldn't see the target; nothing drawn. |
| true / true | same reasons, on `show_explainer` | The card is shown centred-right because its anchor wasn't found. |
| false / false | `invalid_input` | Arguments didn't validate (or a stretch tool that isn't enabled). |
| false / false | `unknown_overlay` | `clear` / `advance_step` with an id that doesn't exist. |
| false / false | `cancelled` | The call was overtaken (cleared, new turn, context change) before it could draw. |
| true / true | none, on `move_avatar` | The voice avatar window was moved (or already clear); `resolvedBounds` is its new bounds. |
| false / false | `avatar_unavailable` | `move_avatar` with no movable avatar (collapsed, being dragged, not running, or no `avatar` option). |

## Avatar (`move_avatar`, auto-dodge)

`createOverlayControl({ avatar })` takes an `AvatarController` (`avatar/AnamAvatarClient.ts` is the
real one; it is also the `AvoidRectsProvider`). `move_avatar` picks a corner via
`avatar/avatarPlacement.ts` and re-lays out live drawings around the avatar's new spot. After any
drawing is shown, if the avatar is within 16 DIP of its target the service runs the same "auto" move in
the background (serialized, at most one per 1.5 s, never affecting the tool result).

## `label_parts` and the `verdict` template

`label_parts` (kind `labelParts` in `annotations.ts`, id prefix `lp`) draws a ring plus a placed label
per item as one `parts` render item: `placeLabel` avoids every ring of the group, the labels already
placed and other drawings. Slots are `part:N`; unresolved items are skipped (`drawable` gate: the call
fails only when none resolve) and losing a part is fine while another remains. It has no replace rule
in `OverlayManager` (unlike `highlight`). The `verdict` explainer template is a text-only card (no
async loading): see `measureCard` for its size and `renderer/overlay/explainer/VerdictTemplate.tsx`.

## Behaviour

- At most 3 annotations are visible (a step guide counts as one). A new highlight replaces the
  previous highlight; a new step guide replaces the previous one; otherwise the oldest goes.
  Leavers fade out and emit `overlay.dismissed` with `reason: "replaced" | "evicted" | "cleared"`.
- Lifetime defaults to `next_turn`. Multi-turn step guides use `expires: "on_target_selected"`
  (the model is told so): for a guide that means "until completed". Coordinate targets
  (`rect` / `point` / `polygon`) always expire on `onContextChange()`.
- Element targets follow their element (polled every 300 ms and on `BoundsProvider.onChange`).
  If the element a drawing depends on is missing twice in a row it fades with
  `overlay.target_lost` (for a step guide: only the *current* step's element counts).
- Step guides show one step at a time: a ring and "Step i of n · label" on the current control and a
  faint hint on the next one; the ring glides on as steps are done; "✓ All done" at the end.
- Explainer cards appear immediately; pictures and anatomy crops arrive later
  (`explainer.image_ready` / `explainer.image_failed`). Cards keep text at full size: they first
  try smaller pictures, then a corner with a connector, before shrinking.

## Gestures

This overlay draws only what the AI shows. What the user does with their hand (cursor, trail, rings,
wake ring, selection) is drawn by the gestures package's own feedback window, started from
`../gestures/`. Neither draws the other's content.

## Developer server

`npm run pointy -- --debug` also starts a localhost developer server (`src/dev/devServer.ts`) for driving and
inspecting the overlay and simulating gestures without a camera.
