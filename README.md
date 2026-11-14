# Desktop Assistant

A macOS Electron application: instruction → configurable LLM supervisor → Jev choice + completion Noul → native desktop action → fresh observation. Chrome, Safari and native applications all use the patched agent-desktop accessibility bridge. Chrome debugging is not part of the application runtime.

## Run

```sh
cd /Users/paramsachdeva/Documents/desktop-assistant
npm run dev
```

The launcher starts Electron, Vite and an authenticated local Python FastAPI broker. Closing Electron stops those services. `Start Navigation Lab.command` runs the same launcher.

Configure `services/decision-api/.env`:

```dotenv
TYPESAFE_API_KEY=your_typesafe_key
TYPESAFE_MODEL=jev-latest
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-6.1-sol
OPENAI_REASONING_EFFORT=low
OPENAI_SERVICE_TIER=ultrafast
SUPERVISOR_PROVIDER=cerebras
CEREBRAS_API_KEY=your_cerebras_key
CEREBRAS_MODEL=gpt-oss-120b
CEREBRAS_REASONING_EFFORT=low
```

Restart after editing this file. `SUPERVISOR_PROVIDER` selects `openai` or `cerebras`; each uses only its own key. Keys remain in the backend and are stripped from Electron and native child environments. The local broker requires a random launcher token.

OpenAI uses Responses with strict structured output. Cerebras uses `https://api.cerebras.ai/v1/chat/completions`, a compatible model and strict JSON schema. A key swap alone is insufficient: endpoint, model, request and response formats differ. Cerebras `gpt-oss-120b` supports low/medium/high reasoning, not off; the selected setting is low. `qwen-3.8-27b` supports `CEREBRAS_REASONING_EFFORT=none`, but our Word tests found planning mistakes with that model. OpenAI's model, reasoning and service tier settings do not leak into Cerebras requests. Unsupported wire-schema constraints are still enforced locally.

Grant Accessibility permission to the application launching the native helper. This text interface does not need microphone, camera or Screen Recording permissions. Regular Chrome and Safari work through their macOS accessibility surfaces; no remote debugging setting, automation profile or debugging connection is requested. Their exposed accessibility capabilities still vary.

For a fresh checkout, use Node 24 (22.12+), Python 3.11+, uv, Rust/Cargo and the macOS command-line developer tools, then `npm ci` and `npm run setup`. Rust and Swift compile the native helpers; packaged users do not need these compilers.

## Use and settings

Enter an instruction and press **Run task** or ⌘ Enter. The **Live log** shows supervisor reviews, Jev choices, execution and verification. **Stop** or ⌘ ⇧ . prevents further actions; already-dispatched input cannot be undone by cancellation.

The input lives in a **380 × 190 px**, always-on-top overlay, with the log collapsed by default. Drag its title to move it; Show log expands the activity view. Sending starts the task and clears the input. You can type while it works: sending another instruction cancels the current run, waits for any dispatched action to settle, then starts the new task from fresh observations. Stop also cancels a pending replacement. Tasks never execute concurrently. ⌘ Enter sends; ⌘ ⇧ . stops; ⌘ ⇧ Space shows the overlay. Completion does not steal keyboard focus.

**Settings and connection** exposes a default **160-decision** budget, configurable from 1 to 500, and supervisor reviews every **12 Jev decisions**, configurable from 1 to 50. A task also has a 20-minute limit. Decisions include read-only tree navigation. Every content-changing action records a fresh result receipt. The next Jev call assesses overall completion alongside its action choice; ordinary mutations no longer force a supervisor review. The interval bounds unsupervised progress. Supervision also runs at the beginning, on uncertain delivery, unavailable text, repeated choices, newly observed blocking dialogs, Jev stopping, and proposed completion. Action confidence scores are diagnostic; there are no action confidence thresholds.

The supervisor returns only status, the next subgoal, compact memory, necessary named inputs, expected checks and evidence IDs. Repeated plan/rationale/description fields are derived locally. Original literal arguments remain available across subgoals, and literal-span resolution uses the original user instruction. It interprets intent and may generate delegated text. Jev chooses from current observed capabilities. No English keyword phase splitter, new-document/new-window equivalence, or deterministic URL rewrite is used. The supervisor cannot execute arbitrary tools, scripts or coordinates.

Native scopes retain as many **complete layers as fit within 255 action choices**, including Stop, completion and parent/root navigation. Layers are added in order; the first layer that exceeds the action budget is excluded in full. All actions on the retained layers travel together, with no partial sibling selection. Nodes without actions do not consume the choice budget, so a view can contain more than 255 nodes. Jev can select any retained actionable descendant directly; selecting a cached boundary repeats the budget there, with parent/root traversal preserved. Local native reads start at depth 3, omit the upstream skeleton clamp for deeper reads, and retain separate resource ceilings of 2,048 nodes and depth 12. If even a root’s immediate action layer cannot fit, it is reported as an observation limit. Legacy/browser inventories retain explicit paging. The broker independently checks the final question size before inference. Shared control metadata, parent IDs and compact result deltas reduce duplicate context.

## Verification and recovery

Actions dispatch once. Stale targets proven not delivered allow bounded refresh and redecision. Ambiguous mutations are recorded, matching primitive/target choices are withheld for the task, and the supervisor reviews fresh app-root/window state. This does not yet reconcile equivalent actions across different primitives; see the critical review in the architecture document. An AXPress error does not prove the action failed or succeeded. Uncertain writes are never blindly replayed.

Already-satisfied text is skipped. Verified-write history only suppresses input when the current field still equals its verified value; a historical write does not permanently prohibit editing a changed field. Typing and accepting an application selection/token remain separate operations.

Jev batches `next_action` (Choice) and `goal_complete` (Noul, estimated P(yes)) in one TypeSafe request. More likely yes (>0.5) preempts any proposed mutation and requests verification; an exact tie requests supervision. More likely no does not gate the selected action. DONE can still report a completed subgoal. An unchanged rejected completion does not cause repeated supervisor calls. The supervisor reconciles action receipts against the original request; completion moves the controller into read-only verification. Current observations and result predicates must still agree. Verification targets are selected by catalog ID and resolved to exact native labels; a failed check requires new evidence before another completion proposal can override inspection. Static supervised outcomes do not require a redundant second Jev judgment; temporal checks still need fresh samples. Typed outcome checks support exact text, target presence, states and advancing measurements. Playback additionally requires the intended media identity and bound active-state/position checks selected from the actual UI, including localized labels. Arbitrary semantic outcomes remain model-assessed; this is not a universal correctness guarantee.

`FOCUS_AND_PASTE` replaces an entire observed editor. It checks app/window ownership, focus, identity, geometry, unchanged full text and complete selection, then pastes once and reads back the result. Clipboard formats are restored unless another process has replaced the clipboard. This tool cannot append, preserve arbitrary rich formatting, or work with editors that do not expose sufficient text/selection information. See [architecture](docs/architecture.md) for its limitations.

Selected UI observations, task text, named inputs and history are sent to TypeSafe for Jev choices and to the selected OpenAI/Cerebras provider for supervisor reviews. Screenshots are not sent. There is no database; task state is in memory. Runtime caches and test artifacts are local under `.runtime` and excluded from Git.

## Code layout

```text
apps/desktop/src/                 Instruction input, settings and live log
apps/desktop/electron/
  main.ts, preload.ts             Window lifecycle and restricted IPC
  controller/
    navigation.ts                Task lifecycle and cancellation
    desktop-loop.ts               Persistent observe/review/choose/execute loop
    supervision.ts                Review scheduling and persistent guidance
    desktop-candidates.ts         Choices derived from observed capabilities
    tree-browser.ts               Lazy traversal and parent/root context
    decision-context.ts           Bounded request context and fingerprints
    completion-verifier.ts        Fresh result checks
    outcome-checks.ts              App-independent result predicates
    resolve-action-text.ts        Named input / literal-span resolution
    write-history.ts              Current-state duplicate prevention
  desktop/                        Native transport, discovery and verification
  services/decision-client.ts     Authenticated broker client
packages/contracts/src/           Validated TypeScript contracts
services/decision-api/app/
  supervisor.py                   Shared structured planning and evidence validation
  supervisor_providers.py         Provider configuration and wire formats
  jev.py                          Batched TypeSafe Choice + Noul
  text_resolution.py              Literal argument fallback
native/                           Pinned Rust patch and Swift paste helper
scripts/, tests/, docs/            Build, verification and integration documentation
```

The old browser adapter source/tests remain isolated for comparison; Electron does not instantiate or route to them and packaging excludes its executable. Old `ASSISTANT_BROWSER_*` settings do not change the application driver. A future non-debugger extension would need a separate implementation. The TextEdit fixture is also isolated from general desktop navigation.

## Test and package

```sh
npm test
npm run build
npm run test:native
node scripts/ui-smoke.mjs
npm run package:mac
```

Use Node 24 for direct script calls. Native smoke tests create unsaved test documents. `npm test` uses mocked model transports; it does not prove live model reliability. Packaged builds are unsigned development apps under `release` and require a separately running authenticated broker. The development launcher starts everything together.

Voice, gestures, avatars, drawing, a browser extension and Windows support remain separate integrations. See [architecture](docs/architecture.md), [integration contracts](docs/integration-contracts.md) and [verification](docs/verification.md). No GitHub remote has been configured.
