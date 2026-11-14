# Integration contracts

All task types and events live in packages/contracts/src/index.ts.

## Controller

- start(TaskInput, singleStep) returns an accepted task state immediately.
- subscribe(listener) sends full state changes and timestamped event entries.
- resume(singleStep), cancel(), prepare(), inspect() are explicit operations.
- TextEdit regression succeeds when status is completed and verifiedText is present. General desktop completion has completion.kind="model-assessed", a summary and observed evidence. Do not present this as deterministic proof.
- cancelled does not imply rollback; inspect snapshot for the final observed content.

## Drawing module

Subscribe to events whose type is target. Details currently contain targetRef, bounds and coordinateSpace:"native-screen". Raw bounds come from the macOS accessibility adapter.

Before connecting the drawing renderer, add a geometry normalization layer in main that converts native screen bounds to the target Electron display's DIP space. Include displayId, normalized bounds, taskId and step. The renderer must not independently infer scale or resolve native refs.

The future drawing adapter should expose draw(annotations), clear(taskId) and acknowledge rendered updates. Clear or re-resolve annotations after a new snapshot, scrolling, window changes, cancellation or task end. Drawing does not grant execution authority.

## Avatar

Provider choice is Synthesia, with the planned LiveKit backend integration. The avatar module receives synchronized audio/video tracks, captions and assistant status. It should not create a second voice model or play raw Realtime audio alongside Synthesia output.

Map controller states to idle/listening/thinking/acting/error presentation. Voice, provider media, and avatar rendering are not implemented in this first text-only slice.

## Future voice

Expose a navigate_desktop tool that supplies the same TaskInput. Send short task-start/cancel commands to the desktop over LiveKit RPC. Return task acceptance quickly; send progress and final verified outcome separately. Bulk UI/candidate payloads continue through the HTTPS decision broker.

The voice model can supply exact named text inputs. Jev selects action/target and can resolve the intended text directly from an unquoted instruction. Desktop mode supports `inputs: [{id, text}]`, the optional text field and quoted spans, plus inputFromGoal actions resolved through /navigation/resolve-text. The supervisor supplies generated/interpreted named inputs for the active subgoal. The resolver selects and verifies a source span; it does not generate prose. The voice tool can supply the explicit `inputs: [{id, text}]` map. TaskInput.mode="desktop" selects the general loop; app is an optional starting application.

## Future CV

A local MediaPipe worker emits wake_requested and selection events. The session controller opens voice only after wake. Point/region context will be added to the task contract with display and snapshot identity. CV does not issue native desktop commands directly.

## Implemented supervisor

The Electron UI starts tasks with `supervisorEnabled:true`, `supervisorEvery:12` and `maxSteps:160` by default. These are configurable in settings. The lower-level TaskInput defaults supervisorEnabled to false for compatibility with direct Jev regression fixtures; a future orchestrator should choose the supervision mode explicitly.

`POST /navigation/supervise` accepts the same task ID, current observation ID, original goal, decision step, review reason, current bounded DesktopDecisionRequest, previous guidance and controller issue. It returns validated guidance with server-bound task/observation IDs, active subgoal, plan, memory, named inputs, expectedOutcome/checks, evidence and rationale.

Review reasons: initial, interval, no_progress, uncertain_action, completion, blocked, text_needed, interruption. Review calls are serialized with desktop execution; they never directly mutate the desktop. API errors or malformed/stale guidance stop before another mutation. Previous guidance carries the same session across reviews; do not call start() for each subgoal.

The existing single-step/resume path now permits bounded read-only traversal and pauses after one mutation. A public tool accepting a new subgoal/expected outcome on each resume is not implemented yet. The internal supervisor updates that context without resetting the task or duplicate/uncertainty ledger.

`expectedOutcome.checks` bind observed app/window/role/name descriptors to target_present, text_equals, state_present, state_absent or value_advances. Unknown/ambiguous targets require inspection. Numeric/clock comparisons are read-only. Completion stays explicitly model-assessed for broader semantics.

## Replacing an active instruction

`DesktopApi.replace(input, singleStep)` validates the new task, cancels the old execution, waits for its in-flight work to settle, and starts a fresh task. Only one replacement may be pending. `cancel()` during that wait cancels the pending replacement too. Start/replace responses clear only the submitted UI text, preserving edits made while awaiting the response. Cancellation cannot undo an already-dispatched desktop action.
